import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { traceOrdinal } from '../src/services/indexer.js'

const GENESIS = `${'11'.repeat(32)}_0`
const MIDDLE = `${'22'.repeat(32)}_0`
const CURRENT = `${'33'.repeat(32)}_0`

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** A tiny stand-in for the GorillaPool index: three points on one chain. */
function mockIndexer ({ fail = false } = {}) {
  const txos = {
    [GENESIS]: { outpoint: GENESIS, owner: 'addrGenesis', satoshis: 1, height: 100, idx: '1', spend: MIDDLE.split('_')[0] },
    [MIDDLE]: { outpoint: MIDDLE, owner: 'addrMiddle', satoshis: 1, height: 200, idx: '2', spend: CURRENT.split('_')[0] },
    [CURRENT]: { outpoint: CURRENT, owner: 'addrCurrent', satoshis: 1, height: 300, idx: '3', spend: '' }
  }
  for (const key of Object.keys(txos)) txos[key].origin = { outpoint: GENESIS, num: '100:1:0' }

  globalThis.fetch = async (url) => {
    if (fail) return { ok: false, status: 503 }
    const text = String(url)
    const latest = text.includes('/inscriptions/') && text.endsWith('/latest')
    const outpoint = text.split('/').filter((p) => p.includes('_')).pop()
    if (latest) {
      // Only an origin outpoint resolves to the tip, as the real index behaves.
      const body = outpoint === GENESIS ? txos[CURRENT] : {}
      return { ok: true, status: 200, json: async () => body }
    }
    const body = txos[outpoint]
    if (!body) return { ok: false, status: 404 }
    return { ok: true, status: 200, json: async () => body }
  }
}

test('tracing from the genesis finds the current holder', async () => {
  mockIndexer()
  const t = await traceOrdinal(GENESIS)
  assert.equal(t.role, 'genesis')
  assert.equal(t.genesis.outpoint, GENESIS)
  assert.equal(t.genesis.owner, 'addrGenesis')
  assert.equal(t.current.outpoint, CURRENT)
  assert.equal(t.current.owner, 'addrCurrent')
  assert.equal(t.current.spent, false)
})

test('tracing from the current outpoint finds the genesis', async () => {
  mockIndexer()
  const t = await traceOrdinal(CURRENT)
  assert.equal(t.role, 'current')
  assert.equal(t.genesis.outpoint, GENESIS)
  assert.equal(t.genesis.owner, 'addrGenesis')
  assert.equal(t.current.outpoint, CURRENT)
})

test('tracing from a mid-chain transfer resolves both ends', async () => {
  mockIndexer()
  const t = await traceOrdinal(MIDDLE)
  assert.equal(t.role, 'transfer')
  assert.equal(t.genesis.outpoint, GENESIS)
  assert.equal(t.current.outpoint, CURRENT)
  assert.equal(t.queried.outpoint, MIDDLE)
  assert.equal(t.queried.spent, true)
})

test('an unspent genesis is both ends at once', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      outpoint: GENESIS,
      owner: 'addrGenesis',
      satoshis: 1,
      spend: '',
      origin: { outpoint: GENESIS, num: '100:1:0' }
    })
  })
  const t = await traceOrdinal(GENESIS)
  assert.equal(t.role, 'genesis+current')
  assert.equal(t.current.outpoint, GENESIS)
})

test('an unavailable indexer degrades instead of failing', async () => {
  mockIndexer({ fail: true })
  const t = await traceOrdinal(GENESIS)
  assert.equal(t.unavailable, true)
  assert.equal(t.genesis, null)
  assert.equal(t.current, null)
  assert.ok(t.attempts.length >= 1)
})
