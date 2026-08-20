import { parseEnvelopes } from './envelope.js'
import { detectToken } from './token.js'
import { formatOutpoint } from './outpoint.js'

/**
 * The first valid inscription in an output script, reduced to the parts a
 * consumer usually wants. Returns null when the script carries none.
 */
export function inscriptionAt (script, outpoint = null) {
  const { envelopes, lock } = parseEnvelopes(script, { limit: 1 })
  const envelope = envelopes[0]
  if (!envelope || !envelope.valid) return null

  const contentType = envelope.fields.get('01')?.toString('utf8') ?? null
  return {
    contentType,
    content: envelope.body,
    contentLength: envelope.body ? envelope.body.length : 0,
    fields: envelope.fields,
    token: detectToken({ body: envelope.body, contentType, outpoint }),
    envelope,
    lock
  }
}

/** The token document on an output, if it carries one. */
export function tokenAt (script, outpoint = null) {
  return inscriptionAt(script, outpoint)?.token ?? null
}

/** Token-bearing outputs of a transaction, with their satoshi values. */
export function tokenOutputs (tx) {
  const found = []
  tx.outputs.forEach((output, vout) => {
    const outpoint = formatOutpoint(tx.hash, vout)
    const token = tokenAt(output.script, outpoint)
    if (token) found.push({ vout, outpoint, satoshis: output.satoshis, token })
  })
  return found
}
