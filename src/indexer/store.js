/**
 * Storage for a token-only index.
 *
 * The interface is deliberately small - four kinds of record - so a real
 * database can be dropped in behind it:
 *
 *   utxo    outpoint -> a live token output (which token, how much, whose)
 *   token   tokenKey -> the deploy: supply, limits, precision
 *   spend   outpoint -> the transaction that spent it. This is the forward
 *           index, the one thing an API cannot compute for itself and has to
 *           ask an indexer for. Only token outputs are recorded, which keeps it
 *           bounded rather than chain-sized.
 *   balance owner + token -> holdings, so a wallet can be answered directly
 *
 * Every write goes through `apply`, which captures the previous value first, so
 * a block can be rolled back on a reorg without re-reading the chain.
 */

export const UTXO = 'utxo'
export const TOKEN = 'token'
export const SPEND = 'spend'
export const BALANCE = 'balance'

const SEP = '|'

export const balanceKey = (owner, tokenKey) => `${owner}${SEP}${tokenKey}`
export const splitBalanceKey = (key) => {
  const at = key.indexOf(SEP)
  return { owner: key.slice(0, at), tokenKey: key.slice(at + 1) }
}

/** In-memory store: the reference implementation, and what the tests use. */
export class MemoryStore {
  constructor ({ undoDepth = 20 } = {}) {
    this.maps = {
      [UTXO]: new Map(),
      [TOKEN]: new Map(),
      [SPEND]: new Map(),
      [BALANCE]: new Map()
    }
    this.cursor = null
    this.undo = []
    this.undoDepth = undoDepth
  }

  get (kind, key) {
    return this.maps[kind].get(key) ?? null
  }

  /** Applies a batch of writes, capturing the previous values for rollback. */
  apply (writes) {
    const before = []
    for (const { kind, key, value } of writes) {
      const map = this.maps[kind]
      before.push({ kind, key, value: map.has(key) ? map.get(key) : undefined })
      if (value === undefined) map.delete(key)
      else map.set(key, value)
    }
    return before
  }

  /** Restores captured values in reverse, undoing a block. */
  revert (before) {
    for (let i = before.length - 1; i >= 0; i--) {
      const { kind, key, value } = before[i]
      if (value === undefined) this.maps[kind].delete(key)
      else this.maps[kind].set(key, value)
    }
  }

  commitBlock ({ height, hash, previousHash = null, before }) {
    this.undo.push({ height, hash, previousHash, before })
    while (this.undo.length > this.undoDepth) this.undo.shift()
    this.cursor = { height, hash }
  }

  /**
   * Rolls back the most recent block. The cursor moves to that block's parent -
   * named, not merely implied - so the next block is still checked for fit
   * after the undo log empties, rather than the check silently going away.
   */
  rollbackBlock () {
    const last = this.undo.pop()
    if (!last) return null
    this.revert(last.before)

    const previous = this.undo[this.undo.length - 1]
    this.cursor = previous
      ? { height: previous.height, hash: previous.hash }
      : { height: last.height - 1, hash: last.previousHash ?? null }
    return last
  }

  /**
   * The oldest height still reversible. A reorg deeper than this cannot be
   * undone from the undo log, which is a resync, not a rollback.
   */
  safeHeight () {
    return this.undo.length ? this.undo[0].height : null
  }

  blockHashAt (height) {
    const entry = this.undo.find((e) => e.height === height)
    if (entry) return entry.hash
    // The cursor knows its own hash even once its undo entry has been trimmed.
    return this.cursor?.height === height ? this.cursor.hash : null
  }

  getCursor () {
    return this.cursor
  }

  stats () {
    return {
      tokens: this.maps[TOKEN].size,
      utxos: this.maps[UTXO].size,
      spends: this.maps[SPEND].size,
      balances: this.maps[BALANCE].size,
      undoDepth: this.undo.length,
      cursor: this.cursor
    }
  }

  /** Every token record, most recently deployed first. */
  tokens () {
    return [...this.maps[TOKEN].values()].sort((a, b) => b.height - a.height)
  }

  balancesOf (owner) {
    const held = []
    for (const [key, amount] of this.maps[BALANCE]) {
      const parts = splitBalanceKey(key)
      if (parts.owner === owner && BigInt(amount) > 0n) {
        held.push({ tokenKey: parts.tokenKey, amount })
      }
    }
    return held
  }

  /** A portable snapshot, so an index can outlive the process that built it. */
  toJSON () {
    return {
      version: 1,
      cursor: this.cursor,
      [TOKEN]: [...this.maps[TOKEN]],
      [UTXO]: [...this.maps[UTXO]],
      [SPEND]: [...this.maps[SPEND]],
      [BALANCE]: [...this.maps[BALANCE]]
    }
  }

  static fromJSON (data) {
    const store = new MemoryStore()
    if (data.version !== 1) throw new Error(`unsupported index version: ${data.version}`)
    for (const kind of [TOKEN, UTXO, SPEND, BALANCE]) {
      store.maps[kind] = new Map(data[kind] ?? [])
    }
    store.cursor = data.cursor ?? null
    return store
  }

  holdersOf (tokenKey) {
    const holders = []
    for (const [key, amount] of this.maps[BALANCE]) {
      const parts = splitBalanceKey(key)
      if (parts.tokenKey === tokenKey && BigInt(amount) > 0n) {
        holders.push({ owner: parts.owner, amount })
      }
    }
    return holders.sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1))
  }
}
