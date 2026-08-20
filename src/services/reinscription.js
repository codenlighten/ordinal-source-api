import { inscriptionAt, sha256 } from '@smartledger/ordinals'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import { fetchOutputScript, fetchTransaction } from './txProvider.js'

/**
 * Re-inscription: the same satoshi inscribed again, later in its chain.
 *
 * The 1Sat spec allows it outright - "you can also append to the inscriptions
 * on an ordinal by inscribing the same sat again" - and says nothing about
 * which inscription then represents the ordinal. That silence is the problem
 * worth surfacing: a wallet rendering the origin and a wallet rendering the
 * current output can show completely different content for the same ordinal,
 * and neither is wrong.
 *
 * So this does not pick a winner. It reports every inscription found along the
 * chain, in order, and says plainly when the current one differs from the
 * origin.
 */

/** The parts of an inscription worth comparing between two points in a chain. */
export function summarize (script, outpoint) {
  const inscription = inscriptionAt(script, outpoint)
  if (!inscription) return null

  return {
    outpoint,
    contentType: inscription.contentType,
    contentLength: inscription.contentLength,
    contentHash: inscription.content ? sha256(inscription.content) : null,
    isToken: Boolean(inscription.token),
    contentUrl: `/v1/outpoint/${outpoint}/content`
  }
}

/**
 * Reads one output's inscription. Uses the single-output fetch where a provider
 * offers it, since pulling a whole transaction to look at one output is waste -
 * and a re-inscribed output tends to be large by definition.
 */
async function inscriptionOf (outpoint, { network, providers }) {
  const [txid, voutText] = outpoint.split('_')
  const vout = Number(voutText)

  try {
    const { scriptHex } = await fetchOutputScript(txid, vout, { network, providers })
    return summarize(scriptHex, outpoint)
  } catch (err) {
    logger.debug('output fetch failed, falling back to the transaction', {
      outpoint,
      error: err.message
    })
  }

  const { tx } = await fetchTransaction(txid, { network, providers })
  const output = tx.outputs[vout]
  return output ? summarize(output.script, outpoint) : null
}

const differs = (a, b) => {
  if (!a || !b) return false
  if (a.contentHash && b.contentHash) return a.contentHash !== b.contentHash
  return a.contentType !== b.contentType || a.contentLength !== b.contentLength
}

/**
 * Inspects the points of an ordinal's chain for inscriptions.
 *
 * `known` lets a caller hand in summaries it already has - the route has
 * already parsed the genesis output, so re-reading it would be pure cost.
 */
export async function inspectChain (
  { genesis, current, hops = [] },
  { network = config.network, providers, known = {} } = {}
) {
  const points = []
  const seen = new Set()

  const add = (outpoint, role) => {
    if (!outpoint || seen.has(outpoint)) return
    seen.add(outpoint)
    points.push({ outpoint, role })
  }

  add(genesis, 'genesis')
  for (const hop of hops) add(hop, 'transfer')
  add(current, 'current')

  const inscriptions = []
  const errors = []
  let fetched = 0

  for (const point of points) {
    try {
      const summary = known[point.outpoint] ?? await (async () => {
        fetched++
        return inscriptionOf(point.outpoint, { network, providers })
      })()
      if (summary) inscriptions.push({ ...summary, role: point.role })
    } catch (err) {
      errors.push({ outpoint: point.outpoint, error: err.message })
    }
  }

  const first = inscriptions.find((i) => i.role === 'genesis') ?? inscriptions[0] ?? null
  const last = inscriptions.find((i) => i.role === 'current') ?? null
  const later = inscriptions.filter((i) => i.role !== 'genesis')

  // Only the points that were looked at can be spoken for. Without a verified
  // walk that is the two ends, so a re-inscription in between is not ruled out.
  const checked = points.length
  const complete = hops.length > 0 || checked <= 2

  return {
    reinscribed: later.length > 0,
    count: inscriptions.length,
    contentDiffers: differs(first, last),
    inscriptions,
    checked: points.map((p) => p.outpoint),
    // What was NOT looked at, said out loud.
    coverage: complete && hops.length > 0
      ? 'every point in the chain'
      : 'the ends of the chain only; add verify=1 to walk every transfer',
    cost: { outputsFetched: fetched },
    errors
  }
}

/** A plain sentence for the case that actually trips people up. */
export function reinscriptionWarning (report) {
  if (!report?.contentDiffers) return null
  return (
    'this ordinal was inscribed again after its origin, and the current ' +
    'content differs from the original - which one is shown depends on ' +
    'whether a viewer resolves the origin or the current outpoint'
  )
}
