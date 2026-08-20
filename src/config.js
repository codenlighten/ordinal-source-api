import 'dotenv/config'

const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10)
  return Number.isFinite(n) ? n : d
}

export const config = {
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',

  // Default chain to resolve txids against. Overridable per request with ?network=
  network: process.env.NETWORK === 'test' ? 'test' : 'main',

  // Raw-transaction source. {network} and {txid} are substituted.
  rawTxUrl:
    process.env.RAW_TX_URL ||
    'https://api.whatsonchain.com/v1/bsv/{network}/tx/{txid}/hex',
  rawTxTimeoutMs: int(process.env.RAW_TX_TIMEOUT_MS, 15000),

  // In-memory raw-tx cache
  cacheMax: int(process.env.CACHE_MAX, 500),
  cacheTtlMs: int(process.env.CACHE_TTL_MS, 10 * 60 * 1000),

  // Inscription bodies larger than this are omitted from JSON responses and
  // must be fetched from the /content endpoint instead.
  maxInlineContentBytes: int(process.env.MAX_INLINE_CONTENT_BYTES, 256 * 1024),

  // Hard ceiling on envelopes parsed out of a single output script
  maxEnvelopesPerOutput: int(process.env.MAX_ENVELOPES_PER_OUTPUT, 16),

  // Inscriptions are legitimately large - images, audio, video - so there is no
  // download limit by default. Set MAX_TX_BYTES on a public instance to abort
  // oversized fetches mid-stream; 0 means unlimited.
  maxTxBytes: int(process.env.MAX_TX_BYTES, 0) || Infinity,

  // Transactions above this are served but not retained in the cache, so one
  // large video inscription cannot pin hundreds of megabytes for the whole TTL.
  cacheMaxTxBytes: int(process.env.CACHE_MAX_TX_BYTES, 2 * 1024 * 1024),

  // Simultaneous upstream fetches. Large bodies are streamed, but several at
  // once still add up, so they queue rather than stack.
  maxConcurrentFetches: int(process.env.MAX_CONCURRENT_FETCHES, 6),

  // Request body ceiling for POST /v1/parse (hex, so roughly 2x the tx size).
  maxBodyBytes: int(process.env.MAX_BODY_BYTES, 128 * 1024 * 1024),

  // Per-IP token bucket. Set RATE_LIMIT=off to disable.
  rateLimit: {
    enabled: String(process.env.RATE_LIMIT || '').toLowerCase() !== 'off',
    perMinute: int(process.env.RATE_LIMIT_RPM, 120),
    burst: int(process.env.RATE_LIMIT_BURST, 30)
  },

  // Set when running behind a proxy so the rate limiter sees real client IPs.
  trustProxy: process.env.TRUST_PROXY || false
}
