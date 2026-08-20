/**
 * @smartledger/ordinals - the 1Sat Ordinals protocol in pure functions.
 *
 * Everything here works on transaction bytes and scripts alone: no network, no
 * database, no framework. That is what lets the same code back an API, an
 * indexer, a wallet, or a test.
 */

export {
  Opcode,
  Script,
  chunkBytes,
  isDataPush,
  isFieldChunk,
  isOp,
  isSmallNum,
  isValueChunk,
  scriptFromChunks,
  toScript
} from './script.js'

export { BODY_KEY, parseEnvelopes } from './envelope.js'

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
} from './fields.js'

export { applyDeploy, classifyToken, detectToken } from './token.js'

export {
  ZERO_HASH,
  followBackward,
  followForward,
  inputAtOffset,
  inputOutpoint,
  inputSpending,
  outputAtOffset,
  outputOffset,
  totalOutputValue
} from './ordinalMath.js'

export {
  TXID_RE,
  assertTxid,
  formatOutpoint,
  parseOutpoint,
  parseVout
} from './outpoint.js'

export { inscriptionAt, tokenAt, tokenOutputs } from './inscription.js'
