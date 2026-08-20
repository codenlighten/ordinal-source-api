import { ApiError } from './errors.js'
import { BODY_KEY } from '@smartledger/ordinals'
import {
  VALID_ENCODINGS,
  effectiveEncoding,
  encodeValue,
  fieldDefByKey,
  getByPath,
  resolveSelector
} from './fields.js'

/** Splits `?field=a,b` / repeated `?field=` params into resolved selectors. */
export function parseSelectors (param) {
  if (param == null || param === '') return []
  const raw = (Array.isArray(param) ? param : [param])
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter(Boolean)

  return raw.map((sel) => {
    try {
      return resolveSelector(sel)
    } catch (err) {
      throw ApiError.badRequest(err.message, { hint: 'GET /v1/fields lists every selector' })
    }
  })
}

export function assertEncoding (encoding) {
  if (encoding && !VALID_ENCODINGS.has(encoding)) {
    throw ApiError.badRequest(
      `invalid encoding: ${encoding}`,
      { valid: [...VALID_ENCODINGS] }
    )
  }
  return encoding || 'auto'
}

/** Raw bytes for a selected envelope field, or null when the field is absent. */
export function selectBytes (raw, selector, { concatBody = false } = {}) {
  if (selector.type !== 'field') return null
  if (selector.key === BODY_KEY) {
    if (concatBody && raw.bodyParts.length > 1) return Buffer.concat(raw.bodyParts)
    return raw.body
  }
  return raw.fields.get(selector.key) ?? null
}

/**
 * Projects an output view down to the requested selectors. A single selector
 * yields `{ field, value }`; several yield one key per selector.
 */
export function selectFields (view, raw, selectors, { encoding = 'auto', concatBody = false } = {}) {
  const out = {}

  for (const selector of selectors) {
    if (selector.type === 'view') {
      out[selector.name] = getByPath(view, selector.path) ?? null
      continue
    }

    const bytes = selectBytes(raw, selector, { concatBody })
    if (bytes == null) {
      out[selector.name] = null
      continue
    }

    const isBody = selector.key === BODY_KEY
    const def = selector.def ?? fieldDefByKey(selector.key)
    const contentType = raw.contentType
    const enc = effectiveEncoding(encoding, { def, isBody, contentType, buf: bytes })
    out[selector.name] = encodeValue(bytes, enc, { contentType, isBody })
  }

  return out
}

/** Shapes the response for a field-selected request. */
export function projectOutput (view, raw, selectors, opts) {
  if (!selectors.length) return view

  const values = selectFields(view, raw, selectors, opts)
  const base = { txid: view.txid, vout: view.vout, outpoint: view.outpoint }

  if (selectors.length === 1) {
    const [only] = selectors
    return {
      ...base,
      field: only.name,
      key: only.type === 'field' ? (only.key === BODY_KEY ? 'OP_0' : `0x${only.key}`) : undefined,
      value: values[only.name]
    }
  }
  return { ...base, fields: values }
}
