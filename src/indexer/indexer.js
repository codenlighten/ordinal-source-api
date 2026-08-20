import { logger } from '../lib/logger.js'
import { counter, gauge } from '../lib/metrics.js'
import { applyTransaction } from './rules.js'
import { MemoryStore } from './store.js'

/**
 * The ingest loop: blocks in order, transactions in order, writes committed one
 * block at a time.
 *
 * Order is the whole point. It is what turns the questions this API has to
 * answer with "not decidable" into ordinary lookups - which deploy claimed a
 * ticker first, whether a mint still fits under the cap, whether an input was
 * ever valid. None of that is knowable from a transaction on its own.
 *
 * A block is applied as a single batch with its previous values captured, so a
 * reorg is a rollback rather than a resync.
 */
export class Indexer {
  constructor ({
    source,
    store = new MemoryStore(),
    network = 'main',
    startHeight = 0,
    log = logger
  }) {
    this.source = source
    this.store = store
    this.network = network
    this.startHeight = startHeight
    this.log = log
    this.running = false
    this.stopping = false
  }

  get height () {
    return this.store.getCursor()?.height ?? this.startHeight - 1
  }

  /**
   * Applies one block. Returns what changed, or rolls back first if the block
   * does not build on what was already indexed.
   */
  async ingestBlock (height) {
    const block = await this.source.getBlock(height)
    const cursor = this.store.getCursor()

    // A block that does not name our tip as its parent means the chain moved
    // under us; walk back until it lines up again.
    if (cursor && block.previousHash && this.store.blockHashAt(cursor.height) !== block.previousHash) {
      const dropped = this.store.rollbackBlock()
      if (dropped) {
        counter('ordinal_api_index_reorgs_total')
        this.log.warn('reorg, rolled back a block', { height: dropped.height, hash: dropped.hash })
        return { reorg: true, rolledBack: dropped.height }
      }
    }

    // Previous values, captured as each write lands, so rollback restores what
    // was there rather than deleting the key.
    const before = []
    const events = []
    let index = 0
    let scanned = 0
    let changes = 0

    for await (const tx of this.source.getTransactions(block.txids)) {
      const result = applyTransaction(this.store, tx, {
        height: block.height,
        idx: index++,
        network: this.network
      })
      scanned++
      if (result.writes.length) {
        // Applied as we go: a later transaction in the same block must see what
        // an earlier one did, exactly as a node would.
        before.push(...this.store.apply(result.writes))
        changes += result.writes.length
        events.push(...result.events.map((e) => ({ ...e, txid: tx.hash })))
      }
    }

    this.store.commitBlock({ height: block.height, hash: block.hash, before })

    counter('ordinal_api_index_blocks_total')
    counter('ordinal_api_index_transactions_total', undefined, scanned)
    if (events.length) counter('ordinal_api_index_events_total', undefined, events.length)
    gauge('ordinal_api_index_height', block.height)

    return { height: block.height, hash: block.hash, scanned, changes, events }
  }

  /** Runs until the tip is reached, or until stopped. */
  async run ({ until = null, pollMs = 30000, once = false } = {}) {
    this.running = true
    this.stopping = false

    while (!this.stopping) {
      const tip = until ?? (await this.source.getTip())
      let next = this.height + 1

      if (next > tip) {
        if (once) break
        await new Promise((resolve) => setTimeout(resolve, pollMs))
        continue
      }

      while (next <= tip && !this.stopping) {
        const started = Date.now()
        const result = await this.ingestBlock(next)
        if (result.reorg) {
          next = this.height + 1
          continue
        }
        this.log.info('block indexed', {
          height: result.height,
          transactions: result.scanned,
          tokenEvents: result.events.length,
          ms: Date.now() - started
        })
        next++
      }

      if (once) break
    }

    this.running = false
    return this.store.stats()
  }

  stop () {
    this.stopping = true
  }
}
