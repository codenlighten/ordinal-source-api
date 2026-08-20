import { createApp } from './app.js'
import { config } from './config.js'
import { logger } from './lib/logger.js'
import { loadIndex } from './routes/index.js'

const app = createApp()

// A local index, if one was built. Absent simply means the API falls back to
// asking a third-party indexer, exactly as before.
await loadIndex()

const server = app.listen(config.port, config.host, () => {
  logger.info('listening', {
    host: config.host,
    port: config.port,
    network: config.network,
    rateLimit: config.rateLimit.enabled ? config.rateLimit.perMinute : 'off',
    maxTxBytes: config.maxTxBytes === Infinity ? 'unlimited' : config.maxTxBytes
  })
})

// Long downloads are in flight at any moment, so shutdown drains rather than
// cuts - but not forever, or a stuck socket would hold the process open.
let shuttingDown = false

function shutdown (signal) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info('shutting down', { signal })

  const force = setTimeout(() => {
    logger.warn('forcing exit, connections did not drain')
    process.exit(1)
  }, config.shutdownGraceMs)
  force.unref()

  server.close(() => {
    logger.info('closed cleanly')
    process.exit(0)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', { error: reason instanceof Error ? reason : String(reason) })
})
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception', { error: err, stack: err.stack })
  shutdown('uncaughtException')
})
