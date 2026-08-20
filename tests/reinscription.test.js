import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import bsv from '@smartledger/bsv'
import { inspectChain, reinscriptionWarning, summarize } from '../src/services/reinscription.js'
import { clearCaches } from '../src/services/txProvider.js'
import { concatScripts, envelope, p2pkh } from './helpers.js'

const { Opcode, Script, Transaction } = bsv
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  clearCaches()
})

const inscribed = (body, contentType = 'image/jpeg') =>
  concatScripts(
    p2pkh(),
    envelope({ fields: [[Opcode.OP_1, Buffer.from(contentType)]], body: Buffer.from(body) })
  )

/**
 * A transaction whose output 0 carries the given script. `nonce` varies the
 * input so two transactions with identical content are still distinct, as they
 * would be on chain.
 */
let nonce = 0
function txWith (script) {
  const tx = new Transaction()
  tx.uncheckedAddInput(
    new Transaction.Input({
      prevTxId: Buffer.alloc(32, 7),
      outputIndex: nonce++,
      script: Script.empty(),
      sequenceNumber: 0xffffffff
    })
  )
  tx.addOutput(new Transaction.Output({ script, satoshis: 1 }))
  return tx
}

/** Serves output scripts the way the single-output provider path would. */
function mockOutputs (txs) {
  const byId = new Map(txs.map((tx) => [tx.hash, tx]))
  globalThis.fetch = async (url) => {
    const text = String(url)
    const txid = (text.match(/[0-9a-f]{64}/) || [])[0]
    const tx = byId.get(txid)
    if (!tx) return { ok: false, status: 404 }

    if (/\/out\/\d+\/hex|\/output\/\d+\/hex/.test(text)) {
      const vout = Number((text.match(/(?:out|output)\/(\d+)/) || [])[1])
      const hex = tx.outputs[vout].script.toHex()
      return {
        ok: true,
        status: 200,
        headers: { get: () => String(hex.length) },
        body: null,
        arrayBuffer: async () => Buffer.from(hex, 'utf8')
      }
    }
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

test('summarize reports what is worth comparing between two points', () => {
  const summary = summarize(inscribed('front'), 'aa_0')
  assert.equal(summary.contentType, 'image/jpeg')
  assert.equal(summary.contentLength, 5)
  assert.match(summary.contentHash, /^[0-9a-f]{64}$/)
  assert.match(summary.contentUrl, /\/content$/)
})

test('an output with no inscription summarises as none', () => {
  assert.equal(summarize(p2pkh(), 'aa_0'), null)
})

test('an ordinal that was never re-inscribed says so', async () => {
  const genesis = txWith(inscribed('front'))
  const moved = txWith(p2pkh()) // a plain transfer carries no inscription
  mockOutputs([genesis, moved])

  const report = await inspectChain(
    { genesis: `${genesis.hash}_0`, current: `${moved.hash}_0` },
    { network: 'main' }
  )
  assert.equal(report.reinscribed, false)
  assert.equal(report.contentDiffers, false)
  assert.equal(report.count, 1)
  assert.equal(reinscriptionWarning(report), null)
})

test('a later inscription with different content is reported, with both kept', async () => {
  const genesis = txWith(inscribed('the front of the card'))
  const again = txWith(inscribed('the back of the card, which is different'))
  mockOutputs([genesis, again])

  const report = await inspectChain(
    { genesis: `${genesis.hash}_0`, current: `${again.hash}_0` },
    { network: 'main' }
  )

  assert.equal(report.reinscribed, true)
  assert.equal(report.contentDiffers, true)
  assert.equal(report.count, 2)
  assert.deepEqual(report.inscriptions.map((i) => i.role), ['genesis', 'current'])
  // Neither is picked as the winner; both are addressable.
  assert.notEqual(report.inscriptions[0].contentHash, report.inscriptions[1].contentHash)
  assert.match(reinscriptionWarning(report), /which one is shown depends/)
})

test('re-inscribing identical content is a re-inscription but not a difference', async () => {
  const genesis = txWith(inscribed('same bytes'))
  const again = txWith(inscribed('same bytes'))
  mockOutputs([genesis, again])

  const report = await inspectChain(
    { genesis: `${genesis.hash}_0`, current: `${again.hash}_0` },
    { network: 'main' }
  )
  assert.equal(report.reinscribed, true)
  assert.equal(report.contentDiffers, false) // nothing ambiguous to warn about
  assert.equal(reinscriptionWarning(report), null)
})

test('without a walk, the gap between the ends is admitted rather than glossed', async () => {
  const genesis = txWith(inscribed('front'))
  const current = txWith(p2pkh())
  mockOutputs([genesis, current])

  const ends = await inspectChain(
    { genesis: `${genesis.hash}_0`, current: `${current.hash}_0` },
    { network: 'main' }
  )
  assert.match(ends.coverage, /ends of the chain only/)

  const middle = txWith(inscribed('a middle re-inscription'))
  mockOutputs([genesis, middle, current])
  const walked = await inspectChain(
    {
      genesis: `${genesis.hash}_0`,
      current: `${current.hash}_0`,
      hops: [`${middle.hash}_0`]
    },
    { network: 'main' }
  )
  assert.match(walked.coverage, /every point/)
  assert.equal(walked.reinscribed, true)
  assert.deepEqual(walked.inscriptions.map((i) => i.role), ['genesis', 'transfer'])
})

test('summaries already in hand are not fetched again', async () => {
  const genesis = txWith(inscribed('front'))
  const again = txWith(inscribed('back'))
  mockOutputs([genesis, again])

  const known = {
    [`${genesis.hash}_0`]: summarize(genesis.outputs[0].script, `${genesis.hash}_0`),
    [`${again.hash}_0`]: summarize(again.outputs[0].script, `${again.hash}_0`)
  }
  const report = await inspectChain(
    { genesis: `${genesis.hash}_0`, current: `${again.hash}_0` },
    { network: 'main', known }
  )
  assert.equal(report.cost.outputsFetched, 0)
  assert.equal(report.reinscribed, true)
})

test('an unreadable point is reported rather than counted as clean', async () => {
  const genesis = txWith(inscribed('front'))
  mockOutputs([genesis]) // the current output is missing

  const report = await inspectChain(
    { genesis: `${genesis.hash}_0`, current: `${'cd'.repeat(32)}_0` },
    { network: 'main' }
  )
  assert.equal(report.errors.length, 1)
  assert.equal(report.count, 1)
})
