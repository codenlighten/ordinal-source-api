import express from 'express'
import { config } from './config.js'
import { ApiError } from './lib/errors.js'
import { rateLimit } from './lib/rateLimit.js'
import ordinals from './routes/ordinals.js'

export function createApp () {
  const app = express()
  app.disable('x-powered-by')
  app.set('json spaces', 2)
  if (config.trustProxy) app.set('trust proxy', config.trustProxy)
  app.use(express.json({ limit: config.maxBodyBytes }))

  if (config.rateLimit.enabled) {
    app.use(rateLimit({ skip: (req) => req.path === '/health' }))
  }

  app.get('/health', (_req, res) => {
    res.json({ ok: true, network: config.network, uptime: process.uptime() })
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
        'POST /v1/parse': 'parse a rawtx or script without touching the network',
        'GET /v1/fields': 'selectable fields',
        'GET /v1/providers': 'configured sources'
      },
      query: {
        field: 'contentType | content | tick | amount | origin | currentOwner | 1 | 0x0b | ...',
        encoding: 'auto | utf8 | hex | base64 | json | number',
        raw: 'return the selected field as the response body',
        network: 'main | test',
        provider: 'gorillapool | whatsonchain | bitails | junglebus (comma separated)',
        origin: 'add genesis origin and current holder',
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
    res.status(404).json({ error: { code: 'not_found', message: `no route for ${req.method} ${req.path}` } })
  })

  app.use((err, _req, res, _next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }
      })
    }
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'invalid JSON body' } })
    }
    // Malformed hex, truncated transactions and similar parse failures.
    return res.status(400).json({
      error: { code: 'parse_error', message: err.message || 'request could not be processed' }
    })
  })

  return app
}
