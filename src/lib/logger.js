import { config } from '../config.js'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }

const threshold = LEVELS[config.logLevel] ?? LEVELS.info

/** Errors do not serialise to JSON on their own; keep the useful parts. */
function clean (fields) {
  const out = {}
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined) continue
    out[key] = value instanceof Error ? { message: value.message, code: value.code } : value
  }
  return out
}

const pretty = (level, msg, fields) => {
  const pairs = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ')
  return `${new Date().toISOString().slice(11, 23)} ${level.toUpperCase().padEnd(5)} ${msg}${pairs ? ' ' + pairs : ''}`
}

function emit (level, msg, fields, bound) {
  if (LEVELS[level] < threshold) return
  const merged = { ...bound, ...clean(fields) }
  const line = config.logFormat === 'pretty'
    ? pretty(level, msg, merged)
    : JSON.stringify({ ts: new Date().toISOString(), level, msg, ...merged })

  if (level === 'error' || level === 'warn') console.error(line)
  else console.log(line)
}

/**
 * Structured logging, one JSON object per line by default. `child` binds fields
 * such as a request id so every line from that request carries it, which is what
 * makes a provider going bad legible after the fact rather than only live.
 */
function make (bound = {}) {
  return {
    debug: (msg, fields) => emit('debug', msg, fields, bound),
    info: (msg, fields) => emit('info', msg, fields, bound),
    warn: (msg, fields) => emit('warn', msg, fields, bound),
    error: (msg, fields) => emit('error', msg, fields, bound),
    child: (fields) => make({ ...bound, ...clean(fields) })
  }
}

export const logger = make()
