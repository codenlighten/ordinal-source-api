import { inputOutpoint, tokenAt, tokenOutputs } from '@smartledger/ordinals'
import { logger } from '../lib/logger.js'
import { fetchTransaction } from '../services/txProvider.js'
import { applyTransaction } from './rules.js'
import { MemoryStore } from './store.js'

/**
 * Replays one token's own history instead of scanning the chain.
 *
 * A full block-by-block sync is the correct way to build an index, but over a
 * public REST API it is brutal: a single BSV block can hold a quarter of a
 * million transactions. When the question is only "is this token's history
 * sound", the answer needs the transactions that touched that token and nothing
 * else - so this walks back from an outpoint to the deploy that created it,
 * then applies that subgraph forward through the same rules the indexer uses.
 *
 * The result is a real index of one token, built from verified chain data,
 * usually in a few dozen fetches rather than millions.
 */

/** Walks back from an outpoint, collecting the transactions that fed it. */
export async function collectHistory (outpoint, { network, providers, maxDepth = 64 } = {}) {
  const seen = new Map()
  const queue = [{ outpoint, depth: 0 }]
  let deploysFound = 0

  while (queue.length) {
    const { outpoint: current, depth } = queue.shift()
    const [txid] = current.split('_')
    if (seen.has(txid) || depth > maxDepth) continue

    const { tx } = await fetchTransaction(txid, { network, providers })
    seen.set(txid, { tx, depth })

    // Follow only the inputs that are themselves token outputs.
    for (let index = 0; index < tx.inputs.length; index++) {
      const source = inputOutpoint(tx, index)
      if (source.coinbase || seen.has(source.txid)) continue

      let parent
      try {
        parent = await fetchTransaction(source.txid, { network, providers })
      } catch {
        continue
      }
      const output = parent.tx.outputs[source.vout]
      if (!output) continue

      const token = tokenAt(output.script, source.outpoint)
      if (!token) continue
      if (token.op.startsWith('deploy')) deploysFound++
      queue.push({ outpoint: source.outpoint, depth: depth + 1 })
    }
  }

  return { transactions: orderByDependency([...seen.values()].map((e) => e.tx)), deploysFound }
}

/**
 * Orders transactions so every one comes after the transactions that produced
 * its inputs. Discovery order will not do: the history is a graph, not a line,
 * and a transfer drawing on two branches must follow both. Chain order would
 * also serve, but this needs no block heights and is exact for the subgraph.
 */
export function orderByDependency (transactions) {
  const byId = new Map(transactions.map((tx) => [tx.hash, tx]))
  const pending = new Map()

  for (const tx of transactions) {
    const deps = new Set()
    for (let index = 0; index < tx.inputs.length; index++) {
      const { txid, coinbase } = inputOutpoint(tx, index)
      if (!coinbase && byId.has(txid) && txid !== tx.hash) deps.add(txid)
    }
    pending.set(tx.hash, deps)
  }

  const ordered = []
  const done = new Set()

  while (pending.size) {
    const ready = [...pending].filter(([, deps]) => [...deps].every((d) => done.has(d)))
    if (!ready.length) {
      // Unreachable on a real chain, but never spin on bad input.
      for (const [txid] of pending) ordered.push(byId.get(txid))
      break
    }
    for (const [txid] of ready) {
      ordered.push(byId.get(txid))
      done.add(txid)
      pending.delete(txid)
    }
  }
  return ordered
}

/** Builds an index containing one token's history. */
export async function replayToken (outpoint, { network = 'main', providers, store = new MemoryStore() } = {}) {
  const { transactions, deploysFound } = await collectHistory(outpoint, { network, providers })
  const events = []

  transactions.forEach((tx, idx) => {
    const result = applyTransaction(store, tx, { height: idx, idx, network })
    store.apply(result.writes)
    events.push(...result.events.map((event) => ({ ...event, txid: tx.hash })))
  })

  logger.info('replayed token history', {
    outpoint,
    transactions: transactions.length,
    deploys: deploysFound,
    accepted: events.filter((e) => e.accepted).length,
    rejected: events.filter((e) => !e.accepted).length
  })

  return { store, transactions, events }
}

export { tokenOutputs }
