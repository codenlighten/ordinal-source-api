import { readFile } from 'node:fs/promises'
import { Router } from 'express'
import { formatOutpoint } from '@smartledger/ordinals'
import { config } from '../config.js'
import { ApiError } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { parseOutpoint } from '../lib/outpoint.js'
import { BALANCE, MemoryStore, SPEND, TOKEN, UTXO } from '../indexer/store.js'

/**
 * Reading from an index this instance built, rather than from someone else's.
 *
 * The point is not the extra endpoints. It is that the questions the rest of
 * the API has to hedge on - which deploy owns a ticker, what the supply is, who
 * holds what, what spent an outpoint - are answered here from ordered chain
 * history, so the hedge is gone.
 */

let store = null

/** Loads an index snapshot written by the indexer. Absent is not an error. */
export async function loadIndex (file = config.indexFile) {
  if (!file) {
    // Loading nothing means there is no index, not "keep the last one".
    store = null
    return null
  }
  try {
    const data = JSON.parse(await readFile(file, 'utf8'))
    store = MemoryStore.fromJSON(data)
    logger.info('index loaded', { file, ...store.stats() })
    return store
  } catch (err) {
    logger.warn('no index loaded', { file, error: err.message })
    store = null
    return null
  }
}

export const indexStore = () => store

/** The forward index, served locally instead of asked of a third party. */
export const localSpend = (outpoint) => {
  if (!store) return null
  const spentIn = store.get(SPEND, outpoint)
  if (spentIn) return { spent: true, spentIn, source: 'local-index' }
  // Only a live token output can be reported unspent with any authority.
  if (store.get(UTXO, outpoint)) return { spent: false, source: 'local-index' }
  return null
}

const router = Router()

const requireIndex = () => {
  if (!store) {
    throw ApiError.notFound('no index is loaded', {
      hint: 'build one with `npm run index -- --token <outpoint> --out index.json` and set INDEX_FILE'
    })
  }
  return store
}

/** GET /v1/index - what this index covers. */
router.get('/', (_req, res) => {
  if (!store) {
    return res.json({ loaded: false, hint: 'set INDEX_FILE to an index built by `npm run index`' })
  }
  res.json({ loaded: true, file: config.indexFile, ...store.stats() })
})

/** GET /v1/index/tokens - every token this index has seen. */
router.get('/tokens', (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 1000)
    const tokens = requireIndex().tokens()
    res.json({
      count: tokens.length,
      tokens: tokens.slice(0, limit).map((token) => ({
        ...token,
        holders: store.holdersOf(token.tokenKey).length
      }))
    })
  } catch (err) {
    next(err)
  }
})

/** GET /v1/index/token/:key - supply and holders, from ordered history. */
router.get('/token/:key', (req, res, next) => {
  try {
    const index = requireIndex()
    const key = String(req.params.key)
    const token = index.get(TOKEN, key) ?? index.get(TOKEN, `tick:${key.toLowerCase()}`)
    if (!token) throw ApiError.notFound(`no token ${key} in this index`)

    const holders = index.holdersOf(token.tokenKey)
    res.json({
      ...token,
      // Decided by order, which is exactly what a single transaction cannot say.
      supplyDecided: true,
      holders: holders.length,
      circulating: holders.reduce((total, h) => total + BigInt(h.amount), 0n).toString(),
      top: holders.slice(0, Number(req.query.holders) || 10)
    })
  } catch (err) {
    next(err)
  }
})

/** GET /v1/index/address/:address - token balances for one owner. */
router.get('/address/:address', (req, res, next) => {
  try {
    const index = requireIndex()
    const balances = index.balancesOf(String(req.params.address)).map((held) => {
      const token = index.get(TOKEN, held.tokenKey)
      return {
        ...held,
        symbol: token?.symbol ?? token?.tick ?? null,
        standard: token?.standard ?? null,
        decimals: token?.decimals ?? 0
      }
    })
    res.json({ address: req.params.address, tokens: balances.length, balances })
  } catch (err) {
    next(err)
  }
})

/** GET /v1/index/outpoint/:outpoint - the token output, and what spent it. */
router.get('/outpoint/:outpoint', (req, res, next) => {
  try {
    const index = requireIndex()
    const { txid, vout } = parseOutpoint(req.params.outpoint)
    const outpoint = formatOutpoint(txid, vout)
    const utxo = index.get(UTXO, outpoint)
    const spentIn = index.get(SPEND, outpoint)

    if (!utxo && !spentIn) throw ApiError.notFound(`${outpoint} is not a token output in this index`)
    res.json({
      outpoint,
      unspent: Boolean(utxo),
      ...(utxo ?? {}),
      spentIn: spentIn ?? null,
      // No hedge needed: this index recorded the spend when it ingested it.
      source: 'local-index'
    })
  } catch (err) {
    next(err)
  }
})

export { BALANCE }
export default router
