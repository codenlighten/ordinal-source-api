import assert from 'node:assert/strict'
import test from 'node:test'
import bsv from '@smartledger/bsv'
import { StaticBlockSource } from '../src/indexer/blockSource.js'
import { Indexer } from '../src/indexer/indexer.js'
import { applyTransaction } from '../src/indexer/rules.js'
import { BALANCE, MemoryStore, SPEND, TOKEN, UTXO, balanceKey } from '../src/indexer/store.js'
import { concatScripts, envelope, p2pkh } from './helpers.js'

const { Opcode, Script, Transaction } = bsv
const silent = { info () {}, warn () {}, error () {}, debug () {} }

const ALICE = Script.fromASM(
  'OP_DUP OP_HASH160 9cc74552f4cbc188358fedb5fa001c8768e303a4 OP_EQUALVERIFY OP_CHECKSIG'
)
const BOB = Script.fromASM(
  'OP_DUP OP_HASH160 0000000000000000000000000000000000000001 OP_EQUALVERIFY OP_CHECKSIG'
)
const ALICE_ADDR = String(ALICE.toAddress('livenet'))
const BOB_ADDR = String(BOB.toAddress('livenet'))

const tokenScript = (doc, lock = ALICE) =>
  concatScripts(
    lock,
    envelope({
      fields: [[Opcode.OP_1, Buffer.from('application/bsv-20')]],
      body: Buffer.from(JSON.stringify(doc))
    })
  )

/** outputs: {doc, lock?, satoshis?} for a token output, or a number of sats. */
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
  for (const out of outputs) {
    tx.addOutput(
      typeof out === 'number'
        ? new Transaction.Output({ script: p2pkh(), satoshis: out })
        : new Transaction.Output({
            script: tokenScript(out.doc, out.lock ?? ALICE),
            satoshis: out.satoshis ?? 1
          })
    )
  }
  return tx
}

const FUNDING = 'ff'.repeat(32)
const apply = (store, tx, ctx = {}) => {
  const result = applyTransaction(store, tx, { height: 1, idx: 0, network: 'main', ...ctx })
  store.apply(result.writes)
  return result
}

test('a deploy is recorded with its supply and precision', () => {
  const store = new MemoryStore()
  const deploy = build([[FUNDING, 0]], [
    { doc: { p: 'bsv-20', op: 'deploy+mint', sym: 'ACME', amt: '1000', dec: '2' } }
  ])
  const result = apply(store, deploy)

  const record = store.get(TOKEN, `${deploy.hash}_0`)
  assert.equal(record.standard, 'BSV-21')
  assert.equal(record.symbol, 'ACME')
  assert.equal(record.supply, '1000')
  assert.equal(record.decimals, 2)
  assert.equal(result.events[0].accepted, true)
  assert.equal(store.get(UTXO, `${deploy.hash}_0`).amount, '1000')
  assert.equal(store.get(BALANCE, balanceKey(ALICE_ADDR, `${deploy.hash}_0`)), '1000')
})

test('first is first: a second deploy of the same ticker is rejected', () => {
  const store = new MemoryStore()
  const doc = { p: 'bsv-20', op: 'deploy', tick: 'ACME', max: '21000000' }

  const first = build([[FUNDING, 0]], [{ doc }])
  apply(store, first, { height: 100 })

  const second = build([[FUNDING, 1]], [{ doc }])
  const result = apply(store, second, { height: 101 })

  assert.equal(result.events[0].accepted, false)
  assert.match(result.events[0].reason, /already deployed/)
  // The original claim is untouched.
  assert.equal(store.get(TOKEN, 'tick:acme').deployOutpoint, `${first.hash}_0`)
})

test('a mint accumulates supply and is capped by the deploy', () => {
  const store = new MemoryStore()
  const deploy = build([[FUNDING, 0]], [
    { doc: { p: 'bsv-20', op: 'deploy', tick: 'ACME', max: '100', lim: '60' } }
  ])
  apply(store, deploy, { height: 100 })

  const mint = build([[FUNDING, 1]], [{ doc: { p: 'bsv-20', op: 'mint', tick: 'ACME', amt: '60' } }])
  apply(store, mint, { height: 101 })
  assert.equal(store.get(TOKEN, 'tick:acme').supply, '60')

  // Over the per-mint limit.
  const greedy = build([[FUNDING, 2]], [{ doc: { p: 'bsv-20', op: 'mint', tick: 'ACME', amt: '99' } }])
  const rejected = apply(store, greedy, { height: 102 })
  assert.match(rejected.events[0].reason, /per-mint limit/)

  // Crossing the cap is filled to the fraction that fits.
  const last = build([[FUNDING, 3]], [{ doc: { p: 'bsv-20', op: 'mint', tick: 'ACME', amt: '60' } }])
  const partial = apply(store, last, { height: 103 })
  assert.equal(store.get(TOKEN, 'tick:acme').supply, '100')
  assert.equal(store.get(UTXO, `${last.hash}_0`).amount, '40')
  assert.ok(partial.events.some((e) => e.partial))

  // Nothing remains to mint.
  const late = build([[FUNDING, 4]], [{ doc: { p: 'bsv-20', op: 'mint', tick: 'ACME', amt: '1' } }])
  const full = apply(store, late, { height: 104 })
  assert.match(full.events[0].reason, /already fully minted/)
})

test('a mint of an undeployed ticker is rejected', () => {
  const store = new MemoryStore()
  const mint = build([[FUNDING, 0]], [{ doc: { p: 'bsv-20', op: 'mint', tick: 'NOPE', amt: '1' } }])
  const result = apply(store, mint)
  assert.match(result.events[0].reason, /has not been deployed/)
  assert.equal(store.get(UTXO, `${mint.hash}_0`), null)
})

test('a transfer moves balance between owners and records the spend', () => {
  const store = new MemoryStore()
  const deploy = build([[FUNDING, 0]], [
    { doc: { p: 'bsv-20', op: 'deploy+mint', sym: 'ACME', amt: '1000' } }
  ])
  apply(store, deploy, { height: 100 })
  const id = `${deploy.hash}_0`

  const send = build([[deploy.hash, 0]], [
    { doc: { p: 'bsv-20', op: 'transfer', id, amt: '400' }, lock: BOB },
    { doc: { p: 'bsv-20', op: 'transfer', id, amt: '600' }, lock: ALICE }
  ])
  apply(store, send, { height: 101 })

  assert.equal(store.get(BALANCE, balanceKey(BOB_ADDR, id)), '400')
  assert.equal(store.get(BALANCE, balanceKey(ALICE_ADDR, id)), '600')
  // The forward index an API cannot compute for itself.
  assert.equal(store.get(SPEND, id), send.hash)
  assert.equal(store.get(UTXO, id), null)
})

test('a transfer beyond the inputs is rejected output by output', () => {
  const store = new MemoryStore()
  const deploy = build([[FUNDING, 0]], [
    { doc: { p: 'bsv-20', op: 'deploy+mint', sym: 'ACME', amt: '100' } }
  ])
  apply(store, deploy, { height: 100 })
  const id = `${deploy.hash}_0`

  const send = build([[deploy.hash, 0]], [
    { doc: { p: 'bsv-20', op: 'transfer', id, amt: '80' } },
    { doc: { p: 'bsv-20', op: 'transfer', id, amt: '80' } }
  ])
  const result = apply(store, send, { height: 101 })

  assert.equal(result.events.filter((e) => e.accepted).length, 1)
  assert.match(result.events.find((e) => !e.accepted).reason, /exceeds the 20 still carried/)
  assert.equal(store.get(UTXO, `${send.hash}_1`), null)
})

test('an input that was never valid carries nothing', () => {
  const store = new MemoryStore()
  // No deploy, so the "source" output was never written to the store.
  const fake = build([[FUNDING, 0]], [{ doc: { p: 'bsv-20', op: 'transfer', id: `${'a1'.repeat(32)}_0`, amt: '100' } }])
  const result = apply(store, fake)
  assert.equal(result.events[0].accepted, false)
  assert.match(result.events[0].reason, /exceeds the 0/)
})

test('BSV-21 minting needs an auth input', () => {
  const store = new MemoryStore()
  const deploy = build([[FUNDING, 0]], [
    { doc: { p: 'bsv-20', op: 'deploy+auth', sym: 'AUTH' } }
  ])
  apply(store, deploy, { height: 100 })
  const id = `${deploy.hash}_0`

  const unauthorised = build([[FUNDING, 1]], [{ doc: { p: 'bsv-20', op: 'mint', id, amt: '10' } }])
  assert.match(apply(store, unauthorised, { height: 101 }).events[0].reason, /auth input/)

  const authorised = build([[deploy.hash, 0]], [{ doc: { p: 'bsv-20', op: 'mint', id, amt: '10' } }])
  const result = apply(store, authorised, { height: 102 })
  assert.equal(result.events[0].accepted, true)
  assert.equal(store.get(TOKEN, id).supply, '10')
})

test('a block rolls back exactly, restoring prior values', async () => {
  const store = new MemoryStore()
  const deploy = build([[FUNDING, 0]], [
    { doc: { p: 'bsv-20', op: 'deploy+mint', sym: 'ACME', amt: '1000' } }
  ])
  const id = `${deploy.hash}_0`
  const send = build([[deploy.hash, 0]], [
    { doc: { p: 'bsv-20', op: 'transfer', id, amt: '1000' }, lock: BOB }
  ])

  const source = new StaticBlockSource([
    { height: 1, hash: 'h1', previousHash: null, transactions: [deploy] },
    { height: 2, hash: 'h2', previousHash: 'h1', transactions: [send] }
  ])
  const indexer = new Indexer({ source, store, startHeight: 1, log: silent })
  await indexer.run({ once: true, until: 2 })

  assert.equal(store.get(BALANCE, balanceKey(BOB_ADDR, id)), '1000')
  assert.equal(store.get(BALANCE, balanceKey(ALICE_ADDR, id)), '0')
  assert.equal(store.getCursor().height, 2)

  store.rollbackBlock()

  // Back to the state right after the deploy: Alice holds it, Bob does not.
  assert.equal(store.get(BALANCE, balanceKey(ALICE_ADDR, id)), '1000')
  assert.equal(store.get(BALANCE, balanceKey(BOB_ADDR, id)) ?? null, null)
  assert.equal(store.get(UTXO, id).amount, '1000')
  assert.equal(store.get(SPEND, id), null)
  assert.equal(store.getCursor().height, 1)
})

test('ingest walks blocks in order and keeps a cursor', async () => {
  const store = new MemoryStore()
  const deploy = build([[FUNDING, 0]], [
    { doc: { p: 'bsv-20', op: 'deploy', tick: 'ACME', max: '1000' } }
  ])
  const mint = build([[FUNDING, 1]], [{ doc: { p: 'bsv-20', op: 'mint', tick: 'ACME', amt: '250' } }])

  const source = new StaticBlockSource([
    { height: 10, hash: 'a', previousHash: null, transactions: [deploy] },
    { height: 11, hash: 'b', previousHash: 'a', transactions: [mint] },
    { height: 12, hash: 'c', previousHash: 'b', transactions: [] }
  ])
  const indexer = new Indexer({ source, store, startHeight: 10, log: silent })
  const stats = await indexer.run({ once: true, until: 12 })

  assert.equal(stats.cursor.height, 12)
  assert.equal(store.get(TOKEN, 'tick:acme').supply, '250')
  assert.equal(indexer.height, 12)
})

test('a block that does not build on the tip triggers a rollback', async () => {
  const store = new MemoryStore()
  const tx = build([[FUNDING, 0]], [
    { doc: { p: 'bsv-20', op: 'deploy', tick: 'ACME', max: '1000' } }
  ])
  const source = new StaticBlockSource([
    { height: 1, hash: 'h1', previousHash: null, transactions: [tx] },
    // Height 2 claims a parent we never saw: the chain moved under us.
    { height: 2, hash: 'h2', previousHash: 'different', transactions: [] }
  ])
  const indexer = new Indexer({ source, store, startHeight: 1, log: silent })

  await indexer.ingestBlock(1)
  const result = await indexer.ingestBlock(2)

  assert.equal(result.reorg, true)
  assert.equal(result.rolledBack, 1)
  assert.equal(store.get(TOKEN, 'tick:acme'), null) // the deploy was undone
})

test('balances and holders can be read back', () => {
  const store = new MemoryStore()
  const deploy = build([[FUNDING, 0]], [
    { doc: { p: 'bsv-20', op: 'deploy+mint', sym: 'ACME', amt: '1000' } }
  ])
  apply(store, deploy, { height: 100 })
  const id = `${deploy.hash}_0`
  const send = build([[deploy.hash, 0]], [
    { doc: { p: 'bsv-20', op: 'transfer', id, amt: '250' }, lock: BOB },
    { doc: { p: 'bsv-20', op: 'transfer', id, amt: '750' }, lock: ALICE }
  ])
  apply(store, send, { height: 101 })

  assert.deepEqual(store.balancesOf(BOB_ADDR), [{ tokenKey: id, amount: '250' }])
  const holders = store.holdersOf(id)
  assert.equal(holders.length, 2)
  assert.equal(holders[0].amount, '750') // sorted by size
})
