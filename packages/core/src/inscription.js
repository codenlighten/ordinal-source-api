import { parseEnvelopes } from './envelope.js'
import { printableText } from './fields.js'
import { formatOutpoint } from './outpoint.js'
import { Opcode, chunkBytes, isOp, scriptFromChunks, toScript } from './script.js'
import { detectToken } from './token.js'

const MAP_PREFIX = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'
const SEPARATOR = '|' // BitCom joins protocols in one OP_RETURN with this

/**
 * Magic Attribute Protocol - the OP_RETURN convention 1Sat uses to tag an
 * ordinal with metadata (app, type, collection, geohash...). Only the SET
 * command is decoded; anything else is left as raw pushes.
 *
 * The prefix is looked for anywhere in the payload, not only first, because
 * BitCom outputs routinely join several protocols with a `|` separator and MAP
 * is often not the one at the front. Parsing stops at the next separator so a
 * following protocol's pushes are not read as MAP keys.
 */
function parseMap (pushes) {
  const start = pushes.findIndex((push) => push.text === MAP_PREFIX)
  if (start === -1) return null
  if (String(pushes[start + 1]?.text).toUpperCase() !== 'SET') return null

  const end = pushes.findIndex((push, i) => i > start && push.text === SEPARATOR)
  const body = pushes.slice(start + 2, end === -1 ? undefined : end)

  const map = {}
  // Keys and values are strictly paired: an unpaired tail is not a key.
  for (let i = 0; i + 1 < body.length; i += 2) {
    const key = body[i].text
    if (key == null) continue
    map[key] = body[i + 1].text ?? body[i + 1].hex
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
  const s = toScript(script)
  const chunks = s.chunks
  const at = chunks.findIndex((c) => isOp(c, Opcode.OP_RETURN))
  if (at === -1) return { lock: s, opReturn: null }

  // `OP_FALSE OP_RETURN` is the standard data output, so the OP_FALSE belongs
  // to the data, not to the lock. Leaving it behind was enough on its own to
  // stop an address resolving.
  const cut = at > 0 && isOp(chunks[at - 1], Opcode.OP_FALSE) ? at - 1 : at

  const pushes = chunks
    .slice(at + 1)
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

/**
 * The token document on an output, if it carries one. Deliberately does not go
 * through `inscriptionAt`: splitting the lock is wasted work when the caller
 * only wants the token, and this is an indexer's inner loop.
 */
export function tokenAt (script, outpoint = null) {
  const { envelopes } = parseEnvelopes(script, { limit: 1 })
  const envelope = envelopes[0]
  if (!envelope || !envelope.valid || !envelope.bodyPresent) return null

  const contentType = envelope.fields.get('01')?.toString('utf8') ?? null
  return detectToken({ body: envelope.body, contentType, outpoint })
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
