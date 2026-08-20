import { createApp } from './app.js'
import { config } from './config.js'

const app = createApp()

const server = app.listen(config.port, config.host, () => {
  console.log(`ordinal-source-api listening on http://${config.host}:${config.port} (${config.network}net)`)
})

const shutdown = (signal) => {
  console.log(`${signal} received, closing`)
  server.close(() => process.exit(0))
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
