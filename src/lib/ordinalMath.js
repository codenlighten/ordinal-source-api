/**
 * Ordinal theory arithmetic, as 1Sat applies it on BSV.
 *
 *   "the nth satoshi input to the transaction is transferred to the nth
 *    satoshi output of the transaction"
 *
 * Everything here is a pure function over transaction values, so a transfer can
 * be recomputed from raw bytes instead of taken on an indexer's word. Positions
 * are absolute satoshi offsets within a transaction's input and output
 * sequences, which is what makes the mapping a plain identity: offset s on the
 * input side is offset s on the output side.
 *
 * A 1SatOrdinal only ever sits at offset 0 of a 1 satoshi output, so the
 * per-output offset carried around is always 0 for a live ordinal. It is
 * tracked anyway, because it is what tells a burn apart from a transfer.
 */

const ZERO_HASH = '0'.repeat(64)

/** Absolute satoshi offset where an output's value begins. */
export function outputOffset (tx, vout) {
  let offset = 0
  for (let i = 0; i < vout; i++) offset += tx.outputs[i].satoshis
  return offset
}

/** Total satoshis paid out by a transaction; anything beyond this is fee. */
export const totalOutputValue = (tx) =>
  tx.outputs.reduce((sum, output) => sum + output.satoshis, 0)

/**
 * Finds the output holding a given satoshi offset.
 * Returns `{ burned: 'fee' }` when the offset falls past the last output, which
 * is how a satoshi is paid to the miner rather than transferred.
 */
export function outputAtOffset (tx, offset) {
  let base = 0
  for (let vout = 0; vout < tx.outputs.length; vout++) {
    const value = tx.outputs[vout].satoshis
    if (offset < base + value) {
      return { vout, offsetInOutput: offset - base, satoshis: value }
    }
    base += value
  }
  return { burned: 'fee', offsetPastOutputs: offset - base }
}

/**
 * Finds the input holding a given satoshi offset, given the value of each input
 * in order. Values may be sparse: only the inputs before the answer are needed,
 * so a caller can fill them in lazily and stop as soon as the offset is covered.
 */
export function inputAtOffset (tx, offset, inputValues) {
  let base = 0
  for (let index = 0; index < tx.inputs.length; index++) {
    const value = inputValues[index]
    if (value == null) {
      throw new Error(`value of input ${index} is needed to place offset ${offset}`)
    }
    if (offset < base + value) {
      return { index, offsetInInput: offset - base, satoshis: value }
    }
    base += value
  }
  throw new Error(`offset ${offset} is beyond the ${base} satoshis this transaction spends`)
}

/** The outpoint an input spends. */
export function inputOutpoint (tx, index) {
  const input = tx.inputs[index]
  const txid = Buffer.from(input.prevTxId).toString('hex')
  return { txid, vout: input.outputIndex, outpoint: `${txid}_${input.outputIndex}`, coinbase: txid === ZERO_HASH }
}

/** Index of the input spending a given outpoint, or -1. */
export function inputSpending (tx, { txid, vout }) {
  return tx.inputs.findIndex(
    (input) => input.outputIndex === vout && Buffer.from(input.prevTxId).toString('hex') === txid
  )
}

/**
 * Where the satoshi at `offsetInOutput` of `vout` goes when `tx` is spent by
 * `spendingTx`. `inputValues` need only cover inputs up to the spending one.
 */
export function followForward (spendingTx, spentOutpoint, offsetInOutput, inputValues) {
  const index = inputSpending(spendingTx, spentOutpoint)
  if (index === -1) {
    return { error: `this transaction does not spend ${spentOutpoint.outpoint}` }
  }

  let base = 0
  for (let i = 0; i < index; i++) {
    const value = inputValues[i]
    if (value == null) throw new Error(`value of input ${i} is needed to follow the transfer`)
    base += value
  }

  const landed = outputAtOffset(spendingTx, base + offsetInOutput)
  return { inputIndex: index, satoshiOffset: base + offsetInOutput, ...landed }
}

/**
 * Where the satoshi at `offsetInOutput` of `vout` came from. Needs no index at
 * all - a transaction names its own inputs - so the walk back toward an origin
 * is verifiable from chain data alone.
 */
export function followBackward (tx, vout, offsetInOutput, inputValues) {
  const offset = outputOffset(tx, vout) + offsetInOutput
  const { index, offsetInInput, satoshis } = inputAtOffset(tx, offset, inputValues)
  return {
    satoshiOffset: offset,
    inputIndex: index,
    offsetInParentOutput: offsetInInput,
    parentSatoshis: satoshis,
    ...inputOutpoint(tx, index)
  }
}

export { ZERO_HASH }
