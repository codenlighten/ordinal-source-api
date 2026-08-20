/**
 * BSV-20 and BSV-21 detection from inscription content.
 *
 * Both standards inscribe JSON with `"p":"bsv-20"` and both use the content
 * type `application/bsv-20`. They are told apart by their identifier:
 *
 *   BSV-20 (deprecated, "first is first")  ->  `tick`, a 4 character ticker
 *   BSV-21 (current)                       ->  `id`, the deploy outpoint
 *
 * Deploy operations carry no id: the token id IS the outpoint the inscription
 * is created at, so it is filled in from the outpoint being parsed.
 */

const UINT64_MAX = (1n << 64n) - 1n
const OUTPOINT_RE = /^[0-9a-fA-F]{64}_\d+$/

const BSV21_OPS = new Set(['deploy+mint', 'deploy+auth', 'mint', 'auth', 'transfer', 'burn'])
const BSV20_OPS = new Set(['deploy', 'mint', 'transfer'])

/** Content types worth attempting a JSON parse on. */
const PARSEABLE = /^(application\/bsv-20|text\/plain|application\/json|$)/i

function parseUint (value, { field, errors, max = UINT64_MAX }) {
  if (value == null) return null
  const text = String(value).trim()
  if (!/^\d+$/.test(text)) {
    errors.push(`${field} must be a string of digits, got ${JSON.stringify(value)}`)
    return null
  }
  const n = BigInt(text)
  if (n > max) {
    errors.push(`${field} exceeds the maximum of ${max}`)
    return null
  }
  return text
}

/** Renders a uint64 amount at the token's decimal precision. */
function display (amount, decimals) {
  if (amount == null) return null
  if (!decimals) return amount
  const padded = amount.padStart(decimals + 1, '0')
  const whole = padded.slice(0, -decimals)
  const fraction = padded.slice(-decimals).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

function parseDecimals (json, errors) {
  if (json.dec == null) return 0 // spec default, only meaningful on a deploy
  const text = String(json.dec).trim()
  if (!/^\d+$/.test(text)) {
    errors.push(`dec must be a whole number, got ${JSON.stringify(json.dec)}`)
    return 0
  }
  const dec = Number.parseInt(text, 10)
  if (dec > 18) {
    errors.push(`dec cannot exceed 18, got ${dec}`)
    return 18
  }
  return dec
}

function requireField (json, field, { errors, op }) {
  if (json[field] == null || String(json[field]).trim() === '') {
    errors.push(`${field} is required for op ${op}`)
    return false
  }
  return true
}

function prohibitField (json, field, { errors, op }) {
  if (json[field] != null) errors.push(`${field} must not be present for op ${op}`)
}

/**
 * Classifies parsed inscription JSON. Returns null when the content is not a
 * bsv-20 protocol document at all.
 */
export function classifyToken (json, { outpoint = null, contentType = null } = {}) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  if (String(json.p ?? '').trim().toLowerCase() !== 'bsv-20') return null

  const op = String(json.op ?? '').trim().toLowerCase()
  const errors = []
  const warnings = []

  const hasTick = json.tick != null && String(json.tick).trim() !== ''
  const hasId = json.id != null && String(json.id).trim() !== ''

  let standard
  if (op === 'deploy' || (BSV20_OPS.has(op) && hasTick && !hasId)) {
    standard = 'BSV-20'
  } else if (BSV21_OPS.has(op)) {
    standard = 'BSV-21'
  } else {
    return {
      standard: 'unknown',
      protocol: 'bsv-20',
      op: op || null,
      valid: false,
      errors: [`unrecognised op: ${JSON.stringify(json.op ?? null)}`],
      warnings,
      json
    }
  }

  if (contentType && !/^application\/bsv-20/i.test(contentType)) {
    warnings.push(
      `content type is ${contentType}; ${standard} inscriptions should use application/bsv-20`
    )
  }

  const decimals = parseDecimals(json, errors)
  const declaresDecimals = json.dec != null
  const deploys = op === 'deploy' || op === 'deploy+mint' || op === 'deploy+auth'
  const ctx = { errors, op }
  const token = {
    standard,
    protocol: 'bsv-20',
    deprecated: standard === 'BSV-20' || undefined,
    op,
    // Decimals are set by the deploy. A transfer that does not restate them
    // cannot be rendered at precision without resolving its token id first.
    decimals: deploys || declaresDecimals ? decimals : null
  }

  if (standard === 'BSV-20') {
    if (requireField(json, 'tick', ctx)) {
      const tick = String(json.tick).trim()
      token.tick = tick
      token.tickNormalized = tick.toLowerCase() // tickers are case insensitive
      if (Buffer.byteLength(tick, 'utf8') > 4) {
        errors.push(`tick must be 4 characters or fewer, got ${JSON.stringify(tick)}`)
      }
    }
    if (op === 'deploy') {
      if (requireField(json, 'max', ctx)) token.max = parseUint(json.max, { field: 'max', errors })
      if (json.lim != null) token.limit = parseUint(json.lim, { field: 'lim', errors })
      token.id = outpoint // a deploy defines the ticker at this outpoint
    } else {
      if (requireField(json, 'amt', ctx)) token.amount = parseUint(json.amt, { field: 'amt', errors })
    }
  } else {
    if (deploys) {
      // The token id is the outpoint this deployment is inscribed at.
      token.id = outpoint
      if (json.sym != null) token.symbol = String(json.sym)
      if (json.icon != null) token.icon = String(json.icon)
    } else if (requireField(json, 'id', ctx)) {
      const id = String(json.id).trim()
      token.id = id
      if (!OUTPOINT_RE.test(id)) errors.push(`id must be <txid>_<vout>, got ${JSON.stringify(id)}`)
    }

    if (op === 'deploy+auth' || op === 'auth') {
      token.authority = true
      prohibitField(json, 'amt', ctx) // auth outputs carry authority, not value
    } else if (requireField(json, 'amt', ctx)) {
      token.amount = parseUint(json.amt, { field: 'amt', errors })
    }
  }

  if (token.decimals != null) {
    if (token.amount != null) token.amountDisplay = display(token.amount, decimals)
    if (token.max != null) token.maxDisplay = display(token.max, decimals)
  } else {
    token.decimalsFrom = token.id // read precision from the deploy inscription
  }

  token.valid = errors.length === 0
  token.errors = errors
  token.warnings = warnings
  token.json = json
  return token
}

/** Fills in a transfer's missing precision from its resolved deploy token. */
export function applyDeploy (token, deploy) {
  if (!token || !deploy || deploy.decimals == null) return token
  const decimals = deploy.decimals
  return {
    ...token,
    decimals,
    decimalsFrom: deploy.id ?? token.decimalsFrom,
    symbol: token.symbol ?? deploy.symbol,
    tick: token.tick ?? deploy.tick,
    amountDisplay: token.amount != null ? display(token.amount, decimals) : undefined,
    resolvedFromDeploy: true
  }
}

/**
 * Detects a token from an inscription body. Only JSON-bearing content types are
 * attempted, so image and model inscriptions are not parsed needlessly.
 */
export function detectToken ({ body, contentType, outpoint = null } = {}) {
  if (!body || body.length === 0) return null
  if (contentType && !PARSEABLE.test(String(contentType).trim())) return null
  // A bsv-20 document is small; anything large is a file, not a token.
  if (body.length > 4096) return null

  const text = body.toString('utf8').trim()
  if (!text.startsWith('{')) return null

  let json
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  return classifyToken(json, { outpoint, contentType })
}
