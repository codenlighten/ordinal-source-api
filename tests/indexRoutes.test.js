import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before } from 'node:test'
import bsv from '@smartledger/bsv'
import { orderByDependency } from '../src/indexer/replay.js'
import { applyTransaction } from '../src/indexer/rules.js'
import { MemoryStore, TOKEN } from '../src/indexer/store.js'
import { loadIndex } from '../src/routes/index.js'
import { concatScripts, envelope, p2pkh, startApp } from './helpers.js'

const { Opcode, Script, Transaction } = bsv

const ALICE = Script.fromASM(
  'OP_DUP OP_HASH160 9cc74552f4cbc188358fedb5fa001c8768e303a4 OP_EQUALVERIFY OP_CHECKSIG'
)
const ALICE_ADDR = String(ALICE.toAddress('livenet'))

const build = (inputs, outputs) => {
  const tx = new Transaction()
  for (const [txid, vout] of inputs) {
    tx.uncheckedAddInput(
      new Transaction.Input({
        prevTxId: Buffer.from(txid, 'hex'),
        outputIndex: vout,
        script: Script.empty(),
        sequenceNumber: 0xffffffff
      })
    )
  }
  for (const doc of outputs) {
    tx.addOutput(
      new Transaction.Output({
        script: concatScripts(
          ALICE,
          envelope({
            fields: [[Opcode.OP_1, Buffer.from('application/bsv-20')]],
            body: Buffer.from(JSON.stringify(doc))
          })
        ),
        satoshis: 1
      })
    )
  }
  return tx
}

let app
let file

before(async () => {
  const store = new MemoryStore()
  const deploy = build([['ff'.repeat(32), 0]], [
    { p: 'bsv-20', op: 'deploy+mint', sym: 'ACME', amt: '1000', dec: '2' }
  ])
  const id = `${deploy.hash}_0`
  const send = build([[deploy.hash, 0]], [{ p: 'bsv-20', op: 'transfer', id, amt: '1000' }])

  for (const [idx, tx] of [deploy, send].entries()) {
    const result = applyTransaction(store, tx, { height: 100 + idx, idx, network: 'main' })
    store.apply(result.writes)
  }

  const dir = await mkdtemp(join(tmpdir(), 'index-'))
  file = join(dir, 'index.json')
  await writeFile(file, JSON.stringify(store.toJSON()))

  await loadIndex(file)
  app = await startApp()
  app.fixture = { deploy, send, id }
})

after(async () => {
  await app.close()
  await loadIndex(null)
})

test('an index snapshot survives being written and read back', async () => {
  const store = new MemoryStore()
  const deploy = build([['ff'.repeat(32), 0]], [
    { p: 'bsv-20', op: 'deploy+mint', sym: 'ROUND', amt: '7' }
  ])
  store.apply(applyTransaction(store, deploy, { height: 1, idx: 0 }).writes)

  const restored = MemoryStore.fromJSON(JSON.parse(JSON.stringify(store.toJSON())))
  assert.deepEqual(restored.get(TOKEN, `${deploy.hash}_0`), store.get(TOKEN, `${deploy.hash}_0`))
  assert.equal(restored.stats().tokens, 1)
})

test('a snapshot from another version is refused', () => {
  assert.throws(() => MemoryStore.fromJSON({ version: 99 }), /unsupported index version/)
})

test('replay ordering puts a producer before what spends it', () => {
  const a = build([['ff'.repeat(32), 0]], [{ p: 'bsv-20', op: 'deploy+mint', sym: 'A', amt: '10' }])
  const b = build([[a.hash, 0]], [{ p: 'bsv-20', op: 'transfer', id: `${a.hash}_0`, amt: '10' }])
  const c = build([[b.hash, 0]], [{ p: 'bsv-20', op: 'transfer', id: `${a.hash}_0`, amt: '10' }])

  // Handed over in the wrong order on purpose.
  const ordered = orderByDependency([c, b, a]).map((tx) => tx.hash)
  assert.deepEqual(ordered, [a.hash, b.hash, c.hash])
})

test('GET /v1/index reports what is loaded', async () => {
  const body = await (await app.get('/v1/index')).json()
  assert.equal(body.loaded, true)
  assert.equal(body.tokens, 1)
})

test('a token reports supply and holders from ordered history', async () => {
  const body = await (await app.get(`/v1/index/token/${app.fixture.id}`)).json()
  assert.equal(body.symbol, 'ACME')
  assert.equal(body.supply, '1000')
  assert.equal(body.supplyDecided, true)
  assert.equal(body.holders, 1)
  assert.equal(body.circulating, '1000')
})

test('a ticker can be looked up by name as well as by key', async () => {
  const store = new MemoryStore()
  const deploy = build([['ff'.repeat(32), 0]], [
    { p: 'bsv-20', op: 'deploy', tick: 'TICK', max: '5' }
  ])
  store.apply(applyTransaction(store, deploy, { height: 1, idx: 0 }).writes)
  const dir = await mkdtemp(join(tmpdir(), 'index-'))
  const path = join(dir, 'i.json')
  await writeFile(path, JSON.stringify(store.toJSON()))
  await loadIndex(path)

  const body = await (await app.get('/v1/index/token/tick')).json()
  assert.equal(body.tick, 'TICK')
  await loadIndex(file) // restore the shared fixture
})

test('an address reports its token balances', async () => {
  const body = await (await app.get(`/v1/index/address/${ALICE_ADDR}`)).json()
  assert.equal(body.tokens, 1)
  assert.equal(body.balances[0].symbol, 'ACME')
  assert.equal(body.balances[0].amount, '1000')
})

test('an outpoint reports whether it was spent, from the local index', async () => {
  const spent = await (await app.get(`/v1/index/outpoint/${app.fixture.id}`)).json()
  assert.equal(spent.unspent, false)
  assert.equal(spent.spentIn, app.fixture.send.hash)
  assert.equal(spent.source, 'local-index')

  const live = await (await app.get(`/v1/index/outpoint/${app.fixture.send.hash}_0`)).json()
  assert.equal(live.unspent, true)
  assert.equal(live.amount, '1000')
})

test('an outpoint the index never saw is a 404, not a guess', async () => {
  const res = await app.get(`/v1/index/outpoint/${'ab'.repeat(32)}_0`)
  assert.equal(res.status, 404)
})

test('without an index the endpoints say so rather than pretending', async () => {
  await loadIndex(null)
  const status = await (await app.get('/v1/index')).json()
  assert.equal(status.loaded, false)

  const res = await app.get('/v1/index/tokens')
  assert.equal(res.status, 404)
  assert.match((await res.json()).error.details.hint, /npm run index/)
  await loadIndex(file)
})
