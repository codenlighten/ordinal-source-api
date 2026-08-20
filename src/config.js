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
  maxEnvelopesPerOutput: int(process.env.MAX_ENVELOPES_PER_OUTPUT, 16)
}
