import {
  formatOutpoint,
  parseOutpoint as parseCore,
  parseVout as parseVoutCore,
  TXID_RE
} from '@smartledger/ordinals'
import { ApiError } from './errors.js'

/** The core throws plain errors; the API answers with a status code. */
const wrap = (run) => {
  try {
    return run()
  } catch (err) {
    throw ApiError.badRequest(err.message)
  }
}

export const parseOutpoint = (input) => wrap(() => parseCore(input))
export const parseVout = (input) => wrap(() => parseVoutCore(input))

export { formatOutpoint, TXID_RE }
