import { config } from '../config.js'

/**
 * Per-IP token bucket.
 *
 * This protects the upstream providers as much as this process: WhatsOnChain
 * and Bitails rate limit by origin, so one busy client can get the whole
 * instance throttled for everyone. Refills continuously rather than on a fixed
 * window, so a burst is allowed but a sustained flood is not.
 */
export function rateLimit ({
  perMinute = config.rateLimit.perMinute,
  burst = config.rateLimit.burst,
  skip = () => false
} = {}) {
  const refillPerMs = perMinute / 60000
  const buckets = new Map()

  // Buckets for idle clients are dropped so the map cannot grow unbounded.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - 10 * 60000
    for (const [key, bucket] of buckets) {
      if (bucket.updated < cutoff) buckets.delete(key)
    }
  }, 60000)
  sweep.unref?.()

  return function rateLimiter (req, res, next) {
    if (skip(req)) return next()

    const key = req.ip || req.socket.remoteAddress || 'unknown'
    const now = Date.now()
    const bucket = buckets.get(key) ?? { tokens: burst, updated: now }

    bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.updated) * refillPerMs)
    bucket.updated = now

    if (bucket.tokens < 1) {
      const retryAfter = Math.ceil((1 - bucket.tokens) / refillPerMs / 1000)
      buckets.set(key, bucket)
      res.set('retry-after', String(Math.max(1, retryAfter)))
      res.set('x-ratelimit-limit', String(perMinute))
      res.set('x-ratelimit-remaining', '0')
      return res.status(429).json({
        error: {
          code: 'rate_limited',
          message: `rate limit of ${perMinute} requests per minute exceeded`,
          details: { retryAfter: Math.max(1, retryAfter) }
        }
      })
    }

    bucket.tokens -= 1
    buckets.set(key, bucket)
    res.set('x-ratelimit-limit', String(perMinute))
    res.set('x-ratelimit-remaining', String(Math.floor(bucket.tokens)))
    next()
  }
}
