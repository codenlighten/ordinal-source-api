import { config } from '../config.js'
import {
  followBackward,
  followForward,
  inputOutpoint,
  inputSpending,
  outputOffset
} from '../lib/ordinalMath.js'
import { formatOutpoint } from '../lib/outpoint.js'
import { lookupSpend } from './indexer.js'
import { fetchTransaction } from './txProvider.js'

/**
 * Independent verification of an ordinal's chain position.
 *
 * Everywhere else this API parses transaction bytes whose hash it checked, then
 * hands off to an indexer for "where did this come from" and "who holds it now".
 * This module closes that gap by recomputing both from the chain itself:
 *
 *   backward, to the origin  - needs NO index. A transaction names its own
 *                              inputs, so the walk back is fully self-contained
 *                              and the indexer's origin claim can be confirmed
 *                              or contradicted outright.
 *
 *   forward, to the holder   - needs a spend lookup, because "which transaction
 *                              spent this output" is not answerable from the
 *                              output. Each answer is then checked against real
 *                              bytes: the named transaction must actually spend
 *                              the outpoint, and ordinal theory is reapplied to
 *                              find where the satoshi landed. A wrong hop is
 *                              caught; only omission ("nothing spent it") is
 *                              beyond reach, and it is reported as unrefuted
 *                              rather than proven.
 */

/** Budget shared across a verification so one request cannot walk forever. */
class Budget {
  constructor ({ maxHops, maxFetches }) {
    this.maxHops = maxHops
    this.maxFetches = maxFetches
    this.fetches = 0
    this.txs = new Map()
  }

  async tx (txid, opts) {
    const hit = this.txs.get(txid)
    if (hit) return hit
    if (this.fetches >= this.maxFetches) {
      const err = new Error(`fetch budget of ${this.maxFetches} transactions exhausted`)
      err.exhausted = true
      throw err
    }
    this.fetches++
    const { tx } = await fetchTransaction(txid, opts)
    this.txs.set(txid, tx)
    return tx
  }
}

/**
 * Values of the inputs before `upTo`, fetched lazily. With the usual 1Sat
 * convention of putting the ordinal first, `upTo` is 0 and this costs nothing.
 */
async function inputValuesBefore (tx, upTo, budget, opts) {
  const values = []
  for (let i = 0; i < upTo; i++) {
    const { txid, vout, coinbase } = inputOutpoint(tx, i)
    if (coinbase) throw new Error('cannot value a coinbase input')
    const parent = await budget.tx(txid, opts)
    values[i] = parent.outputs[vout].satoshis
  }
  return values
}

/** Walks back to the origin: the first outpoint where the satoshi stood alone. */
export async function walkToOrigin (start, { network, providers, budget }) {
  const opts = { network, providers }
  const hops = []
  let { txid, vout } = start
  let offsetInOutput = 0
  let truncated = false

  for (let hop = 0; ; hop++) {
    if (hop >= budget.maxHops) {
      truncated = true
      break
    }

    const tx = await budget.tx(txid, opts)
    const output = tx.outputs[vout]
    if (!output) return { error: `output ${formatOutpoint(txid, vout)} does not exist`, hops }
    if (hop === 0 && output.satoshis !== 1) {
      return {
        origin: null,
        notAnOrdinal: `output holds ${output.satoshis} satoshis, so it is not a 1SatOrdinal`,
        hops
      }
    }

    // Which input funded this satoshi? Inputs are valued in order and the
    // search stops as soon as the offset is covered, so with the usual 1Sat
    // convention of putting the ordinal first this costs a single fetch.
    const offset = outputOffset(tx, vout) + offsetInOutput
    const values = []
    let index = 0
    let base = 0
    for (;;) {
      if (index >= tx.inputs.length) {
        return { error: `offset ${offset} is beyond what ${txid} spends`, hops }
      }
      const { txid: prevTxid, vout: prevVout, coinbase } = inputOutpoint(tx, index)
      if (coinbase) {
        // Newly minted satoshis: this outpoint is where it first stood alone.
        hops.push({ outpoint: formatOutpoint(txid, vout), from: 'coinbase' })
        return { origin: formatOutpoint(txid, vout), hops, truncated }
      }
      const parent = await budget.tx(prevTxid, opts)
      const value = parent.outputs[prevVout]?.satoshis
      if (value == null) {
        return { error: `input ${index} of ${txid} spends a missing output`, hops }
      }
      values[index] = value
      if (offset < base + value) break
      base += value
      index++
    }

    const step = followBackward(tx, vout, offsetInOutput, values)

    hops.push({
      outpoint: formatOutpoint(txid, vout),
      satoshiOffset: step.satoshiOffset,
      spentBy: `input ${step.inputIndex}`,
      from: step.outpoint,
      parentSatoshis: step.parentSatoshis
    })

    // The satoshi was previously packaged with others, so it first stood alone
    // here - this outpoint is the origin.
    if (step.parentSatoshis !== 1) {
      return { origin: formatOutpoint(txid, vout), hops, truncated }
    }

    txid = step.txid
    vout = step.vout
    offsetInOutput = step.offsetInParentOutput
  }

  return { origin: null, hops, truncated }
}

/** Walks forward to the unspent tip, checking every hop the index claims. */
export async function walkToTip (start, { network, providers, budget }) {
  const opts = { network, providers }
  const hops = []
  let { txid, vout } = start
  let offsetInOutput = 0
  let truncated = false

  for (let hop = 0; ; hop++) {
    if (hop >= budget.maxHops) {
      truncated = true
      break
    }

    const outpoint = formatOutpoint(txid, vout)
    const spend = await lookupSpend(outpoint, { network })

    if (spend.spent === null) {
      return { current: outpoint, hops, unresolved: 'no index could report whether this was spent' }
    }
    if (!spend.spent) {
      // Unspent as far as any index knows. Not provable from chain data.
      return { current: outpoint, hops, tipUnrefuted: true, truncated }
    }

    const spendingTx = await budget.tx(spend.spentIn, opts)

    // The index named a transaction; confirm it really spends this outpoint.
    if (inputSpending(spendingTx, { txid, vout }) === -1) {
      return {
        current: null,
        hops,
        error: `${spend.source} claims ${spend.spentIn} spends ${outpoint}, but it does not`,
        contradicted: true
      }
    }

    const index = inputSpending(spendingTx, { txid, vout })
    const values = await inputValuesBefore(spendingTx, index, budget, opts)
    const step = followForward(spendingTx, { txid, vout, outpoint }, offsetInOutput, values)

    hops.push({
      outpoint,
      spentIn: spend.spentIn,
      inputIndex: step.inputIndex,
      satoshiOffset: step.satoshiOffset,
      to: step.burned ? null : formatOutpoint(spendingTx.hash, step.vout),
      landedIn: step.burned ? 'fee' : `output ${step.vout} of ${step.satoshis} satoshis`
    })

    if (step.burned) {
      return { current: null, hops, burned: 'paid to fee', truncated }
    }
    if (step.satoshis !== 1) {
      // Packaged with other satoshis: the ordinal ends here.
      return {
        current: null,
        hops,
        burned: `merged into a ${step.satoshis} satoshi output`,
        lastSeen: formatOutpoint(spendingTx.hash, step.vout),
        truncated
      }
    }

    txid = spendingTx.hash
    vout = step.vout
    offsetInOutput = step.offsetInOutput
  }

  return { current: formatOutpoint(txid, vout), hops, truncated }
}

const compare = (computed, claimed) => {
  if (computed == null || claimed == null) return 'unavailable'
  return computed === claimed ? 'match' : 'mismatch'
}

/**
 * Recomputes an ordinal's position and compares it with what an indexer said.
 * `claim` is the trace from services/indexer.js, or null to just compute.
 */
export async function verifyOrdinal (outpoint, { network, providers, claim = null } = {}) {
  const budget = new Budget({
    maxHops: config.verifyMaxHops,
    maxFetches: config.verifyMaxFetches
  })
  const [txid, voutText] = outpoint.split('_')
  const start = { txid, vout: Number(voutText) }
  const warnings = []

  let origin = { origin: null }
  let tip = { current: null }
  try {
    origin = await walkToOrigin(start, { network, providers, budget })
  } catch (err) {
    warnings.push(`origin walk stopped: ${err.message}`)
  }
  try {
    tip = await walkToTip(start, { network, providers, budget })
  } catch (err) {
    warnings.push(`forward walk stopped: ${err.message}`)
  }

  if (origin.truncated || tip.truncated) {
    warnings.push(`walk stopped at the ${config.verifyMaxHops} hop limit`)
  }
  for (const step of [origin, tip]) {
    if (step.error) warnings.push(step.error)
    if (step.notAnOrdinal) warnings.push(step.notAnOrdinal)
    if (step.unresolved) warnings.push(step.unresolved)
  }

  const agreement = {
    origin: compare(origin.origin, claim?.genesis?.outpoint ?? null),
    current: compare(tip.current, claim?.current?.outpoint ?? null)
  }

  return {
    method: 'recomputed from transaction bytes using ordinal theory',
    origin: origin.origin ?? null,
    current: tip.current ?? null,
    burned: tip.burned ?? null,
    agreement,
    // The backward walk needs no index at all; the forward walk checks each
    // spend an index names, but cannot prove that no spend exists.
    proven: {
      // Derived from transaction bytes alone, with no index consulted.
      origin: Boolean(origin.origin) && !origin.truncated,
      // Every forward hop was confirmed against the bytes of the spending
      // transaction and recomputed with ordinal theory.
      transfers: !tip.error && !tip.truncated && !tip.unresolved,
      // Absence of a spend is not provable from chain data without an index of
      // this API's own, so a live tip is unrefuted rather than proven.
      stillUnspent: false
    },
    tipUnrefuted: tip.tipUnrefuted ?? false,
    contradicted: tip.contradicted ?? origin.contradicted ?? false,
    hops: { backward: origin.hops ?? [], forward: tip.hops ?? [] },
    cost: { transactionsFetched: budget.fetches, hopLimit: budget.maxHops },
    warnings
  }
}
