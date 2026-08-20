import {
  Opcode,
  chunkBytes,
  isFieldChunk,
  isOp,
  isValueChunk,
  scriptFromChunks,
  toScript
} from './script.js'

const ORD = Buffer.from('ord', 'utf8') // 0x6f7264
export const BODY_KEY = '' // the OP_0 <content> pair

/**
 * Tags the Ordinals spec names. Everything else is "unrecognized", and the spec
 * treats unrecognized tags by parity - the "it's okay to be odd" rule:
 *
 *   odd   ignored by an indexer that does not know it
 *   even  "inscriptions with unrecognized even fields must be displayed as
 *          unbound, that is, without a location"
 *
 * So a custom field on an even tag can cost an inscription its location in
 * conformant tooling, while the same data on an odd tag is simply skipped.
 * Worth saying out loud, because a parser that does not enforce it - this one
 * included - gives no hint that anything is wrong.
 */
const KNOWN_TAGS = new Set([0, 1, 2, 3, 5, 7, 9, 11])

const findEnvelopeStart = (chunks, from) => {
  for (let i = from; i + 2 < chunks.length; i++) {
    if (
      isOp(chunks[i], Opcode.OP_FALSE) &&
      isOp(chunks[i + 1], Opcode.OP_IF) &&
      chunks[i + 2].buf &&
      chunks[i + 2].buf.equals(ORD)
    ) {
      return i
    }
  }
  return -1
}

/**
 * Parses one `ord` envelope beginning at `start`:
 *
 *   OP_FALSE OP_IF "ord" <field1> <value1> ... <fieldN> <valueN> OP_0 <content> OP_ENDIF
 *
 * Every field/value pair is walked - parsing does not stop at content-type.
 * Repeated fields overwrite earlier values per the 1Sat spec, and each
 * overwrite is recorded so nothing is silently dropped.
 *
 * `OP_0` opens the body, which is the last element of an envelope. Anything
 * pushed after it is collected as an extra body part: BTC concatenates those
 * pushes (520-byte limit), while 1Sat says values are NOT concatenated, so the
 * first push is the body and the parts are reported for the caller to decide.
 */
function parseOne (chunks, start, index) {
  const fields = new Map() // key hex -> Buffer (last write wins)
  const occurrences = new Map() // key hex -> Buffer[] (every value seen, in order)
  const warnings = []
  const errors = []
  const bodyParts = []
  let bodyPresent = false
  let terminated = false
  let end = chunks.length

  const parityWarning = (key) => {
    // Single-byte keys are the tag encoding in practice.
    if (key.length !== 2) return null
    const tag = parseInt(key, 16)
    if (KNOWN_TAGS.has(tag) || tag % 2 === 1) return null
    return (
      `field ${tag} is an unrecognized even tag; the Ordinals spec says such an ` +
      'inscription must be treated as unbound, so an odd tag is the safe choice'
    )
  }

  const record = (key, value) => {
    const seen = occurrences.get(key)
    if (seen) {
      seen.push(value)
      warnings.push(`field 0x${key || '00'} repeated ${seen.length} times; last value wins`)
    } else {
      occurrences.set(key, [value])
      const parity = parityWarning(key)
      if (parity) warnings.push(parity)
    }
    fields.set(key, value)
  }

  let j = start + 3
  for (; j < chunks.length; j++) {
    const chunk = chunks[j]

    if (isOp(chunk, Opcode.OP_ENDIF)) {
      terminated = true
      end = j
      break
    }

    // Body marker: the rest of the envelope is content.
    if (isOp(chunk, Opcode.OP_0)) {
      if (bodyPresent) warnings.push('multiple OP_0 body markers; last body wins')
      bodyPresent = true
      bodyParts.length = 0
      for (j += 1; j < chunks.length; j++) {
        const part = chunks[j]
        if (isOp(part, Opcode.OP_ENDIF)) {
          terminated = true
          end = j
          break
        }
        if (!isValueChunk(part)) {
          errors.push(`unexpected opcode ${part.opcodenum} inside the body`)
          end = j
          break
        }
        bodyParts.push(chunkBytes(part))
      }
      if (bodyParts.length === 0) errors.push('body marker OP_0 is not followed by a push')
      if (bodyParts.length > 1) {
        warnings.push(
          `body split across ${bodyParts.length} pushes; 1Sat does not concatenate ` +
          'push data, so the first push is the content'
        )
      }
      break
    }

    const value = chunks[j + 1]
    if (!isFieldChunk(chunk)) {
      errors.push(`unexpected opcode ${chunk.opcodenum} where a field was expected`)
      end = j
      break
    }
    if (!isValueChunk(value)) {
      errors.push('field is not followed by a value push')
      end = j
      break
    }

    record(chunkBytes(chunk).toString('hex'), chunkBytes(value))
    j++
  }

  if (bodyPresent) {
    record(BODY_KEY, bodyParts[0] ?? Buffer.alloc(0))
  }
  if (!terminated) errors.push('envelope is not terminated by OP_ENDIF')

  return {
    index,
    start,
    end,
    terminated,
    bodyPresent,
    body: bodyParts[0] ?? null,
    bodyParts,
    bodyConcat: bodyParts.length > 1 ? Buffer.concat(bodyParts) : (bodyParts[0] ?? null),
    fields,
    occurrences,
    warnings,
    errors,
    valid: terminated && errors.length === 0,
    next: terminated ? end + 1 : chunks.length
  }
}

/**
 * Extracts every `ord` envelope inline in a script.
 * Per the 1Sat spec only the first valid envelope produces an ordinal; later
 * ones MUST be ignored, but they are returned here so callers can see them.
 */
export function parseEnvelopes (script, { limit = 16 } = {}) {
  const s = toScript(script)
  const chunks = s.chunks
  const envelopes = []

  let cursor = 0
  while (envelopes.length < limit) {
    const start = findEnvelopeStart(chunks, cursor)
    if (start === -1) break
    const env = parseOne(chunks, start, envelopes.length)
    envelopes.push(env)
    if (env.next <= start) break
    cursor = env.next
  }

  // The locking script is everything outside the envelopes, in any of the
  // spec's arrangements (prepended, appended, or split by OP_CODESEPARATOR).
  const inside = new Set()
  for (const env of envelopes) {
    const last = env.terminated ? env.end : chunks.length - 1
    for (let i = env.start; i <= last; i++) inside.add(i)
  }
  const lockChunks = chunks.filter((_, i) => !inside.has(i))

  return { script: s, envelopes, lock: scriptFromChunks(lockChunks) }
}
