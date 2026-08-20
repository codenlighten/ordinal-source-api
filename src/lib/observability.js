import { randomUUID } from 'node:crypto'
import { counter, observe } from './metrics.js'
import { logger } from './logger.js'

/**
 * Gives every request an id, logs one line when it finishes, and records it.
 *
 * The route *pattern* is what gets labelled, never the concrete path - a
 * million txids would otherwise become a million metric series. An inbound
 * x-request-id is honoured so a trace survives across a proxy.
 */
export function observability () {
  return function observe_ (req, res, next) {
    const requestId = req.get('x-request-id') || randomUUID()
    const started = process.hrtime.bigint()

    req.id = requestId
    req.log = logger.child({ requestId })
    res.set('x-request-id', requestId)

    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9
      // req.route is only populated once a handler has matched, and routeBase
      // is captured on the way in because express clears baseUrl on errors.
      const base = req.routeBase ?? req.baseUrl
      const route = req.route ? `${base}${req.route.path}` : 'unmatched'
      const labels = { method: req.method, route, status: res.statusCode }

      counter('ordinal_api_http_requests_total', labels)
      observe('ordinal_api_http_request_seconds', seconds, { method: req.method, route })

      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'
      req.log[level]('request', {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        route,
        status: res.statusCode,
        ms: Math.round(seconds * 1000),
        ip: req.ip
      })
    })

    next()
  }
}
