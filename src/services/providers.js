/**
 * Raw-transaction sources. Each provider returns the full serialized transaction
 * so this API can verify the txid itself rather than trusting a source's parsing.
 * A provider's `parse` receives the response body as a Buffer and returns the
 * raw transaction bytes.
 *
 * Some providers can also serve a single output script, which avoids pulling a
 * multi-megabyte inscription transaction just to read one outpoint. That path
 * cannot report the output's satoshi value, so it is opt-in.
 */

/**
 * Parsers return raw transaction BYTES. Nothing is converted to a hex string on
 * the way in: an inscription can be a video or an audio file, and holding one as
 * hex doubles its footprint for no benefit.
 */
const asHex = (buf) => {
  const text = buf.toString('utf8').trim()
  if (!/^[0-9a-fA-F]+$/.test(text) || text.length % 2 !== 0) {
    throw new Error(`expected hex, got ${JSON.stringify(text.slice(0, 80))}`)
  }
  return Buffer.from(text, 'hex')
}

const asBinary = (buf) => buf

export const PROVIDERS = {
  /** GorillaPool - the 1Sat Ordinals indexer. Mainnet only. */
  gorillapool: {
    name: 'gorillapool',
    networks: ['main'],
    tx: { url: ({ txid }) => `https://ordinals.gorillapool.io/api/tx/${txid}/raw`, parse: asBinary }
  },

  /** Junglebus (GorillaPool) - base64 transaction inside JSON. Mainnet only. */
  junglebus: {
    name: 'junglebus',
    networks: ['main'],
    tx: {
      url: ({ txid }) => `https://junglebus.gorillapool.io/v1/transaction/get/${txid}`,
      parse: (buf) => {
        const body = JSON.parse(buf.toString('utf8'))
        if (!body || !body.transaction) throw new Error('no transaction field in response')
        return Buffer.from(body.transaction, 'base64')
      }
    }
  },

  whatsonchain: {
    name: 'whatsonchain',
    networks: ['main', 'test'],
    tx: {
      url: ({ txid, network }) => `https://api.whatsonchain.com/v1/bsv/${network}/tx/${txid}/hex`,
      parse: asHex
    },
    output: {
      url: ({ txid, vout, network }) =>
        `https://api.whatsonchain.com/v1/bsv/${network}/tx/${txid}/out/${vout}/hex`,
      parse: asHex
    }
  },

  bitails: {
    name: 'bitails',
    networks: ['main', 'test'],
    headers: () => (process.env.BITAILS_API_KEY ? { apikey: process.env.BITAILS_API_KEY } : {}),
    tx: {
      url: ({ txid, network }) => `${bitailsHost(network)}/download/tx/${txid}/hex`,
      parse: asHex
    },
    output: {
      url: ({ txid, vout, network }) =>
        `${bitailsHost(network)}/download/tx/${txid}/output/${vout}/hex`,
      parse: asHex
    }
  }
}

function bitailsHost (network) {
  return `https://${network === 'test' ? 'test-api' : 'api'}.bitails.io`
}

export const DEFAULT_ORDER = ['gorillapool', 'whatsonchain', 'bitails', 'junglebus']

export const providerNames = () => Object.keys(PROVIDERS)

/**
 * Resolves a comma-separated provider list to provider objects, keeping only
 * those that serve the requested network and support the requested fetch mode.
 */
export function resolveProviders (list, network, mode = 'tx') {
  const names = (Array.isArray(list) ? list : String(list || '').split(','))
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean)

  const requested = names.length ? names : DEFAULT_ORDER
  const unknown = requested.filter((n) => !PROVIDERS[n])
  if (unknown.length) throw new Error(`unknown provider(s): ${unknown.join(', ')}`)

  const usable = requested
    .map((n) => PROVIDERS[n])
    .filter((p) => p.networks.includes(network) && p[mode])

  if (!usable.length) {
    throw new Error(
      names.length
        ? `none of the requested providers can serve ${mode} data on ${network}`
        : `no provider serves ${mode} data on the ${network} network`
    )
  }
  return usable
}
