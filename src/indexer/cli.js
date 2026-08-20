import { writeFile } from 'node:fs/promises'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import { WocBlockSource } from './blockSource.js'
import { Indexer } from './indexer.js'
import { MemoryStore } from './store.js'

/**
 * Runs the token indexer.
 *
 *   npm run index -- --from 793000 --to 793010 --out index.json
 *   npm run index -- --from 793000 --follow
 *   npm run index -- --token <outpoint> --out index.json
 *   npm run index -- --from 793000 --follow --db index.db
 *
 * The --token form replays one token's own history instead of scanning blocks,
 * which is the difference between dozens of fetches and millions.
 *
 * 1Sat began around block 780,000, so starting from genesis indexes years of
 * chain that contain no tokens at all.
 */
const arg = (name, fallback = null) => {
  const at = process.argv.indexOf(`--${name}`)
  if (at === -1) return fallback
  const next = process.argv[at + 1]
  return next && !next.startsWith('--') ? next : true
}

const from = Number(arg('from', config.indexStartHeight))
const to = arg('to') ? Number(arg('to')) : null
const follow = Boolean(arg('follow'))

const out = arg('out')
const token = arg('token')
const db = arg('db')

// SQLite when asked for: durable, and its undo log survives a restart, so the
// reorg window is not reset to nothing every time the process starts.
let store
if (db) {
  const { SqliteStore } = await import('./sqliteStore.js')
  store = await SqliteStore.open(String(db), { undoDepth: config.indexUndoDepth })
  logger.info('using sqlite index', { db: String(db), ...store.stats() })
} else {
  store = new MemoryStore({ undoDepth: config.indexUndoDepth })
}
let stats

if (token) {
  const { replayToken } = await import('./replay.js')
  await replayToken(String(token), { network: config.network, store })
  stats = store.stats()
} else {
  const source = new WocBlockSource({ network: config.network })
  const indexer = new Indexer({ source, store, network: config.network, startHeight: from })

  process.on('SIGINT', () => {
    logger.info('stopping')
    indexer.stop()
  })

  logger.info('indexing', { from, to: to ?? 'tip', follow, network: config.network })
  stats = await indexer.run({ until: to, once: !follow })
}

if (out) {
  if (!store.toJSON) throw new Error('--out writes a snapshot; use it without --db')
  await writeFile(String(out), JSON.stringify(store.toJSON()))
  logger.info('index written', { file: String(out) })
}

logger.info('index summary', stats)

for (const token of store.tokens().slice(0, 20)) {
  logger.info('token', {
    key: token.tokenKey,
    standard: token.standard,
    symbol: token.symbol ?? token.tick,
    supply: token.supply,
    max: token.max,
    height: token.height
  })
}

if (store.close) store.close()
