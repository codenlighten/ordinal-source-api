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

/** Selectors that read from the assembled output view rather than the envelope. */
const META_SELECTORS = {
  txid: 'txid',
  vout: 'vout',
  index: 'vout',
  n: 'vout',
  outpoint: 'outpoint',
  network: 'network',
  satoshis: 'satoshis',
  sats: 'satoshis',
  value: 'satoshis',
  isordinal: 'isOrdinal',
  hasinscription: 'hasInscription',
  valid: 'inscription.valid',
  terminated: 'inscription.terminated',
  contentlength: 'inscription.contentLength',
  contentsize: 'inscription.contentLength',
  size: 'inscription.contentLength',
  contenthash: 'inscription.contentHash',
  sha256: 'inscription.contentHash',
  hash: 'inscription.contentHash',
  fields: 'inscription.fields',
  inscription: 'inscription',
  inscriptions: 'inscriptions',
  script: 'script.hex',
  scripthex: 'script.hex',
  asm: 'script.asm',
  scriptasm: 'script.asm',
  lock: 'lock',
  lockingscript: 'lock',
  lockhex: 'lock.hex',
  lockasm: 'lock.asm',
  address: 'lock.address',
  owner: 'lock.address',
  warnings: 'warnings',
  map: 'opReturn.map',
  opreturn: 'opReturn',

  // Token fields, present when the inscription content is a bsv-20 document.
  token: 'inscription.token',
  istoken: 'inscription.isToken',
  standard: 'inscription.token.standard',
  tokenop: 'inscription.token.op',
  op: 'inscription.token.op',
  tokenid: 'inscription.token.id',
  tick: 'inscription.token.tick',
  ticker: 'inscription.token.tick',
  sym: 'inscription.token.symbol',
  symbol: 'inscription.token.symbol',
  amt: 'inscription.token.amount',
  amount: 'inscription.token.amount',
  amountdisplay: 'inscription.token.amountDisplay',
  dec: 'inscription.token.decimals',
  decimals: 'inscription.token.decimals',
  max: 'inscription.token.max',
  supply: 'inscription.token.max',

  // Chain-position fields, filled in by an indexer (?origin=1 or on selection).
  ordinal: 'ordinal',
  role: 'ordinal.role',
  origin: 'ordinal.genesis.outpoint',
  genesis: 'ordinal.genesis.outpoint',
  originnumber: 'ordinal.genesis.number',
  originnum: 'ordinal.genesis.number',
  genesisowner: 'ordinal.genesis.owner',
  current: 'ordinal.current.outpoint',
  currentoutpoint: 'ordinal.current.outpoint',
  currentowner: 'ordinal.current.owner',
  holder: 'ordinal.current.owner',
  spent: 'ordinal.queried.spent',
  spentin: 'ordinal.queried.spentIn',
  height: 'ordinal.queried.height'
}

function normalize (s) {
  return String(s).trim().toLowerCase().replace(/[-_\s]/g, '')
}

const nameIndex = new Map()
for (const def of FIELD_DEFS) {
  nameIndex.set(normalize(def.name), def)
  for (const alias of def.aliases) nameIndex.set(normalize(alias), def)
}

/**
 * Resolves a `?field=` selector to either an envelope field or a view path.
 * Accepts names ("contentType", "content_type", "data"), field numbers ("1",
 * "5"), or raw field keys in hex ("0x0b", "hex:6f7264").
 */
export function resolveSelector (selector) {
  const input = String(selector).trim()
  if (!input) throw new Error('empty field selector')
  const key = normalize(input)

  const def = nameIndex.get(key)
  if (def) return { type: 'field', key: def.key, name: def.name, def }

  const path = META_SELECTORS[key]
  if (path) return { type: 'view', name: input.replace(/[-_\s]/g, ''), path }

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

  throw new Error(`unknown field selector: ${selector}`)
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
