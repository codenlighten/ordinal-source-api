import { config } from '../config.js'

/**
 * Neither `origin` nor "who holds it now" can be derived from a single
 * transaction: origin is the first outpoint where the satoshi existed alone,
 * and the current holder is the unspent tip of the transfer chain. Both need a
 * chain-wide index, so these lookups sit beside the on-chain parse rather than
 * inside it, and never block a response when an indexer is down.
 */

const GORILLAPOOL = 'https://ordinals.gorillapool.io/api'

async function getJson (url, headers = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.rawTxTimeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', ...headers }
    })
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

const point = (d) =>
  d && d.outpoint
    ? {
        outpoint: d.outpoint,
        txid: d.txid ?? d.outpoint.split('_')[0],
        vout: d.vout ?? Number(d.outpoint.split('_')[1]),
        owner: d.owner ?? null,
        satoshis: d.satoshis ?? null,
        height: d.height ?? null,
        txIndex: d.idx != null ? Number(d.idx) : null,
        spent: Boolean(d.spend),
        spentIn: d.spend || null
      }
    : null

const INDEXERS = {
  /** GorillaPool indexes both directions: any outpoint -> origin, origin -> tip. */
  gorillapool: {
    name: 'gorillapool',
    networks: ['main'],
    async txo (outpoint) {
      const d = await getJson(`${GORILLAPOOL}/txos/${outpoint}`)
      return {
        queried: point(d),
        genesis: d.origin?.outpoint
          ? { outpoint: d.origin.outpoint, number: d.origin.num ?? null }
          : null,
        map: d.data?.map ?? null,
        inscription: d.data?.insc ?? null
      }
    },
    /** Only accepts an origin outpoint; other outpoints come back empty. */
    async latest (origin) {
      const d = await getJson(`${GORILLAPOOL}/inscriptions/${origin}/latest`)
      return point(d)
    }
  },

  /** WhatsOnChain's 1Sat index resolves origin, but not the current tip. */
  whatsonchain: {
    name: 'whatsonchain',
    networks: ['main', 'test'],
    async txo (outpoint, network) {
      const d = await getJson(
        `https://api.whatsonchain.com/v1/bsv/${network}/token/1satordinals/${outpoint}`
      )
      const t = d.token || {}
      return {
        queried: {
          outpoint: t.outpoint ?? outpoint,
          txid: (t.outpoint ?? outpoint).split('_')[0],
          vout: Number((t.outpoint ?? outpoint).split('_')[1]),
          owner: t.ownerAddress ?? null,
          satoshis: null,
          height: t.current?.blockHeight ?? null,
          txIndex: t.current?.txIndex ?? null,
          spent: Boolean(t.spentTxid),
          spentIn: t.spentTxid || null
        },
        genesis: t.origin?.outpoint
          ? { outpoint: t.origin.outpoint, number: t.origin.number ?? null, owner: t.origin.ownerAddress ?? null }
          : null,
        map: t.data?.map ?? null,
        inscription: t.data?.insc ?? null
      }
    },
    latest: null
  }
}

export const INDEXER_ORDER = ['gorillapool', 'whatsonchain']

const usable = (network) =>
  INDEXER_ORDER.map((n) => INDEXERS[n]).filter((i) => i.networks.includes(network))

/**
 * Traces an ordinal in both directions from any point in its transfer chain.
 * Pass the genesis outpoint and you get the current holder; pass the current
 * outpoint and you get the genesis - the lookup is the same either way.
 */
export async function traceOrdinal (outpoint, { network = config.network } = {}) {
  const attempts = []

  for (const indexer of usable(network)) {
    try {
      const base = await indexer.txo(outpoint, network)
      const genesisOutpoint = base.genesis?.outpoint ?? null

      let genesis = base.genesis
      let current = null

      if (genesisOutpoint === outpoint) {
        // Queried the genesis itself, so its own details are already in hand.
        genesis = { ...genesis, ...base.queried }
      } else if (genesisOutpoint && indexer.txo) {
        try {
          const g = await indexer.txo(genesisOutpoint, network)
          genesis = { ...genesis, ...g.queried }
        } catch (err) {
          attempts.push({ indexer: indexer.name, step: 'genesis', error: err.message })
        }
      }

      if (genesisOutpoint && indexer.latest) {
        try {
          current = await indexer.latest(genesisOutpoint, network)
        } catch (err) {
          attempts.push({ indexer: indexer.name, step: 'latest', error: err.message })
        }
      }
      // An unspent queried outpoint is itself the tip.
      if (!current && base.queried && !base.queried.spent) current = base.queried

      const role = !genesisOutpoint
        ? 'unknown'
        : outpoint === genesisOutpoint && outpoint === current?.outpoint
          ? 'genesis+current'
          : outpoint === genesisOutpoint
            ? 'genesis'
            : outpoint === current?.outpoint
              ? 'current'
              : 'transfer'

      return {
        role,
        queried: base.queried,
        genesis,
        current,
        map: base.map,
        indexer: indexer.name,
        // Everything above is the indexer's word. Unlike the inscription -
        // which is parsed from transaction bytes whose hash was checked - the
        // chain position is not verified against the chain by this API.
        verified: false,
        assertedBy: indexer.name,
        attempts
      }
    } catch (err) {
      attempts.push({ indexer: indexer.name, step: 'txo', error: err.message, status: err.status })
    }
  }

  return {
    role: 'unknown',
    genesis: null,
    current: null,
    verified: false,
    unavailable: true,
    attempts
  }
}

/**
 * "Which transaction spent this outpoint?" - the one question that cannot be
 * answered from a transaction alone, so it always needs an index. The answer is
 * checkable though: the named transaction either really does spend the outpoint
 * or it does not, and the verifier confirms that against raw bytes.
 *
 * Returns `{ spent: false }` when no index reports a spend. That is the one
 * claim this API cannot verify - absence of a spend is not provable from chain
 * data without a full index of its own - so callers should treat it as
 * unrefuted rather than proven.
 */
export async function lookupSpend (outpoint, { network = config.network } = {}) {
  const [txid, vout] = outpoint.split('_')
  const attempts = []

  const sources = [
    {
      name: 'whatsonchain',
      networks: ['main', 'test'],
      url: `https://api.whatsonchain.com/v1/bsv/${network}/tx/${txid}/${vout}/spent`,
      read: (d) => (d && d.txid ? { spent: true, spentIn: d.txid, vin: d.vin } : { spent: false })
    },
    {
      name: 'gorillapool',
      networks: ['main'],
      url: `${GORILLAPOOL}/txos/${outpoint}`,
      read: (d) => (d && d.spend ? { spent: true, spentIn: d.spend } : { spent: false })
    }
  ].filter((s) => s.networks.includes(network))

  for (const source of sources) {
    try {
      return { ...source.read(await getJson(source.url)), source: source.name, attempts }
    } catch (err) {
      // A 404 here is a positive answer: the index knows of no spend.
      if (err.status === 404) return { spent: false, source: source.name, attempts }
      attempts.push({ indexer: source.name, error: err.message, status: err.status })
    }
  }

  return { spent: null, unavailable: true, attempts }
}
