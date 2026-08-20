import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import bsv from '@smartledger/bsv'
import { validateTransaction } from '../src/services/tokenValidate.js'
import { clearCaches } from '../src/services/txProvider.js'
import { concatScripts, envelope, p2pkh } from './helpers.js'

const { Opcode, Script, Transaction } = bsv
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  clearCaches()
})

const TOKEN_ID = `${'a1'.repeat(32)}_0`

/** An output script carrying a bsv-20 document. */
const tokenScript = (doc) =>
  concatScripts(
    p2pkh(),
    envelope({
      fields: [[Opcode.OP_1, Buffer.from('application/bsv-20')]],
      body: Buffer.from(JSON.stringify(doc))
    })
  )

/** outputs: a doc (1 sat token output), or a number (plain satoshis). */
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
            script: tokenScript(out.doc),
            satoshis: out.satoshis ?? 1
          })
    )
  }
  return tx
}

function mockChain (txs) {
  const byId = new Map(txs.map((tx) => [tx.hash, tx]))
  globalThis.fetch = async (url) => {
    const txid = (String(url).match(/[0-9a-f]{64}/) || [])[0]
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
}

const transfer = (amt, id = TOKEN_ID) => ({ doc: { p: 'bsv-20', op: 'transfer', id, amt } })
const FUNDING = 'ff'.repeat(32)

test('a deploy needs no inputs to back it and is proven outright', async () => {
  const deploy = build([[FUNDING, 0]], [{ doc: { p: 'bsv-20', op: 'deploy+mint', sym: 'T', amt: '1000' } }, 500])
  mockChain([deploy])

  const result = await validateTransaction(deploy.hash, { network: 'main' })
  assert.equal(result.conserved, true)
  assert.equal(result.proven, true) // supply is defined here, nothing to trace
  assert.equal(result.assuming, null)
  assert.equal(result.tokens[0].createdTotal, '1000')
})

test('a transfer that matches its inputs conserves', async () => {
  const source = build([[FUNDING, 0]], [transfer('1000')])
  const spend = build([[source.hash, 0]], [transfer('600'), transfer('400'), 500])
  mockChain([source, spend])

  const result = await validateTransaction(spend.hash, { network: 'main' })
  assert.equal(result.conserved, true)
  assert.equal(result.tokens[0].inputTotal, '1000')
  assert.equal(result.tokens[0].outputTotal, '1000')
  assert.equal(result.assuming, 'the token inputs are themselves valid')
})

test('a transfer moving more than its inputs carry is rejected', async () => {
  const source = build([[FUNDING, 0]], [transfer('1000')])
  const spend = build([[source.hash, 0]], [transfer('5000'), 500])
  mockChain([source, spend])

  const result = await validateTransaction(spend.hash, { network: 'main' })
  assert.equal(result.conserved, false)
  assert.match(result.tokens[0].errors.join(' '), /outputs move 5000 but inputs only carry 1000/)
})

test('tokens left behind by a transfer are reported as burned', async () => {
  const source = build([[FUNDING, 0]], [transfer('1000')])
  const spend = build([[source.hash, 0]], [transfer('600'), 500])
  mockChain([source, spend])

  const result = await validateTransaction(spend.hash, { network: 'main' })
  assert.equal(result.conserved, true)
  assert.equal(result.tokens[0].burnedSurplus, '400')
  assert.match(result.tokens[0].notes.join(' '), /400 token units .* burned/)
})

test('a burn output consumes balance just as a transfer does', async () => {
  const source = build([[FUNDING, 0]], [transfer('1000')])
  const spend = build([[source.hash, 0]], [
    transfer('400'),
    { doc: { p: 'bsv-20', op: 'burn', id: TOKEN_ID, amt: '600' } },
    500
  ])
  mockChain([source, spend])

  const result = await validateTransaction(spend.hash, { network: 'main' })
  assert.equal(result.tokens[0].outputTotal, '1000')
  assert.equal(result.conserved, true)
})

test('balances of different tokens do not back each other', async () => {
  const other = `${'b2'.repeat(32)}_0`
  const source = build([[FUNDING, 0]], [transfer('1000', other)])
  const spend = build([[source.hash, 0]], [transfer('1000', TOKEN_ID), 500])
  mockChain([source, spend])

  const result = await validateTransaction(spend.hash, { network: 'main' })
  assert.equal(result.conserved, false)
  assert.match(result.tokens[0].errors.join(' '), /no input carries any/)
})

test('a mint needs an auth input, and an auth input carries no balance', async () => {
  const authSource = build([[FUNDING, 0]], [{ doc: { p: 'bsv-20', op: 'auth', id: TOKEN_ID } }])
  const withAuth = build([[authSource.hash, 0]], [
    { doc: { p: 'bsv-20', op: 'mint', id: TOKEN_ID, amt: '50' } },
    500
  ])
  mockChain([authSource, withAuth])

  const minted = await validateTransaction(withAuth.hash, { network: 'main' })
  assert.equal(minted.conserved, true)
  assert.equal(minted.tokens[0].authorityPresent, true)
  assert.equal(minted.tokens[0].inputTotal, '0') // authority, not value

  const plain = build([[FUNDING, 0]], [{ doc: { p: 'bsv-20', op: 'mint', id: TOKEN_ID, amt: '50' } }])
  mockChain([plain])
  const unauthorised = await validateTransaction(plain.hash, { network: 'main' })
  assert.equal(unauthorised.conserved, false)
  assert.match(unauthorised.tokens[0].errors.join(' '), /require an auth input/)
})

test('a token output holding more than one satoshi is rejected', async () => {
  const source = build([[FUNDING, 0]], [transfer('1000')])
  const spend = build([[source.hash, 0]], [{ ...transfer('1000'), satoshis: 5 }])
  mockChain([source, spend])

  const result = await validateTransaction(spend.hash, { network: 'main' })
  assert.equal(result.conserved, false)
  assert.match(result.tokens[0].errors.join(' '), /holds 5 satoshis/)
})

test('BSV-20 tickers are balanced by ticker, case insensitively', async () => {
  const source = build([[FUNDING, 0]], [
    { doc: { p: 'bsv-20', op: 'transfer', tick: 'ORDI', amt: '100' } }
  ])
  const spend = build([[source.hash, 0]], [
    { doc: { p: 'bsv-20', op: 'transfer', tick: 'ordi', amt: '100' } }
  ])
  mockChain([source, spend])

  const result = await validateTransaction(spend.hash, { network: 'main' })
  assert.equal(result.conserved, true)
  assert.equal(result.tokens[0].tick, 'ordi')
  assert.equal(result.tokens[0].tokenId, null)
})

test('walking back to a deploy proves the transfer outright', async () => {
  const deploy = build([[FUNDING, 0]], [{ doc: { p: 'bsv-20', op: 'deploy+mint', sym: 'T', amt: '1000' } }])
  const id = `${deploy.hash}_0`
  const spend = build([[deploy.hash, 0]], [
    { doc: { p: 'bsv-20', op: 'transfer', id, amt: '1000' } },
    500
  ])
  mockChain([deploy, spend])

  const shallow = await validateTransaction(spend.hash, { network: 'main', depth: 1 })
  assert.equal(shallow.proven, false)
  assert.equal(shallow.assuming, 'the token inputs are themselves valid')

  clearCaches()
  mockChain([deploy, spend])
  const deep = await validateTransaction(spend.hash, { network: 'main', depth: 2 })
  assert.equal(deep.proven, true) // every input path reached a deploy
  assert.equal(deep.assuming, null)
  assert.equal(deep.backing[0].proven, true)
})

test('what cannot be decided from one transaction is named, not assumed', async () => {
  const source = build([[FUNDING, 0]], [transfer('1000')])
  const spend = build([[source.hash, 0]], [transfer('1000')])
  mockChain([source, spend])

  const result = await validateTransaction(spend.hash, { network: 'main' })
  assert.deepEqual(result.notChecked, ['ticker-priority', 'supply-limit'])
  assert.ok(result.checked.includes('conservation'))
})

test('a transaction with no token outputs says so rather than failing', async () => {
  const plain = build([[FUNDING, 0]], [500, 400])
  mockChain([plain])
  const result = await validateTransaction(plain.hash, { network: 'main' })
  assert.deepEqual(result.tokens, [])
  assert.match(result.note, /no token outputs/)
})

test('an input that cannot be fetched is reported, not silently ignored', async () => {
  const spend = build([['cc'.repeat(32), 0]], [transfer('1000')])
  mockChain([spend]) // the source transaction is missing

  const result = await validateTransaction(spend.hash, { network: 'main' })
  assert.equal(result.unresolvedInputs.length, 1)
  // Undetermined rather than false: the input was never read, so nothing about
  // what it carried has been established.
  assert.equal(result.conserved, null)
})

test('an input that could not be read makes conservation undetermined, not false', async () => {
  const source = build([[FUNDING, 0]], [transfer('1000')])
  const other = build([[FUNDING, 1]], [transfer('1000')])
  // Two token inputs, but only one of the source transactions is available.
  const spend = build([[source.hash, 0], [other.hash, 0]], [transfer('1500'), 500])
  mockChain([source, spend]) // `other` is missing

  const result = await validateTransaction(spend.hash, { network: 'main' })

  // An unread input can only ADD balance, so a shortfall is not established.
  assert.equal(result.conserved, null)
  assert.equal(result.tokens[0].undetermined, true)
  assert.deepEqual(result.tokens[0].errors, [])
  assert.match(result.tokens[0].notes.join(' '), /could not be read/)
  assert.equal(result.unresolvedInputs.length, 1)
})

test('a shortfall is only reported once every input has been read', async () => {
  const source = build([[FUNDING, 0]], [transfer('1000')])
  const spend = build([[source.hash, 0]], [transfer('5000')])
  mockChain([source, spend]) // every input resolves

  const result = await validateTransaction(spend.hash, { network: 'main' })
  assert.equal(result.conserved, false)
  assert.equal(result.tokens[0].undetermined, undefined)
  assert.match(result.tokens[0].errors.join(' '), /not backed by any input/)
})

test('unread inputs do not cloud a transaction that already balances', async () => {
  const source = build([[FUNDING, 0]], [transfer('1000')])
  const missing = build([[FUNDING, 1]], [transfer('1000')])
  // Outputs are covered by the inputs we did read, so more input cannot change it.
  const spend = build([[source.hash, 0], [missing.hash, 0]], [transfer('900'), 500])
  mockChain([source, spend])

  const result = await validateTransaction(spend.hash, { network: 'main' })
  assert.equal(result.conserved, true)
  assert.equal(result.unresolvedInputs.length, 1)
})
