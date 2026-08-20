import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import bsv from '@smartledger/bsv'
import { verifyOrdinal } from '../src/services/verify.js'
import { clearCaches } from '../src/services/txProvider.js'

const { Script, Transaction } = bsv
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  clearCaches()
})

const anyone = () => Script.fromASM('OP_TRUE')

/** Builds a real, serializable transaction from outpoints and output values. */
function build (inputs, outputs) {
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
  for (const satoshis of outputs) {
    tx.addOutput(new Transaction.Output({ script: anyone(), satoshis }))
  }
  return tx
}

/**
 * Serves a set of transactions and spend answers over a mocked fetch, so a
 * whole transfer chain can be walked without touching the network.
 */
function mockChain (txs, spends = {}) {
  const byId = new Map(txs.map((tx) => [tx.hash, tx]))
  const state = { txCalls: 0, spendCalls: 0 }

  globalThis.fetch = async (url) => {
    const text = String(url)
    const txid = (text.match(/[0-9a-f]{64}/) || [])[0]

    if (text.includes('/spent')) {
      state.spendCalls++
      const vout = (text.match(/\/([0-9]+)\/spent/) || [])[1]
      const spend = spends[`${txid}_${vout}`]
      if (!spend) return { ok: false, status: 404 }
      return { ok: true, status: 200, json: async () => ({ txid: spend, vin: 0, status: 'confirmed' }) }
    }
    if (text.includes('/txos/')) return { ok: false, status: 404 }

    state.txCalls++
    const tx = byId.get(txid)
    if (!tx) return { ok: false, status: 404 }
    const bytes = tx.toBuffer()
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(bytes.length) },
      body: null,
      arrayBuffer: async () => bytes
    }
  }
  return state
}

/** funding output of `value` sats, then a genesis spending it into `outputs`. */
function genesisOf (outputs, value = 5000) {
  const funder = build([['bb'.repeat(32), 0]], [value])
  const genesis = build([[funder.hash, 0]], outputs)
  return { funder, genesis }
}

test('an origin is computed with no index involved at all', async () => {
  // funding (5000 sats) -> genesis, which puts 1 sat in output 0
  const { funder, genesis } = genesisOf([1, 4000])
  const chain = mockChain([genesis, funder])

  const result = await verifyOrdinal(`${genesis.hash}_0`, { network: 'main' })
  assert.equal(result.origin, `${genesis.hash}_0`)
  assert.equal(result.proven.origin, true)
  assert.equal(chain.spendCalls, 1) // only the forward walk asked an index
  assert.equal(result.hops.backward[0].parentSatoshis, 5000)
})

test('a transfer chain is walked forward and each hop checked against bytes', async () => {
  const { funder, genesis } = genesisOf([1, 4000])
  const transfer = build([[genesis.hash, 0], [genesis.hash, 1]], [1, 3000])
  const tip = build([[transfer.hash, 0], [transfer.hash, 1]], [1, 2000])

  mockChain([genesis, funder, transfer, tip], {
    [`${genesis.hash}_0`]: transfer.hash,
    [`${transfer.hash}_0`]: tip.hash
  })

  const result = await verifyOrdinal(`${genesis.hash}_0`, { network: 'main' })
  assert.equal(result.current, `${tip.hash}_0`)
  assert.equal(result.hops.forward.length, 2)
  assert.equal(result.proven.transfers, true)
  assert.equal(result.tipUnrefuted, true) // unspent is unrefuted, never proven
  assert.equal(result.proven.stillUnspent, false)
})

test('an ordinal behind a funding input is followed to the right output', async () => {
  const { funder, genesis } = genesisOf([1, 4000])
  // Funding first this time, so the ordinal sits at offset 600 and must land
  // on output 1, which is exactly where the 1 satoshi output starts.
  const feeder = build([['cc'.repeat(32), 0]], [600])
  const transfer = build([[feeder.hash, 0], [genesis.hash, 0]], [600, 1])

  mockChain([genesis, funder, feeder, transfer], { [`${genesis.hash}_0`]: transfer.hash })

  const result = await verifyOrdinal(`${genesis.hash}_0`, { network: 'main' })
  assert.equal(result.current, `${transfer.hash}_1`)
  assert.equal(result.hops.forward[0].satoshiOffset, 600)
})

test('an ordinal merged into a larger output is reported as burned', async () => {
  const { funder, genesis } = genesisOf([1, 4000])
  const merge = build([[genesis.hash, 0], [genesis.hash, 1]], [3500])

  mockChain([genesis, funder, merge], { [`${genesis.hash}_0`]: merge.hash })

  const result = await verifyOrdinal(`${genesis.hash}_0`, { network: 'main' })
  assert.equal(result.current, null)
  assert.match(result.burned, /merged into a 3500 satoshi output/)
})

test('an ordinal paid to the miner is reported as burned to fee', async () => {
  const { funder, genesis } = genesisOf([1, 4000])
  // The ordinal is spent behind 500 satoshis of funding, so it sits at offset
  // 500 - but only 400 satoshis are paid out, so it falls past every output
  // and into the miner's fee.
  const feeder = build([['cc'.repeat(32), 0]], [500])
  const burn = build([[feeder.hash, 0], [genesis.hash, 0]], [400])

  mockChain([genesis, funder, feeder, burn], { [`${genesis.hash}_0`]: burn.hash })

  const result = await verifyOrdinal(`${genesis.hash}_0`, { network: 'main' })
  assert.equal(result.burned, 'paid to fee')
})

test('an indexer claiming a spend that is not there is contradicted', async () => {
  const { funder, genesis } = genesisOf([1, 4000])
  const unrelated = build([['dd'.repeat(32), 0]], [1])

  mockChain([genesis, funder, unrelated], { [`${genesis.hash}_0`]: unrelated.hash })

  const result = await verifyOrdinal(`${genesis.hash}_0`, { network: 'main' })
  assert.equal(result.contradicted, true)
  assert.equal(result.current, null)
  assert.match(result.warnings.join(' '), /but it does not/)
})

test('a mismatch with the indexer is reported rather than hidden', async () => {
  const { funder, genesis } = genesisOf([1, 4000])
  mockChain([genesis, funder])

  const claim = { genesis: { outpoint: `${'99'.repeat(32)}_0` }, current: null }
  const result = await verifyOrdinal(`${genesis.hash}_0`, { network: 'main', claim })
  assert.equal(result.agreement.origin, 'mismatch')
  assert.equal(result.origin, `${genesis.hash}_0`)
})

test('an output that is not a single satoshi is not an ordinal', async () => {
  const { funder, genesis } = genesisOf([42])
  mockChain([genesis, funder])

  const result = await verifyOrdinal(`${genesis.hash}_0`, { network: 'main' })
  assert.equal(result.origin, null)
  assert.match(result.warnings.join(' '), /42 satoshis/)
})
