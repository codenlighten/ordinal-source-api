import { parseEnvelopes } from './envelope.js'
import { printableText } from './fields.js'
import { formatOutpoint } from './outpoint.js'
import { Opcode, chunkBytes, scriptFromChunks } from './script.js'
import { detectToken } from './token.js'

const MAP_PREFIX = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'

/**
 * Magic Attribute Protocol - the OP_RETURN convention 1Sat uses to tag an
 * ordinal with metadata (app, type, collection, geohash...). Only the SET
 * command is decoded; anything else is left as raw pushes.
 */
function parseMap (pushes) {
  if (pushes.length < 4 || pushes[0].text !== MAP_PREFIX) return null
  if (String(pushes[1].text).toUpperCase() !== 'SET') return null

  const map = {}
  for (let i = 2; i + 1 < pushes.length; i += 2) {
    const key = pushes[i].text
    if (key == null) continue
    map[key] = pushes[i + 1].text ?? pushes[i + 1].hex
  }
  return Object.keys(map).length ? map : null
}

/**
 * Splits what is left after the envelope into the locking script proper and any
 * trailing OP_RETURN data. Without this the "lock" would include the OP_RETURN,
 * and deriving an address from it would simply fail - which is what a caller
 * wants it for.
 */
export function splitLock (script) {
  const chunks = script.chunks
  const cut = chunks.findIndex((c) => c.opcodenum === Opcode.OP_RETURN && !c.buf)
  if (cut === -1) return { lock: script, opReturn: null }

  const pushes = chunks
    .slice(cut + 1)
    .map((c) => chunkBytes(c))
    .filter((b) => b != null)
    .map((b) => ({ hex: b.toString('hex'), text: printableText(b), size: b.length }))

  return {
    lock: scriptFromChunks(chunks.slice(0, cut)),
    opReturn: { map: parseMap(pushes), pushes }
  }
}

/**
 * The first valid inscription in an output script, reduced to the parts a
 * consumer usually wants. Returns null when the script carries none.
 */
export function inscriptionAt (script, outpoint = null) {
  const parsed = parseEnvelopes(script, { limit: 1 })
  const envelope = parsed.envelopes[0]
  if (!envelope || !envelope.valid) return null

  const contentType = envelope.fields.get('01')?.toString('utf8') ?? null
  const { lock, opReturn } = splitLock(parsed.lock)

  return {
    contentType,
    content: envelope.body,
    contentLength: envelope.body ? envelope.body.length : 0,
    fields: envelope.fields,
    token: detectToken({ body: envelope.body, contentType, outpoint }),
    envelope,
    // The locking script alone, so an address can be derived from it.
    lock,
    // Trailing OP_RETURN data, with MAP tags decoded when present.
    opReturn
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
