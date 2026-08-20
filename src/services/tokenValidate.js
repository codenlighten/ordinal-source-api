import { config } from '../config.js'
import { formatOutpoint, inputOutpoint, tokenAt, tokenOutputs } from '@smartledger/ordinals'
import { fetchTransaction } from './txProvider.js'

/**
 * Token conservation, checked against the chain.
 *
 * `wellFormed` on an inscription says one JSON document is correctly shaped.
 * This goes further and asks whether a transaction is a legal token operation:
 * do its token inputs cover what its outputs claim to move?
 *
 * Conservation is a property of a TRANSACTION, not of an output - an output
 * cannot be over-spent on its own - so validation always works on the whole
 * transaction, and an outpoint query validates the transaction containing it.
 *
 * Where this stops, and why:
 *
 *   decidable here      - conservation across one transaction, the 1 satoshi
 *                         requirement, a mint's auth input, and that a deploy
 *                         defines its own id
 *   decidable if walked - whether the token inputs were themselves valid, by
 *                         recursing toward the deploy. Bounded by depth and a
 *                         fetch budget; when every path reaches a deploy the
 *                         result is proven outright
 *   NOT decidable       - "first is first" ticker priority and BSV-20 supply
 *                         limits, which need every deploy and mint that ever
 *                         happened. Reported as unchecked, never as valid
 */

const NOT_DECIDABLE = ['ticker-priority', 'supply-limit']

/** One key per token, so BSV-20 tickers and BSV-21 ids validate alike. */
const tokenKey = (token) =>
  token.standard === 'BSV-20' ? `tick:${token.tickNormalized}` : token.id ?? null

const isAuth = (token) => token.op === 'auth' || token.op === 'deploy+auth'
const isDeploy = (token) => token.op.startsWith('deploy')
const contributes = (token) => !isAuth(token) && token.amount != null

class Budget {
  constructor (maxFetches) {
    this.maxFetches = maxFetches
    this.fetches = 0
    this.txs = new Map()
    this.results = new Map()
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

/** Token documents on the outputs this transaction spends. */
async function tokenInputs (tx, budget, opts) {
  const inputs = []
  for (let index = 0; index < tx.inputs.length; index++) {
    const { txid, vout, outpoint, coinbase } = inputOutpoint(tx, index)
    if (coinbase) continue

    let source
    try {
      source = await budget.tx(txid, opts)
    } catch (err) {
      inputs.push({ index, outpoint, unresolved: err.message })
      continue
    }

    const output = source.outputs[vout]
    if (!output) {
      inputs.push({ index, outpoint, unresolved: 'spends a missing output' })
      continue
    }

    const token = tokenAt(output.script, outpoint)
    if (token) inputs.push({ index, outpoint, satoshis: output.satoshis, token })
  }
  return inputs
}

const sum = (values) => values.reduce((total, value) => total + BigInt(value), 0n)

/**
 * Checks one token's balance across a transaction. Auth inputs carry authority
 * rather than value, so they are counted separately; a burn output still
 * consumes balance, which is why it is summed with the transfers.
 */
function conservationFor (key, inputs, outputs) {
  const spending = inputs.filter((i) => i.token && tokenKey(i.token) === key)
  const creating = outputs.filter((o) => tokenKey(o.token) === key)

  const valued = spending.filter((i) => contributes(i.token))
  const authorities = spending.filter((i) => isAuth(i.token))

  // Deploys and mints CREATE supply; transfers and burns MOVE existing supply.
  // Only the second kind has to be backed by inputs.
  const created = creating.filter((o) => contributes(o.token) && (isDeploy(o.token) || o.token.op === 'mint'))
  const minted = creating.filter((o) => o.token.op === 'mint')
  const moved = creating.filter((o) => contributes(o.token) && !isDeploy(o.token) && o.token.op !== 'mint')

  const inputTotal = sum(valued.map((i) => i.token.amount))
  const outputTotal = sum(moved.map((o) => o.token.amount))
  const createdTotal = sum(created.map((o) => o.token.amount))

  const errors = []
  const notes = []

  // A token output is an ordinal, so it must be a single satoshi.
  for (const output of creating) {
    if (output.satoshis !== 1) {
      errors.push(`output ${output.vout} holds ${output.satoshis} satoshis; a token output must hold 1`)
    }
  }

  const deploys = creating.filter((o) => isDeploy(o.token))
  const conserves = moved.length > 0

  if (conserves && outputTotal > inputTotal) {
    errors.push(
      `outputs move ${outputTotal} but inputs only carry ${inputTotal}; ` +
      'the excess is not backed by any input'
    )
  }
  if (minted.length && !authorities.length && !deploys.length) {
    errors.push('mint outputs require an auth input for this token')
  }
  if (conserves && !valued.length && !deploys.length) {
    errors.push('outputs move tokens but no input carries any')
  }

  const surplus = conserves && inputTotal > outputTotal ? inputTotal - outputTotal : 0n
  if (surplus > 0n) {
    notes.push(`${surplus} token units were not carried forward and are burned`)
  }

  return {
    tokenId: key.startsWith('tick:') ? null : key,
    tick: key.startsWith('tick:') ? key.slice(5) : null,
    standard: (creating[0] ?? spending[0])?.token.standard ?? null,
    inputs: spending.map((i) => ({
      outpoint: i.outpoint,
      op: i.token.op,
      amount: i.token.amount ?? null,
      authority: isAuth(i.token) || undefined
    })),
    outputs: creating.map((o) => ({ vout: o.vout, op: o.token.op, amount: o.token.amount ?? null })),
    inputTotal: inputTotal.toString(),
    outputTotal: outputTotal.toString(),
    createdTotal: createdTotal > 0n ? createdTotal.toString() : undefined,
    burnedSurplus: surplus > 0n ? surplus.toString() : undefined,
    authorityPresent: authorities.length > 0,
    conserved: errors.length === 0,
    errors,
    notes
  }
}

/**
 * Validates every token operation in a transaction. `depth` controls how far
 * back the token inputs are themselves validated: depth 1 checks this
 * transaction and states its assumption, higher depths keep walking until the
 * budget runs out or every path reaches a deploy.
 */
export async function validateTransaction (
  txid,
  { network = config.network, providers, depth = 1, budget = null } = {}
) {
  const opts = { network, providers }
  const owned = !budget
  budget = budget ?? new Budget(config.tokenValidateMaxFetches)

  if (budget.results.has(txid)) return budget.results.get(txid)

  const tx = await budget.tx(txid, opts)
  const outputs = tokenOutputs(tx)
  if (!outputs.length) {
    return { txid, tokens: [], note: 'no token outputs in this transaction' }
  }

  const inputs = await tokenInputs(tx, budget, opts)
  const keys = [...new Set(outputs.map((o) => tokenKey(o.token)).filter(Boolean))]
  const tokens = keys.map((key) => conservationFor(key, inputs, outputs))

  // Every operation that stands on its own, with nothing to trace back to.
  const selfContained = outputs.every((o) => isDeploy(o.token))
  const result = {
    txid,
    depth,
    tokens,
    conserved: tokens.every((t) => t.conserved),
    checked: ['document', 'conservation', 'satoshi-value', 'auth-input'],
    notChecked: NOT_DECIDABLE,
    unresolvedInputs: inputs.filter((i) => i.unresolved).map((i) => ({
      outpoint: i.outpoint,
      reason: i.unresolved
    }))
  }

  if (selfContained) {
    // A deploy defines its own supply, so nothing needs to back it.
    result.proven = result.conserved
    result.assuming = null
  } else if (depth > 1) {
    const sources = [...new Set(
      inputs.filter((i) => i.token && contributes(i.token)).map((i) => i.outpoint.split('_')[0])
    )]
    const backing = []
    for (const source of sources) {
      try {
        backing.push(await validateTransaction(source, { network, providers, depth: depth - 1, budget }))
      } catch (err) {
        backing.push({ txid: source, unresolved: err.message })
      }
    }
    result.backing = backing.map((b) => ({
      txid: b.txid,
      conserved: b.conserved ?? null,
      proven: b.proven ?? false,
      unresolved: b.unresolved
    }))
    result.proven = result.conserved && backing.every((b) => b.proven === true)
    result.assuming = result.proven ? null : 'the token inputs are themselves valid'
  } else {
    result.proven = false
    result.assuming = 'the token inputs are themselves valid'
  }

  if (owned || true) result.cost = { transactionsFetched: budget.fetches }
  budget.results.set(txid, result)
  return result
}
