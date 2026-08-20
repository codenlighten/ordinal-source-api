import { config } from '../config.js'
import { BODY_KEY, parseEnvelopes } from '@smartledger/ordinals'
import {
  effectiveEncoding,
  encodeValue,
  fieldDefByKey,
  printableText,
  sha256
} from './fields.js'
import { formatOutpoint } from './outpoint.js'
import { detectToken } from '@smartledger/ordinals'
import { Opcode, chunkBytes, scriptFromChunks } from '@smartledger/ordinals'

const labelFor = (key, def) => {
  if (def) return def.name
  return key === BODY_KEY ? 'content' : `0x${key}`
}

/** Splits the non-envelope remainder into a locking script and any OP_RETURN data. */
function splitLock (lockScript) {
  const chunks = lockScript.chunks
  const cut = chunks.findIndex((c) => c.opcodenum === Opcode.OP_RETURN && !c.buf)
  if (cut === -1) return { lock: lockScript, opReturn: null }

  const lock = scriptFromChunks(chunks.slice(0, cut))
  const pushes = chunks
    .slice(cut + 1)
    .map((c) => chunkBytes(c))
    .filter((b) => b != null)
    .map((b) => ({ hex: b.toString('hex'), text: printableText(b), size: b.length }))

  return { lock, opReturn: { map: parseMap(pushes), pushes } }
}

const MAP_PREFIX = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'

/**
 * Magic Attribute Protocol - the OP_RETURN convention 1Sat uses to tag an
 * ordinal with metadata (app, type, collection, geohash...). Only the SET
 * command is decoded; anything else is left to the raw pushes.
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

function describeLock (lockScript, network) {
  const hex = lockScript.toHex()
  if (!hex) return { type: 'none', hex: '', asm: '', address: null }

  let address = null
  try {
    const a = lockScript.toAddress(network === 'test' ? 'testnet' : 'livenet')
    address = a ? String(a) : null
    if (address === 'false') address = null
  } catch {
    address = null
  }

  return { type: lockScript.classify(), hex, asm: lockScript.toASM(), address }
}

function renderEnvelope (env, opts, outpoint) {
  const contentTypeBuf = env.fields.get('01')
  const contentType = contentTypeBuf ? contentTypeBuf.toString('utf8') : null
  const bodyBuf = opts.concatBody ? env.bodyConcat : env.body

  const fields = {}
  const named = {}

  for (const [key, buf] of env.fields) {
    const isBody = key === BODY_KEY
    const value = isBody ? bodyBuf ?? buf : buf
    const def = fieldDefByKey(key)
    const name = labelFor(key, def)
    const tooBig = isBody && value.length > opts.maxInlineContentBytes
    const encoding = effectiveEncoding(opts.encoding, { def, isBody, contentType, buf: value })

    fields[name] = {
      key: key === BODY_KEY ? 'OP_0' : `0x${key}`,
      name,
      size: value.length,
      encoding,
      truncated: tooBig || undefined,
      value: tooBig ? null : encodeValue(value, encoding, { contentType, isBody }),
      occurrences: (env.occurrences.get(key) || []).length
    }

    // Spec-named fields are also surfaced at the top level for convenience.
    if (def && !isBody) named[def.name] = fields[name].value
  }

  const token = detectToken({ body: bodyBuf, contentType, outpoint })

  const inscription = {
    envelopeIndex: env.index,
    valid: env.valid,
    terminated: env.terminated,
    isToken: Boolean(token),
    token,
    ...named,
    contentType: contentType ?? null,
    contentLength: bodyBuf ? bodyBuf.length : 0,
    contentHash: bodyBuf ? sha256(bodyBuf) : null,
    content: fields.content ? fields.content.value : null,
    contentEncodingUsed: fields.content ? fields.content.encoding : null,
    contentTruncated: fields.content?.truncated ?? false,
    // Large media is never inlined into JSON - fetch the bytes from here.
    contentUrl: `/v1/outpoint/${outpoint}/content`,
    bodyParts: env.bodyParts.length,
    fields,
    warnings: env.warnings,
    errors: env.errors
  }

  return { inscription, bodyBuf, contentType }
}

/**
 * Builds the response view for one output plus the raw buffers behind it (used
 * by the /content endpoint and by ?raw=1 field selection).
 *
 * Only the first envelope in an output produces a 1SatOrdinal; later ones are
 * reported under `ignoredEnvelopes` because the spec says they MUST be ignored.
 */
export function buildOutputView ({
  txid,
  vout,
  satoshis = null,
  script,
  network = config.network,
  options = {}
}) {
  const opts = {
    encoding: options.encoding || 'auto',
    includeAsm: options.includeAsm === true,
    includeAll: options.includeAll === true,
    concatBody: options.concatBody === true,
    maxInlineContentBytes: options.maxInlineContentBytes ?? config.maxInlineContentBytes
  }

  const parsed = parseEnvelopes(script, { limit: config.maxEnvelopesPerOutput })
  const { lock, opReturn } = splitLock(parsed.lock)
  const outpoint = formatOutpoint(txid, vout)
  const warnings = []

  const first = parsed.envelopes[0] || null
  const rendered = first ? renderEnvelope(first, opts, outpoint) : null

  if (parsed.envelopes.length > 1) {
    warnings.push(
      `${parsed.envelopes.length} ord envelopes in this output; only the first can be an ordinal`
    )
  }
  if (rendered && satoshis != null && satoshis !== 1) {
    warnings.push(`output holds ${satoshis} satoshis; a 1SatOrdinal must be a 1 satoshi output`)
  }
  if (satoshis == null) {
    warnings.push('satoshi value unknown for this output; ordinality could not be confirmed')
  }

  const view = {
    txid,
    vout,
    outpoint,
    network,
    satoshis,
    hasInscription: Boolean(rendered),
    isOrdinal: rendered ? (satoshis == null ? null : satoshis === 1 && rendered.inscription.valid) : false,
    inscription: rendered ? rendered.inscription : null,
    lock: describeLock(lock, network),
    opReturn,
    script: {
      hex: parsed.script.toHex(),
      size: parsed.script.toBuffer().length,
      ...(opts.includeAsm ? { asm: parsed.script.toASM() } : {})
    },
    envelopeCount: parsed.envelopes.length,
    ignoredEnvelopes: parsed.envelopes.length > 1 ? parsed.envelopes.length - 1 : 0,
    warnings
  }

  if (opts.includeAll && parsed.envelopes.length > 1) {
    view.otherInscriptions = parsed.envelopes
      .slice(1)
      .map((env) => renderEnvelope(env, opts, outpoint).inscription)
  }

  const raw = {
    body: rendered ? rendered.bodyBuf : null,
    contentType: rendered ? rendered.contentType : null,
    fields: first ? first.fields : new Map(),
    bodyParts: first ? first.bodyParts : [],
    script: parsed.script
  }

  return { view, raw }
}

/** Builds views for every output of a transaction. */
export function buildTransactionView (tx, { network, options = {}, vout } = {}) {
  const outputs = []
  tx.outputs.forEach((output, index) => {
    if (vout != null && index !== vout) return
    outputs.push(
      buildOutputView({
        txid: tx.hash,
        vout: index,
        satoshis: output.satoshis,
        script: output.script,
        network,
        options
      })
    )
  })
  return outputs
}
