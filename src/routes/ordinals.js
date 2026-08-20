import { Router } from 'express'
import bsv from '@smartledger/bsv'
import { config } from '../config.js'
import { ApiError } from '../lib/errors.js'
import { FIELD_DEFS } from '../lib/fields.js'
import { buildOutputView, buildTransactionView } from '../lib/inscription.js'
import { formatOutpoint, parseOutpoint, parseVout } from '../lib/outpoint.js'
import { applyDeploy } from '../lib/token.js'
import { assertEncoding, parseSelectors, projectOutput, selectBytes } from '../lib/select.js'
import { traceOrdinal } from '../services/indexer.js'
import { DEFAULT_ORDER, PROVIDERS } from '../services/providers.js'
import { assertTxid, cacheStats, fetchOutputScript, fetchTransaction } from '../services/txProvider.js'

const { Transaction } = bsv
const router = Router()

const bool = (v, fallback = false) => {
  if (v == null || v === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())
}

function readQuery (req) {
  const network = String(req.query.network || config.network).toLowerCase()
  if (!['main', 'test'].includes(network)) {
    throw ApiError.badRequest(`invalid network: ${network}`, { valid: ['main', 'test'] })
  }

  const maxInline = req.query.maxContent != null ? Number(req.query.maxContent) : undefined
  if (maxInline != null && (!Number.isFinite(maxInline) || maxInline < 0)) {
    throw ApiError.badRequest(`invalid maxContent: ${req.query.maxContent}`)
  }

  return {
    network,
    providers: req.query.providers ?? req.query.provider,
    encoding: assertEncoding(req.query.encoding && String(req.query.encoding).toLowerCase()),
    selectors: parseSelectors(req.query.field ?? req.query.fields),
    raw: bool(req.query.raw),
    withOrigin: bool(req.query.origin),
    resolveToken: bool(req.query.resolveToken ?? req.query.deploy),
    fast: bool(req.query.fast),
    inscribedOnly: bool(req.query.inscribed),
    tokensOnly: bool(req.query.tokens),
    options: {
      encoding: assertEncoding(req.query.encoding && String(req.query.encoding).toLowerCase()),
      includeAsm: bool(req.query.asm),
      includeAll: bool(req.query.all),
      concatBody: bool(req.query.concat),
      maxInlineContentBytes: maxInline
    }
  }
}

/** Serves a selected field as its own body rather than wrapped in JSON. */
function sendRawValue (res, view, raw, selectors, q) {
  if (selectors.length !== 1) {
    throw ApiError.badRequest('raw=1 requires exactly one field selector')
  }
  const [selector] = selectors

  if (selector.type === 'view') {
    const projected = projectOutput(view, raw, selectors, q)
    return res.type('text/plain').send(String(projected.value ?? ''))
  }

  const bytes = selectBytes(raw, selector, { concatBody: q.options.concatBody })
  if (bytes == null) throw ApiError.notFound(`field ${selector.name} is not present`)

  if (q.encoding === 'hex' || q.encoding === 'base64') {
    return res.type('text/plain').send(bytes.toString(q.encoding))
  }
  const isBody = selector.key === ''
  const type = isBody && raw.contentType ? raw.contentType : 'application/octet-stream'
  res.set('content-type', type)
  res.set('content-length', String(bytes.length))
  return res.send(bytes)
}

/** Chain position needs an indexer, so it is fetched on request or on selection. */
const needsTrace = (q) =>
  q.withOrigin ||
  q.selectors.some((s) => s.type === 'view' && (s.path === 'ordinal' || s.path.startsWith('ordinal.')))

async function withTrace (view, q) {
  if (!needsTrace(q)) return view
  const ordinal = await traceOrdinal(view.outpoint, { network: q.network })
  return { ...view, ordinal }
}

/** GET /v1/tx/:txid - every output, or one field of every output. */
router.get('/tx/:txid', async (req, res, next) => {
  try {
    const q = readQuery(req)
    const txid = assertTxid(req.params.txid)
    const fetched = await fetchTransaction(txid, { network: q.network, providers: q.providers })

    let outputs = buildTransactionView(fetched.tx, { network: q.network, options: q.options })
    if (q.inscribedOnly) outputs = outputs.filter((o) => o.view.hasInscription)
    if (q.tokensOnly) outputs = outputs.filter((o) => o.view.inscription?.isToken)

    res.json({
      txid,
      network: q.network,
      source: fetched.source,
      cached: fetched.cached,
      outputCount: fetched.tx.outputs.length,
      inscriptionCount: outputs.filter((o) => o.view.hasInscription).length,
      ordinalCount: outputs.filter((o) => o.view.isOrdinal === true).length,
      tokenCount: outputs.filter((o) => o.view.inscription?.isToken).length,
      outputs: outputs.map(({ view, raw }) => projectOutput(view, raw, q.selectors, q))
    })
  } catch (err) {
    next(err)
  }
})

/** Resolves a single output, optionally without downloading the whole tx. */
async function resolveOutput (txid, vout, q) {
  if (q.fast) {
    const fetched = await fetchOutputScript(txid, vout, {
      network: q.network,
      providers: q.providers
    })
    const built = buildOutputView({
      txid,
      vout,
      satoshis: null, // an output-only fetch carries no value
      script: fetched.scriptHex,
      network: q.network,
      options: q.options
    })
    return { ...built, source: fetched.source, cached: fetched.cached }
  }

  let fetched
  try {
    fetched = await fetchTransaction(txid, { network: q.network, providers: q.providers })
  } catch (err) {
    // Only reachable when an operator has set MAX_TX_BYTES. One output is all
    // this request needs, so fetch just that rather than failing outright.
    if (err.code !== 'too_large') throw err
    return resolveOutput(txid, vout, { ...q, fast: true })
  }

  const output = fetched.tx.outputs[vout]
  if (!output) {
    throw ApiError.notFound(
      `output ${formatOutpoint(txid, vout)} does not exist`,
      { outputCount: fetched.tx.outputs.length }
    )
  }
  const built = buildOutputView({
    txid,
    vout,
    satoshis: output.satoshis,
    script: output.script,
    network: q.network,
    options: q.options
  })
  return { ...built, source: fetched.source, cached: fetched.cached }
}

/**
 * A transfer states an amount but not the token's precision or symbol - those
 * live on the deploy it points at. Opt in with ?resolveToken=1 to fetch it.
 */
async function withTokenDeploy (view, q) {
  const token = view.inscription?.token
  if (!q.resolveToken || !token || !token.id || token.decimals != null) return view
  if (token.id === view.outpoint) return view

  try {
    const { txid, vout } = parseOutpoint(token.id)
    const deploy = await resolveOutput(txid, vout, { ...q, resolveToken: false })
    const deployToken = deploy.view.inscription?.token
    if (!deployToken) throw new Error(`no token inscription at ${token.id}`)
    return {
      ...view,
      inscription: { ...view.inscription, token: applyDeploy(token, deployToken) }
    }
  } catch (err) {
    return {
      ...view,
      warnings: [...view.warnings, `could not resolve the deploy at ${token.id}: ${err.message}`]
    }
  }
}

async function outputHandler (req, res, next, { txid, vout }) {
  try {
    const q = readQuery(req)
    const { view, raw, source, cached } = await resolveOutput(txid, vout, q)

    const resolved = await withTokenDeploy(view, q)
    if (q.raw) return sendRawValue(res, resolved, raw, q.selectors, q)

    const enriched = await withTrace(resolved, q)
    res.json({ source, cached, ...projectOutput(enriched, raw, q.selectors, q) })
  } catch (err) {
    next(err)
  }
}

/** GET /v1/outpoint/:outpoint - `<txid>_<vout>` (also accepts : . -). */
router.get('/outpoint/:outpoint', (req, res, next) => {
  let parsed
  try {
    parsed = parseOutpoint(req.params.outpoint)
  } catch (err) {
    return next(err)
  }
  return outputHandler(req, res, next, parsed)
})

/** GET /v1/tx/:txid/out/:vout */
router.get('/tx/:txid/out/:vout', (req, res, next) => {
  let target
  try {
    target = { txid: assertTxid(req.params.txid), vout: parseVout(req.params.vout) }
  } catch (err) {
    return next(err)
  }
  return outputHandler(req, res, next, target)
})

/**
 * GET /v1/ordinal/:outpoint - resolve an ordinal from any point in its chain.
 *
 * Works starting from either end: give it the genesis outpoint and it reports
 * the current holder, give it the current outpoint and it reports the genesis.
 * The output view returned is the genesis one, because that is where the
 * inscription lives; `ordinal.queried` says which outpoint was asked about.
 */
router.get('/ordinal/:outpoint', async (req, res, next) => {
  try {
    const q = readQuery(req)
    const asked = parseOutpoint(req.params.outpoint)
    const askedOutpoint = formatOutpoint(asked.txid, asked.vout)

    const ordinal = await traceOrdinal(askedOutpoint, { network: q.network })
    const genesis = ordinal.genesis?.outpoint
      ? parseOutpoint(ordinal.genesis.outpoint)
      : asked

    if (!ordinal.genesis) {
      ordinal.warning = 'no indexer could resolve the origin; showing the queried outpoint itself'
    }

    const { view, raw, source, cached } = await resolveOutput(genesis.txid, genesis.vout, q)
    const resolved = await withTokenDeploy(view, q)
    const enriched = { ...resolved, ordinal: { ...ordinal, queried: { outpoint: askedOutpoint, ...(ordinal.queried || {}) } } }

    if (q.raw) return sendRawValue(res, enriched, raw, q.selectors, q)
    res.json({ source, cached, ...projectOutput(enriched, raw, q.selectors, q) })
  } catch (err) {
    next(err)
  }
})

/** Content endpoints - the inscription body with its own content-type. */
async function contentHandler (req, res, next, { txid, vout }) {
  try {
    const q = readQuery(req)
    const { view, raw } = await resolveOutput(txid, vout, q)
    if (!view.hasInscription || !raw.body) {
      throw ApiError.notFound(`no inscription content at ${formatOutpoint(txid, vout)}`)
    }
    const body = q.options.concatBody && raw.bodyParts.length > 1
      ? Buffer.concat(raw.bodyParts)
      : raw.body

    res.set('content-type', raw.contentType || 'application/octet-stream')
    res.set('content-length', String(body.length))
    res.set('cache-control', 'public, max-age=31536000, immutable')
    res.send(body)
  } catch (err) {
    next(err)
  }
}

router.get('/outpoint/:outpoint/content', (req, res, next) => {
  let parsed
  try {
    parsed = parseOutpoint(req.params.outpoint)
  } catch (err) {
    return next(err)
  }
  return contentHandler(req, res, next, parsed)
})

router.get('/tx/:txid/out/:vout/content', (req, res, next) => {
  let target
  try {
    target = { txid: assertTxid(req.params.txid), vout: parseVout(req.params.vout) }
  } catch (err) {
    return next(err)
  }
  return contentHandler(req, res, next, target)
})

/** POST /v1/parse - parse a raw transaction or a bare output script offline. */
router.post('/parse', (req, res, next) => {
  try {
    const q = readQuery(req)
    const { rawtx, script, satoshis, txid, vout } = req.body || {}

    if (rawtx) {
      const tx = new Transaction(String(rawtx).trim())
      let outputs = buildTransactionView(tx, { network: q.network, options: q.options })
      if (q.inscribedOnly) outputs = outputs.filter((o) => o.view.hasInscription)
      if (q.tokensOnly) outputs = outputs.filter((o) => o.view.inscription?.isToken)
      return res.json({
        txid: tx.hash,
        network: q.network,
        source: 'request',
        outputCount: tx.outputs.length,
        inscriptionCount: outputs.filter((o) => o.view.hasInscription).length,
        outputs: outputs.map(({ view, raw }) => projectOutput(view, raw, q.selectors, q))
      })
    }

    if (script) {
      const built = buildOutputView({
        txid: txid ? assertTxid(txid) : '0'.repeat(64),
        vout: vout != null ? parseVout(vout) : 0,
        satoshis: satoshis != null ? Number(satoshis) : null,
        script: String(script).trim(),
        network: q.network,
        options: q.options
      })
      return res.json({
        source: 'request',
        ...projectOutput(built.view, built.raw, q.selectors, q)
      })
    }

    throw ApiError.badRequest('provide either a rawtx or a script in the request body')
  } catch (err) {
    next(err)
  }
})

/** GET /v1/fields - self-documenting selector list. */
router.get('/fields', (_req, res) => {
  res.json({
    envelopeFields: FIELD_DEFS.map((f) => ({
      key: f.key === '' ? 'OP_0' : `0x${f.key}`,
      name: f.name,
      aliases: f.aliases,
      defaultEncoding: f.encoding
    })),
    unknownFields: 'select any other field by number (?field=13) or hex (?field=0x0d)',
    outputFields: [
      'txid', 'vout', 'outpoint', 'network', 'satoshis', 'isOrdinal', 'hasInscription',
      'valid', 'contentLength', 'contentHash', 'fields', 'inscription', 'script', 'asm',
      'lock', 'lockHex', 'lockAsm', 'address', 'map', 'opReturn', 'warnings',
      'contentTruncated', 'contentUrl'
    ],
    tokenFields: [
      'token', 'isToken', 'standard', 'op', 'tokenId', 'tick', 'symbol',
      'amount', 'amountDisplay', 'decimals', 'max'
    ],
    chainFields: {
      fields: [
        'ordinal', 'role', 'origin', 'originNumber', 'genesisOwner',
        'current', 'currentOwner', 'holder', 'spent', 'spentIn', 'height'
      ],
      note: 'sourced from an indexer; fetched with ?origin=1 or when selected'
    },
    encodings: ['auto', 'utf8', 'hex', 'base64', 'json', 'number', 'id', 'binary']
  })
})

/** GET /v1/providers - configured sources and cache state. */
router.get('/providers', (_req, res) => {
  res.json({
    order: DEFAULT_ORDER,
    providers: Object.values(PROVIDERS).map((p) => ({
      name: p.name,
      networks: p.networks,
      modes: ['tx', 'output'].filter((m) => p[m])
    })),
    indexers: ['gorillapool', 'whatsonchain'],
    cache: cacheStats()
  })
})

export default router
