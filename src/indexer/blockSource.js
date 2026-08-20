import bsv from '@smartledger/bsv'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'

const { Transaction } = bsv

/**
 * Where blocks come from.
 *
 * No public BSV API serves whole raw blocks, so block-by-block ingest means
 * "list the txids in this block, then fetch those transactions". WhatsOnChain
 * takes twenty txids per bulk request, which is what makes this tolerable at
 * all - and every transaction is still verified against its txid on arrival,
 * so a bad response is caught rather than indexed.
 *
 * A source that can hand over whole blocks - a node, or a bulk archive - drops
 * in behind this same interface and is the right answer for real throughput.
 */

const BULK_LIMIT = 20 // WhatsOnChain caps a bulk request at twenty txids

/**
 * An indexer is a client before it is anything else, and a public API will
 * throttle it. WhatsOnChain allows roughly three requests a second unencumbered,
 * so this stays under that by default and backs off when told to rather than
 * hammering through a 429.
 */
const BULK_CONCURRENCY = Number(process.env.INDEX_CONCURRENCY || 3)
const MAX_RETRIES = 5

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function once (url, { timeoutMs, body }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      method: body ? 'POST' : 'GET',
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    })
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} for ${url}`)
      err.status = res.status
      err.retryAfter = Number(res.headers.get('retry-after')) || null
      throw err
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** Retries throttling and transient upstream failures with a growing wait. */
async function getJson (url, { timeoutMs = config.rawTxTimeoutMs, body = null } = {}) {
  let wait = 500
  for (let attempt = 1; ; attempt++) {
    try {
      return await once(url, { timeoutMs, body })
    } catch (err) {
      const retryable = err.status === 429 || err.status === 503 || err.name === 'AbortError'
      if (!retryable || attempt >= MAX_RETRIES) throw err

      const delay = err.retryAfter ? err.retryAfter * 1000 : wait
      logger.warn('block source throttled, backing off', {
        status: err.status,
        attempt,
        waitMs: delay
      })
      await sleep(delay)
      wait = Math.min(wait * 2, 10000)
    }
  }
}

export class WocBlockSource {
  constructor ({ network = config.network } = {}) {
    this.network = network
    this.base = `https://api.whatsonchain.com/v1/bsv/${network}`
  }

  async getTip () {
    const info = await getJson(`${this.base}/chain/info`)
    return info.blocks
  }

  /** Header plus every txid, following the paging WoC uses for large blocks. */
  async getBlock (height) {
    const block = await getJson(`${this.base}/block/height/${height}`)
    const txids = [...block.tx]

    for (const uri of block.pages?.uri ?? []) {
      const page = await getJson(`https://api.whatsonchain.com/v1/bsv/${this.network}${uri}`)
      txids.push(...page)
    }

    if (block.txcount && txids.length !== block.txcount) {
      throw new Error(`block ${height} lists ${txids.length} txids but declares ${block.txcount}`)
    }
    return {
      height: block.height,
      hash: block.hash,
      previousHash: block.previousblockhash,
      time: block.time,
      txids
    }
  }

  async fetchBatch (batch) {
    const rows = await getJson(`${this.base}/txs/hex`, { body: { txids: batch } })
    const byId = new Map(rows.map((row) => [row.txid, row.hex]))
    const txs = []

    for (const txid of batch) {
      const hex = byId.get(txid)
      if (!hex) {
        logger.warn('block source returned no transaction', { txid })
        continue
      }
      const tx = new Transaction(Buffer.from(hex, 'hex'))
      // The source is not trusted any further here than anywhere else.
      if (tx.hash !== txid) {
        logger.warn('block source returned a mismatched transaction', { asked: txid, got: tx.hash })
        continue
      }
      txs.push(tx)
    }
    return txs
  }

  /**
   * Yields verified transactions in the order the txids were given. Batches are
   * fetched several at a time - a block of ten thousand transactions is five
   * hundred requests, and doing those one after another is the difference
   * between minutes and hours - but they are still yielded strictly in order,
   * because the indexer's rules depend on it.
   */
  async * getTransactions (txids) {
    const batches = []
    for (let i = 0; i < txids.length; i += BULK_LIMIT) {
      batches.push(txids.slice(i, i + BULK_LIMIT))
    }

    for (let i = 0; i < batches.length; i += BULK_CONCURRENCY) {
      const window = batches.slice(i, i + BULK_CONCURRENCY)
      const fetched = await Promise.all(window.map((batch) => this.fetchBatch(batch)))
      for (const txs of fetched) {
        for (const tx of txs) yield tx
      }
    }
  }
}

/** Serves blocks from memory. Used by the tests, and useful for replay. */
export class StaticBlockSource {
  constructor (blocks) {
    this.blocks = new Map(blocks.map((b) => [b.height, b]))
  }

  async getTip () {
    return Math.max(...this.blocks.keys())
  }

  async getBlock (height) {
    const block = this.blocks.get(height)
    if (!block) throw new Error(`no block at height ${height}`)
    return { ...block, txids: block.transactions.map((tx) => tx.hash) }
  }

  async * getTransactions (txids) {
    for (const block of this.blocks.values()) {
      for (const tx of block.transactions) {
        if (txids.includes(tx.hash)) yield tx
      }
    }
  }
}
