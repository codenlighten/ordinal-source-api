import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import bsv from '@smartledger/bsv'
import { StaticBlockSource } from '../src/indexer/blockSource.js'
import { Indexer } from '../src/indexer/indexer.js'
import { applyTransaction } from '../src/indexer/rules.js'
import { BALANCE, MemoryStore, SPEND, TOKEN, UTXO, balanceKey } from '../src/indexer/store.js'
import { SqliteStore, sqliteAvailable } from '../src/indexer/sqliteStore.js'
import { concatScripts, envelope } from './helpers.js'

const { Opcode, Script, Transaction } = bsv
const silent = { info () {}, warn () {}, error () {}, debug () {} }

// node:sqlite arrived in Node 22.5; on older runtimes this is a clean skip.
const available = await sqliteAvailable()
const sqliteTest = (name, fn) => test(name, { skip: available ? false : 'node:sqlite unavailable' }, fn)

const ALICE = Script.fromASM(
  'OP_DUP OP_HASH160 9cc74552f4cbc188358fedb5fa001c8768e303a4 OP_EQUALVERIFY OP_CHECKSIG'
)
const ALICE_ADDR = String(ALICE.toAddress('livenet'))

const build = (inputs, docs) => {
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
  for (const doc of docs) {
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

const FUNDING = 'ff'.repeat(32)
const withDb = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'sqlite-'))
  const store = await SqliteStore.open(join(dir, 'index.db'))
  try {
    return await fn(store, join(dir, 'index.db'))
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

sqliteTest('records round-trip through the database', async () => {
  await withDb((store) => {
    store.apply([
      { kind: TOKEN, key: 'tick:acme', value: { tokenKey: 'tick:acme', supply: '10', height: 1 } },
      { kind: UTXO, key: 'aa_0', value: { amount: '10', owner: ALICE_ADDR } },
      { kind: SPEND, key: 'bb_0', value: 'cc'.repeat(32) }
    ])
    assert.equal(store.get(TOKEN, 'tick:acme').supply, '10')
    assert.equal(store.get(UTXO, 'aa_0').amount, '10')
    assert.equal(store.get(SPEND, 'bb_0'), 'cc'.repeat(32))
    assert.equal(store.get(UTXO, 'missing'), null)
  })
})

sqliteTest('balances are queryable by owner and by token', async () => {
  await withDb((store) => {
    // A token key contains an underscore, which is a LIKE wildcard - so these
    // are columns rather than a pattern match on the composite key.
    const tokenKey = `${'a1'.repeat(32)}_0`
    store.apply([
      { kind: BALANCE, key: balanceKey(ALICE_ADDR, tokenKey), value: '400' },
      { kind: BALANCE, key: balanceKey('1OtherOwner', tokenKey), value: '600' },
      { kind: BALANCE, key: balanceKey(ALICE_ADDR, 'tick:acme'), value: '5' }
    ])

    assert.equal(store.balancesOf(ALICE_ADDR).length, 2)
    const holders = store.holdersOf(tokenKey)
    assert.equal(holders.length, 2)
    assert.equal(holders[0].amount, '600') // sorted by size
  })
})

sqliteTest('a zero balance is not reported as a holding', async () => {
  await withDb((store) => {
    store.apply([{ kind: BALANCE, key: balanceKey(ALICE_ADDR, 'tick:acme'), value: '0' }])
    assert.deepEqual(store.balancesOf(ALICE_ADDR), [])
    assert.deepEqual(store.holdersOf('tick:acme'), [])
  })
})

sqliteTest('a block rolls back exactly, restoring prior values', async () => {
  await withDb((store) => {
    const first = store.apply([{ kind: TOKEN, key: 'tick:acme', value: { supply: '10', height: 1 } }])
    store.commitBlock({ height: 1, hash: 'h1', before: first })

    const second = store.apply([{ kind: TOKEN, key: 'tick:acme', value: { supply: '99', height: 1 } }])
    store.commitBlock({ height: 2, hash: 'h2', before: second })
    assert.equal(store.get(TOKEN, 'tick:acme').supply, '99')

    store.rollbackBlock()
    // The earlier value is restored, not deleted.
    assert.equal(store.get(TOKEN, 'tick:acme').supply, '10')
    assert.equal(store.getCursor().height, 1)
  })
})

sqliteTest('the index and its undo window survive a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sqlite-'))
  const path = join(dir, 'index.db')

  const first = await SqliteStore.open(path)
  const before = first.apply([{ kind: TOKEN, key: 'tick:acme', value: { supply: '10', height: 7 } }])
  first.commitBlock({ height: 7, hash: 'h7', before })
  first.close()

  const reopened = await SqliteStore.open(path)
  assert.equal(reopened.get(TOKEN, 'tick:acme').supply, '10')
  assert.equal(reopened.getCursor().height, 7)
  // The reorg window is not reset to nothing by a restart.
  assert.equal(reopened.blockHashAt(7), 'h7')
  assert.equal(reopened.safeHeight(), 7)
  reopened.close()
  await rm(dir, { recursive: true, force: true })
})

sqliteTest('the undo window is trimmed to its depth', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sqlite-'))
  const store = await SqliteStore.open(join(dir, 'index.db'), { undoDepth: 3 })

  for (let height = 1; height <= 6; height++) {
    const before = store.apply([{ kind: TOKEN, key: `t${height}`, value: { height } }])
    store.commitBlock({ height, hash: `h${height}`, before })
  }
  assert.equal(store.stats().undoDepth, 3)
  assert.equal(store.safeHeight(), 4) // heights 1-3 are no longer reversible
  store.close()
  await rm(dir, { recursive: true, force: true })
})

sqliteTest('the same history gives the same result in either store', async () => {
  const deploy = build([[FUNDING, 0]], [{ p: 'bsv-20', op: 'deploy+mint', sym: 'ACME', amt: '1000' }])
  const id = `${deploy.hash}_0`
  const send = build([[deploy.hash, 0]], [
    { p: 'bsv-20', op: 'transfer', id, amt: '250' },
    { p: 'bsv-20', op: 'transfer', id, amt: '750' }
  ])

  const run = async (store) => {
    for (const [idx, tx] of [deploy, send].entries()) {
      const result = applyTransaction(store, tx, { height: 100 + idx, idx, network: 'main' })
      store.apply(result.writes)
    }
    return {
      token: store.get(TOKEN, id),
      balance: store.get(BALANCE, balanceKey(ALICE_ADDR, id)),
      spend: store.get(SPEND, id),
      stats: store.stats()
    }
  }

  const memory = await run(new MemoryStore())
  const sqlite = await withDb((store) => run(store))

  assert.deepEqual(sqlite.token, memory.token)
  assert.equal(sqlite.balance, memory.balance)
  assert.equal(sqlite.spend, memory.spend)
  assert.equal(sqlite.stats.utxos, memory.stats.utxos)
})

test('a reorg deeper than the undo window stops rather than corrupting', async () => {
  const store = new MemoryStore({ undoDepth: 1 })
  const tx = build([[FUNDING, 0]], [{ p: 'bsv-20', op: 'deploy', tick: 'ACME', max: '10' }])

  const source = new StaticBlockSource([
    { height: 1, hash: 'h1', previousHash: null, transactions: [tx] },
    { height: 2, hash: 'h2', previousHash: 'h1', transactions: [] },
    // Claims a parent we never had, and the window only reaches back one block.
    { height: 3, hash: 'h3', previousHash: 'orphaned', transactions: [] }
  ])
  const indexer = new Indexer({ source, store, startHeight: 1, log: silent })

  await indexer.ingestBlock(1)
  await indexer.ingestBlock(2)

  const first = await indexer.ingestBlock(3) // rolls back height 2
  assert.equal(first.reorg, true)

  await assert.rejects(
    () => indexer.ingestBlock(3), // nothing left to undo
    (err) => err.code === 'reorg_beyond_undo_window' && Number.isInteger(err.resyncFrom)
  )
})
