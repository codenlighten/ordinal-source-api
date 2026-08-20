import { createHash } from 'node:crypto'
import { BODY_KEY } from './envelope.js'

/**
 * Ordinal envelope fields. Keys are the hex of the field's push bytes
 * (`OP_1`-`OP_16` normalise to a single byte first). `''` is the body marker.
 * Unknown fields are still parsed and returned - this table only supplies
 * friendly names and default renderings for the ones the spec names.
 */
export const FIELD_DEFS = [
  { key: BODY_KEY, name: 'content', encoding: 'auto', aliases: ['body', 'data', 'file', 'payload'] },
  { key: '01', name: 'contentType', encoding: 'utf8', aliases: ['content_type', 'mime', 'mimetype', 'ct', 'type'] },
  { key: '02', name: 'pointer', encoding: 'number', aliases: [] },
  { key: '03', name: 'parent', encoding: 'id', aliases: [] },
  { key: '05', name: 'metadata', encoding: 'hex', aliases: ['meta'] },
  { key: '07', name: 'metaprotocol', encoding: 'utf8', aliases: ['protocol'] },
  { key: '09', name: 'contentEncoding', encoding: 'utf8', aliases: ['content_encoding'] },
  { key: '0b', name: 'delegate', encoding: 'id', aliases: [] }
]

const byKey = new Map(FIELD_DEFS.map((f) => [f.key, f]))
export const fieldDefByKey = (key) => byKey.get(key)

function normalize (s) {
  return String(s).trim().toLowerCase().replace(/[-_\s]/g, '')
}

const nameIndex = new Map()
for (const def of FIELD_DEFS) {
  nameIndex.set(normalize(def.name), def)
  for (const alias of def.aliases) nameIndex.set(normalize(alias), def)
}

/**
 * Resolves a selector to an envelope field: a name ("contentType"), an alias
 * ("content_type", "mime"), a field number ("1"), or a raw key in hex ("0x0b").
 * Returns null when the selector names no envelope field, which lets a caller
 * layer its own selectors on top without this module knowing about them.
 */
export function resolveField (selector) {
  const input = String(selector).trim()
  if (!input) throw new Error('empty field selector')
  const key = normalize(input)

  const def = nameIndex.get(key)
  if (def) return { type: 'field', key: def.key, name: def.name, def }

  if (/^\d+$/.test(input)) {
    const n = Number.parseInt(input, 10)
    if (n < 0 || n > 255) throw new Error(`field number out of range: ${input}`)
    const hex = n.toString(16).padStart(2, '0')
    const known = byKey.get(hex)
    return { type: 'field', key: hex, name: known ? known.name : `field_${n}`, def: known }
  }

  const hexMatch = /^(?:0x|hex:)?([0-9a-f]{2,})$/i.exec(input)
  if (hexMatch && hexMatch[1].length % 2 === 0) {
    const hex = hexMatch[1].toLowerCase()
    const known = byKey.get(hex)
    return { type: 'field', key: hex, name: known ? known.name : `field_0x${hex}`, def: known }
  }

  return null
}

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|ecmascript|xhtml\+xml|[\w.-]+\+json)|image\/svg\+xml)/i

export const isTextualContentType = (ct) => !!ct && TEXTUAL.test(String(ct).trim())

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

/** Returns the utf8 text of a buffer when it round-trips and looks printable. */
export function printableText (buf) {
  const text = buf.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(buf)) return undefined
  return CONTROL.test(text) ? undefined : text
}

/**
 * Renders field bytes for JSON. `auto` picks a sensible shape per field: text
 * for text-ish values, a number for pointers, base64 for binary bodies.
 */
export function encodeValue (buf, encoding = 'auto', { contentType, isBody = false } = {}) {
  if (buf == null) return null
  switch (encoding) {
    case 'hex':
      return buf.toString('hex')
    case 'base64':
      return buf.toString('base64')
    case 'utf8':
    case 'text':
      return buf.toString('utf8')
    case 'json':
      try {
        return JSON.parse(buf.toString('utf8'))
      } catch {
        return buf.toString('utf8')
      }
    case 'number':
      return buf.length === 0 ? 0 : Number(buf.readUIntLE(0, Math.min(buf.length, 6)))
    case 'id': {
      // Inscription references are either a `txid_vout` string or raw bytes.
      const text = printableText(buf)
      return text && text.includes('_') ? text : buf.toString('hex')
    }
    case 'binary':
      return buf
    case 'auto':
    default:
      if (isBody) {
        return isTextualContentType(contentType) ? buf.toString('utf8') : buf.toString('base64')
      }
      return printableText(buf) ?? buf.toString('hex')
  }
}

/** Reports which encoding `auto` actually used, so responses are self-describing. */
export function effectiveEncoding (encoding, { def, isBody = false, contentType, buf } = {}) {
  if (encoding && encoding !== 'auto') return encoding
  if (def && def.encoding && def.encoding !== 'auto') return def.encoding
  if (isBody) return isTextualContentType(contentType) ? 'utf8' : 'base64'
  return buf && printableText(buf) !== undefined ? 'utf8' : 'hex'
}

export const VALID_ENCODINGS = new Set([
  'auto', 'utf8', 'text', 'hex', 'base64', 'json', 'number', 'id', 'binary'
])

export function getByPath (obj, path) {
  return path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), obj)
}
