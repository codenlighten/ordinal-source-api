import assert from 'node:assert/strict'
import test from 'node:test'
import {
  followBackward,
  followForward,
  inputAtOffset,
  inputSpending,
  outputAtOffset,
  outputOffset,
  totalOutputValue
} from '../src/ordinalMath.js'
import { fakeTx } from './helpers.js'

test('output offsets are the running sum of preceding output values', () => {
  const tx = fakeTx({ outputs: [1, 5, 2] })
  assert.equal(outputOffset(tx, 0), 0)
  assert.equal(outputOffset(tx, 1), 1)
  assert.equal(outputOffset(tx, 2), 6)
  assert.equal(totalOutputValue(tx), 8)
})

test('an offset resolves to the output whose range contains it', () => {
  const tx = fakeTx({ outputs: [1, 5, 2] })
  assert.deepEqual(outputAtOffset(tx, 0), { vout: 0, offsetInOutput: 0, satoshis: 1 })
  assert.deepEqual(outputAtOffset(tx, 1), { vout: 1, offsetInOutput: 0, satoshis: 5 })
  assert.deepEqual(outputAtOffset(tx, 5), { vout: 1, offsetInOutput: 4, satoshis: 5 })
  assert.deepEqual(outputAtOffset(tx, 6), { vout: 2, offsetInOutput: 0, satoshis: 2 })
})

test('an offset past the last output was paid to the miner', () => {
  const tx = fakeTx({ outputs: [1, 5] })
  assert.deepEqual(outputAtOffset(tx, 6), { burned: 'fee', offsetPastOutputs: 0 })
  assert.deepEqual(outputAtOffset(tx, 9), { burned: 'fee', offsetPastOutputs: 3 })
})

test('input lookup only needs the values it actually reads', () => {
  const tx = fakeTx({ inputs: [{}, {}, {}], outputs: [1] })
  assert.deepEqual(inputAtOffset(tx, 0, [4]), { index: 0, offsetInInput: 0, satoshis: 4 })
  assert.deepEqual(inputAtOffset(tx, 5, [4, 10]), { index: 1, offsetInInput: 1, satoshis: 10 })
  assert.throws(() => inputAtOffset(tx, 20, [4, 10]), /value of input 2 is needed/)
  assert.throws(() => inputAtOffset(tx, 20, [4, 10, 1]), /beyond the 15 satoshis/)
})

test('an ordinal first in, first out keeps its position', () => {
  // The 1Sat convention: the ordinal is input 0 and lands on output 0.
  const spending = fakeTx({
    inputs: [{ prevTxId: 'aa', outputIndex: 0 }, { prevTxId: 'bb', outputIndex: 1 }],
    outputs: [1, 9000]
  })
  const step = followForward(spending, { txid: 'aa'.repeat(32), vout: 0, outpoint: 'x' }, 0, [1])
  assert.equal(step.inputIndex, 0)
  assert.equal(step.satoshiOffset, 0)
  assert.equal(step.vout, 0)
  assert.equal(step.satoshis, 1)
})

test('an ordinal behind a funding input lands at the matching output offset', () => {
  const spending = fakeTx({
    inputs: [{ prevTxId: 'bb', outputIndex: 0 }, { prevTxId: 'aa', outputIndex: 0 }],
    outputs: [500, 1, 200]
  })
  // 500 satoshis of funding come first, so the ordinal sits at offset 500,
  // which is exactly where the 1 satoshi output begins.
  const step = followForward(spending, { txid: 'aa'.repeat(32), vout: 0, outpoint: 'x' }, 0, [500])
  assert.equal(step.satoshiOffset, 500)
  assert.equal(step.vout, 1)
  assert.equal(step.satoshis, 1)
})

test('an ordinal landing in a larger output is no longer a 1SatOrdinal', () => {
  const spending = fakeTx({
    inputs: [{ prevTxId: 'aa', outputIndex: 0 }],
    outputs: [10]
  })
  const step = followForward(spending, { txid: 'aa'.repeat(32), vout: 0, outpoint: 'x' }, 0, [1])
  assert.equal(step.vout, 0)
  assert.equal(step.satoshis, 10) // merged - the caller treats this as burned
})

test('an ordinal beyond the outputs was burned to fee', () => {
  const spending = fakeTx({
    inputs: [{ prevTxId: 'bb', outputIndex: 0 }, { prevTxId: 'aa', outputIndex: 0 }],
    outputs: [400]
  })
  const step = followForward(spending, { txid: 'aa'.repeat(32), vout: 0, outpoint: 'x' }, 0, [500])
  assert.equal(step.satoshiOffset, 500)
  assert.equal(step.burned, 'fee')
})

test('spending an outpoint is matched on both txid and index', () => {
  const tx = fakeTx({
    inputs: [{ prevTxId: 'aa', outputIndex: 1 }, { prevTxId: 'aa', outputIndex: 0 }],
    outputs: [1]
  })
  assert.equal(inputSpending(tx, { txid: 'aa'.repeat(32), vout: 0 }), 1)
  assert.equal(inputSpending(tx, { txid: 'aa'.repeat(32), vout: 1 }), 0)
  assert.equal(inputSpending(tx, { txid: 'cc'.repeat(32), vout: 0 }), -1)
})

test('walking backward names the parent outpoint and its size', () => {
  const tx = fakeTx({
    inputs: [{ prevTxId: 'aa', outputIndex: 7 }],
    outputs: [1, 20]
  })
  const step = followBackward(tx, 0, 0, [900])
  assert.equal(step.satoshiOffset, 0)
  assert.equal(step.inputIndex, 0)
  assert.equal(step.vout, 7)
  assert.equal(step.parentSatoshis, 900) // came out of a larger output
  assert.equal(step.txid, 'aa'.repeat(32))
})

test('following forward refuses a transaction that does not spend the outpoint', () => {
  const tx = fakeTx({ inputs: [{ prevTxId: 'bb', outputIndex: 0 }], outputs: [1] })
  const step = followForward(tx, { txid: 'aa'.repeat(32), vout: 0, outpoint: 'aa_0' }, 0, [1])
  assert.match(step.error, /does not spend/)
})
