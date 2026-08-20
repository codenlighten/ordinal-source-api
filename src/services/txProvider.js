import bsv from '@smartledger/bsv'
import { config } from '../config.js'
import { ApiError } from '../lib/errors.js'
import { TtlCache } from './cache.js'
import { resolveProviders } from './providers.js'

const { Transaction } = bsv

const txCache = new TtlCache({ max: config.cacheMax, ttlMs: config.cacheTtlMs })
const scriptCache = new TtlCache({ max: config.cacheMax * 4, ttlMs: config.cacheTtlMs })

export const TXID_RE = /^[0-9a-fA-F]{64}$/

export function assertTxid (txid) {
  if (!TXID_RE.test(String(txid || ''))) {
    throw ApiError.badRequest(`invalid txid: ${txid}`)
  }
  return String(txid).toLowerCase()
}

async function attempt (provider, mode, params, timeoutMs) {
  const url = provider[mode].url(params)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: '*/*', ...(provider.headers ? provider.headers() : {}) }
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const err = new Error(`HTTP ${res.status} ${body.slice(0, 120)}`)
      err.status = res.status
      throw err
    }
    return { hex: await provider[mode].parse(res), ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetches a raw transaction, trying each provider in order and verifying the
 * returned bytes actually hash to the requested txid. Returns the parsed
 * transaction plus which source served it and why the others were skipped.
 */
export async function fetchTransaction (txidInput, { network = config.network, providers } = {}) {
  const txid = assertTxid(txidInput)
  const cacheKey = `${network}:${txid}`

  const chain = resolveProviders(providers, network, 'tx')

  // A cache hit is only honest if it came from a provider the caller allows -
  // otherwise an explicit ?provider= would be answered by a different source.
  const cached = txCache.get(cacheKey)
  if (cached && chain.some((p) => p.name === cached.source)) {
    return { ...cached, tx: new Transaction(cached.rawtx), attempts: [], cached: true }
  }
  const attempts = []

  for (const provider of chain) {
    try {
      const { hex, ms } = await attempt(provider, 'tx', { txid, network }, config.rawTxTimeoutMs)
      const tx = new Transaction(hex)
      if (tx.hash !== txid) {
        throw new Error(`returned transaction hashes to ${tx.hash}`)
      }
      const result = { txid, network, rawtx: hex, source: provider.name, sourceMs: ms, attempts }
      txCache.set(cacheKey, { txid, network, rawtx: hex, source: provider.name, sourceMs: ms })
      return { ...result, tx, cached: false }
    } catch (err) {
      attempts.push({ provider: provider.name, error: err.message, status: err.status })
    }
  }

  const notFound = attempts.every((a) => a.status === 404 || a.status === 400)
  throw notFound
    ? ApiError.notFound(`transaction ${txid} was not found on ${network}`, { attempts })
    : ApiError.upstream(`no provider could serve transaction ${txid}`, { attempts })
}

/**
 * Fetches a single output's locking script without downloading the whole
 * transaction. Cheaper for large inscriptions, but the satoshi value is not
 * part of the response, so 1-satoshi ordinality cannot be confirmed this way.
 */
export async function fetchOutputScript (txidInput, vout, { network = config.network, providers } = {}) {
  const txid = assertTxid(txidInput)
  const cacheKey = `${network}:${txid}:${vout}`

  const chain = resolveProviders(providers, network, 'output')

  const cached = scriptCache.get(cacheKey)
  if (cached && chain.some((p) => p.name === cached.source)) {
    return { ...cached, attempts: [], cached: true }
  }
  const attempts = []

  for (const provider of chain) {
    try {
      const { hex, ms } = await attempt(
        provider, 'output', { txid, vout, network }, config.rawTxTimeoutMs
      )
      const result = { txid, vout, network, scriptHex: hex, source: provider.name, sourceMs: ms }
      scriptCache.set(cacheKey, result)
      return { ...result, attempts, cached: false }
    } catch (err) {
      attempts.push({ provider: provider.name, error: err.message, status: err.status })
    }
  }

  const notFound = attempts.every((a) => a.status === 404 || a.status === 400)
  throw notFound
    ? ApiError.notFound(`output ${txid}_${vout} was not found on ${network}`, { attempts })
    : ApiError.upstream(`no provider could serve output ${txid}_${vout}`, { attempts })
}

export const cacheStats = () => ({ transactions: txCache.size, outputs: scriptCache.size })

export const clearCaches = () => {
  txCache.clear()
  scriptCache.clear()
}
