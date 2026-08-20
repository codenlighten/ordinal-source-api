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

/**
 * Reads a response body into a Buffer, streaming it rather than materialising a
 * hex string. `limit` is Infinity by default: an inscription can legitimately be
 * an image, an audio file, or a video, and refusing those would defeat the point
 * of the API. An operator running a public instance can set MAX_TX_BYTES, and
 * the stream is then cancelled the moment the cap is passed - a few packets
 * spent instead of the whole process.
 */
async function readCapped (res, limit) {
  const tooLarge = (bytes, approx = false) => {
    const err = new Error(
      `response is ${approx ? 'over ' : ''}${bytes} bytes, above the ${limit} byte limit`
    )
    err.tooLarge = true
    err.status = 413
    return err
  }

  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) throw tooLarge(declared)
  if (!res.body) return Buffer.from(await res.arrayBuffer())

  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > limit) throw tooLarge(limit, true)
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks, total)
}

/**
 * Caps how many upstream downloads run at once. Bodies are streamed, but a
 * dozen simultaneous video-sized inscriptions still add up, so they queue.
 */
const queue = []
let active = 0

function withSlot (run) {
  if (active < config.maxConcurrentFetches) {
    active++
    return run().finally(release)
  }
  return new Promise((resolve, reject) => {
    queue.push(() => run().then(resolve, reject).finally(release))
  })
}

function release () {
  active--
  const next = queue.shift()
  if (next) {
    active++
    next()
  }
}

async function attempt (provider, mode, params, { timeoutMs, limit }) {
  const url = provider[mode].url(params)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const res = await withSlot(() => fetch(url, {
      signal: controller.signal,
      headers: { accept: '*/*', ...(provider.headers ? provider.headers() : {}) }
    }))
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const err = new Error(`HTTP ${res.status} ${body.slice(0, 120)}`)
      err.status = res.status
      throw err
    }
    return { bytes: provider[mode].parse(await readCapped(res, limit)), ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Collapses concurrent identical fetches into a single upstream request.
 * Without it, a burst of requests for one popular inscription becomes a burst
 * at the provider, which is how an API gets itself rate limited.
 */
const inFlight = new Map()

function coalesce (key, run) {
  const running = inFlight.get(key)
  if (running) return running
  const promise = run().finally(() => inFlight.delete(key))
  inFlight.set(key, promise)
  return promise
}

const failure = (attempts, { tooLarge, notFound, upstream }) => {
  if (attempts.length && attempts.every((a) => a.tooLarge)) return ApiError.tooLarge(...tooLarge)
  return attempts.every((a) => a.status === 404 || a.status === 400)
    ? ApiError.notFound(...notFound)
    : ApiError.upstream(...upstream)
}

const record = (attempts, provider, err) =>
  attempts.push({
    provider: provider.name,
    error: err.message,
    status: err.status,
    tooLarge: err.tooLarge
  })

/**
 * Fetches a raw transaction, trying each provider in order and verifying the
 * returned bytes actually hash to the requested txid. Returns the parsed
 * transaction plus which source served it and why the others were skipped.
 */
export async function fetchTransaction (
  txidInput,
  { network = config.network, providers, maxBytes } = {}
) {
  const txid = assertTxid(txidInput)
  const cacheKey = `${network}:${txid}`
  const chain = resolveProviders(providers, network, 'tx')

  // A cache hit is only honest if it came from a provider the caller allows -
  // otherwise an explicit ?provider= would be answered by a different source.
  const cached = txCache.get(cacheKey)
  if (cached && chain.some((p) => p.name === cached.source)) {
    return { ...cached, tx: new Transaction(cached.bytes), attempts: [], cached: true }
  }

  const limit = maxBytes ?? config.maxTxBytes
  const names = chain.map((p) => p.name).join(',')

  return coalesce(`tx:${cacheKey}:${names}:${limit}`, async () => {
    const attempts = []

    for (const provider of chain) {
      try {
        const { bytes, ms } = await attempt(
          provider, 'tx', { txid, network }, { timeoutMs: config.rawTxTimeoutMs, limit }
        )
        const tx = new Transaction(bytes)
        if (tx.hash !== txid) throw new Error(`returned transaction hashes to ${tx.hash}`)

        const entry = { txid, network, bytes, size: bytes.length, source: provider.name, sourceMs: ms }
        // Big media inscriptions are served but not retained - caching one would
        // hold its full size in memory for the whole TTL.
        if (bytes.length <= config.cacheMaxTxBytes) txCache.set(cacheKey, entry)
        return { ...entry, attempts, tx, cached: false }
      } catch (err) {
        record(attempts, provider, err)
      }
    }

    throw failure(attempts, {
      tooLarge: [
        `transaction ${txid} is larger than the ${limit} byte fetch limit`,
        { attempts, hint: 'request a single outpoint, which fetches only that output script' }
      ],
      notFound: [`transaction ${txid} was not found on ${network}`, { attempts }],
      upstream: [`no provider could serve transaction ${txid}`, { attempts }]
    })
  })
}

/**
 * Fetches a single output's locking script without downloading the whole
 * transaction. Cheaper for large inscriptions, but the satoshi value is not
 * part of the response, so 1-satoshi ordinality cannot be confirmed this way.
 */
export async function fetchOutputScript (
  txidInput,
  vout,
  { network = config.network, providers, maxBytes } = {}
) {
  const txid = assertTxid(txidInput)
  const cacheKey = `${network}:${txid}:${vout}`
  const chain = resolveProviders(providers, network, 'output')

  const cached = scriptCache.get(cacheKey)
  if (cached && chain.some((p) => p.name === cached.source)) {
    return { ...cached, attempts: [], cached: true }
  }

  const limit = maxBytes ?? config.maxTxBytes
  const names = chain.map((p) => p.name).join(',')

  return coalesce(`out:${cacheKey}:${names}:${limit}`, async () => {
    const attempts = []

    for (const provider of chain) {
      try {
        const { bytes, ms } = await attempt(
          provider, 'output', { txid, vout, network },
          { timeoutMs: config.rawTxTimeoutMs, limit }
        )
        const entry = {
          txid,
          vout,
          network,
          scriptHex: bytes.toString('hex'),
          size: bytes.length,
          source: provider.name,
          sourceMs: ms
        }
        if (bytes.length <= config.cacheMaxTxBytes) scriptCache.set(cacheKey, entry)
        return { ...entry, attempts, cached: false }
      } catch (err) {
        record(attempts, provider, err)
      }
    }

    throw failure(attempts, {
      tooLarge: [`output ${txid}_${vout} is larger than the ${limit} byte fetch limit`, { attempts }],
      notFound: [`output ${txid}_${vout} was not found on ${network}`, { attempts }],
      upstream: [`no provider could serve output ${txid}_${vout}`, { attempts }]
    })
  })
}

export const cacheStats = () => ({
  transactions: txCache.size,
  outputs: scriptCache.size,
  inFlight: inFlight.size,
  fetching: active,
  queued: queue.length
})

export const clearCaches = () => {
  txCache.clear()
  scriptCache.clear()
}
