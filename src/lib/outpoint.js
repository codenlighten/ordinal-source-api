import { ApiError } from './errors.js'
import { TXID_RE } from '../services/txProvider.js'

/**
 * Accepts the 1Sat inscription id form `<txid>_<vout>` plus the common
 * variants `<txid>:<vout>`, `<txid>.<vout>`, and `<txid>-<vout>`.
 */
export function parseOutpoint (input) {
  const raw = String(input || '').trim()
  const match = /^([0-9a-fA-F]{64})[_:.-](\d{1,10})$/.exec(raw)
  if (!match) {
    throw ApiError.badRequest(
      `invalid outpoint: ${raw || '(empty)'} - expected <txid>_<vout>`
    )
  }
  return { txid: match[1].toLowerCase(), vout: Number.parseInt(match[2], 10) }
}

export function parseVout (input) {
  const n = Number(input)
  if (!Number.isInteger(n) || n < 0) {
    throw ApiError.badRequest(`invalid output index: ${input}`)
  }
  return n
}

export const formatOutpoint = (txid, vout) => `${txid}_${vout}`

export { TXID_RE }
