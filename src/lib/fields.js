import { FIELD_DEFS, resolveField } from '@smartledger/ordinals'

export {
  FIELD_DEFS,
  VALID_ENCODINGS,
  effectiveEncoding,
  encodeValue,
  fieldDefByKey,
  getByPath,
  isTextualContentType,
  printableText,
  resolveField,
  sha256
} from '@smartledger/ordinals'

/**
 * Selectors that read from the assembled output view rather than the envelope.
 * These are shaped by this API's response, which is why they live here and not
 * in the protocol core.
 */
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
  arrangement: 'inscription.arrangement',
  contentlength: 'inscription.contentLength',
  contentsize: 'inscription.contentLength',
  size: 'inscription.contentLength',
  contenthash: 'inscription.contentHash',
  contenttruncated: 'inscription.contentTruncated',
  contenturl: 'inscription.contentUrl',
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
  wellformed: 'inscription.token.wellFormed',
  tokenvalidation: 'tokenValidation',
  conserved: 'tokenValidation.conserved',
  conservation: 'tokenValidation.tokens',
  provenvalid: 'tokenValidation.proven',
  assuming: 'tokenValidation.assuming',
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

  // Re-inscription: the same satoshi inscribed again later in its chain.
  reinscription: 'ordinal.reinscription',
  reinscribed: 'ordinal.reinscription.reinscribed',
  reinscriptions: 'ordinal.reinscription.inscriptions',
  contentdiffers: 'ordinal.reinscription.contentDiffers',

  // Chain-position fields, filled in by an indexer (?origin=1 or on selection).
  ordinal: 'ordinal',
  role: 'ordinal.role',
  verified: 'ordinal.verified',
  verification: 'ordinal.verification',
  agreement: 'ordinal.verification.agreement',
  computedorigin: 'ordinal.verification.origin',
  computedcurrent: 'ordinal.verification.current',
  disagreement: 'ordinal.disagreement',
  burned: 'ordinal.verification.burned',
  hops: 'ordinal.verification.hops',
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

const normalize = (s) => String(s).trim().toLowerCase().replace(/[-_\s]/g, '')

/**
 * Resolves a `?field=` selector: an envelope field handled by the protocol
 * core, or one of this API's own view paths.
 */
export function resolveSelector (selector) {
  const input = String(selector).trim()
  if (!input) throw new Error('empty field selector')

  const path = META_SELECTORS[normalize(input)]
  if (path) return { type: 'view', name: input.replace(/[-_\s]/g, ''), path }

  const field = resolveField(input)
  if (field) return field

  throw new Error(`unknown field selector: ${selector}`)
}

export const fieldNames = () => FIELD_DEFS.map((f) => f.name)
