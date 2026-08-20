export const TXID_RE = /^[0-9a-fA-F]{64}$/

/**
 * Accepts the 1Sat inscription id form `<txid>_<vout>` plus the common
 * variants `<txid>:<vout>`, `<txid>.<vout>`, and `<txid>-<vout>`.
 */
export function parseOutpoint (input) {
  const raw = String(input || '').trim()
  const match = /^([0-9a-fA-F]{64})[_:.-](\d{1,10})$/.exec(raw)
  if (!match) throw new Error(`invalid outpoint: ${raw || '(empty)'} - expected <txid>_<vout>`)
  return { txid: match[1].toLowerCase(), vout: Number.parseInt(match[2], 10) }
}

export function parseVout (input) {
  const n = Number(input)
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid output index: ${input}`)
  return n
}

export function assertTxid (txid) {
  if (!TXID_RE.test(String(txid || ''))) throw new Error(`invalid txid: ${txid}`)
  return String(txid).toLowerCase()
}

export const formatOutpoint = (txid, vout) => `${txid}_${vout}`
