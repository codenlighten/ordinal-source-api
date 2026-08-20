import express from 'express'
import { config } from './config.js'
import { ApiError } from './lib/errors.js'
import { logger } from './lib/logger.js'
import { render, snapshot } from './lib/metrics.js'
import { observability } from './lib/observability.js'
import { rateLimit } from './lib/rateLimit.js'
import ordinals from './routes/ordinals.js'

export function createApp () {
  const app = express()
  app.disable('x-powered-by')
  app.set('json spaces', 2)
  if (config.trustProxy) app.set('trust proxy', config.trustProxy)
  app.use(express.json({ limit: config.maxBodyBytes }))
  app.use(observability())

  if (config.rateLimit.enabled) {
    app.use(rateLimit({ skip: (req) => req.path === '/health' }))
  }

  app.get('/health', (_req, res) => {
    res.json({ ok: true, network: config.network, uptime: process.uptime() })
  })

  /** Prometheus exposition by default; ?format=json to read it by eye. */
  app.get('/metrics', (req, res) => {
    if (String(req.query.format).toLowerCase() === 'json') return res.json(snapshot())
    res.type('text/plain; version=0.0.4; charset=utf-8').send(render())
  })

  app.get('/', (_req, res) => {
    res.json({
      name: 'ordinal-source-api',
      protocol: '1Sat Ordinals',
      endpoints: {
        'GET /v1/tx/:txid': 'every output of a transaction',
        'GET /v1/tx/:txid/out/:vout': 'one output',
        'GET /v1/outpoint/:txid_:vout': 'one output by inscription id',
        'GET /v1/outpoint/:outpoint/content': 'inscription body with its content-type',
        'GET /v1/ordinal/:outpoint': 'genesis origin and current holder, from either end',
        'GET /v1/ordinal/:outpoint?verify=1': 'recompute both from transaction bytes',
        'POST /v1/parse': 'parse a rawtx or script without touching the network',
        'GET /v1/fields': 'selectable fields',
        'GET /v1/providers': 'configured sources',
        'GET /metrics': 'Prometheus metrics (?format=json to read by eye)'
      },
      query: {
        field: 'contentType | content | tick | amount | origin | currentOwner | 1 | 0x0b | ...',
        encoding: 'auto | utf8 | hex | base64 | json | number',
        raw: 'return the selected field as the response body',
        network: 'main | test',
        provider: 'gorillapool | whatsonchain | bitails | junglebus (comma separated)',
        origin: 'add genesis origin and current holder',
        verify: 'recompute that position from chain data and compare',
        resolveToken: 'fill in a transfer\'s symbol and decimals from its deploy',
        tokens: 'only outputs carrying a bsv-20 / bsv-21 token',
        fast: 'fetch only the output script instead of the whole transaction',
        all: 'include envelopes after the first',
        concat: 'concatenate multi-push bodies (BTC-style)',
        inscribed: 'only outputs that carry an inscription',
        asm: 'include script ASM'
      }
    })
  })

  app.use('/v1', ordinals)

  app.use((req, res) => {
    res.status(404).json({
      error: {
        code: 'not_found',
        message: `no route for ${req.method} ${req.path}`,
        requestId: req.id
      }
    })
  })

  app.use((err, req, res, _next) => {
    const log = req.log ?? logger
    const requestId = req.id

    if (err instanceof ApiError) {
      log[err.status >= 500 ? 'error' : 'warn']('request failed', {
        code: err.code,
        status: err.status,
        error: err.message,
        details: err.details
      })
      return res.status(err.status).json({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
          requestId
        }
      })
    }
    if (err instanceof SyntaxError && 'body' in err) {
      log.warn('invalid JSON body', { error: err.message })
      return res.status(400).json({
        error: { code: 'bad_request', message: 'invalid JSON body', requestId }
      })
    }
    // Malformed hex, truncated transactions and similar parse failures.
    log.warn('request could not be processed', { error: err.message, stack: err.stack })
    return res.status(400).json({
      error: {
        code: 'parse_error',
        message: err.message || 'request could not be processed',
        requestId
      }
    })
  })

  return app
}
