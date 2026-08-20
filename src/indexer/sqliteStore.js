import { BALANCE, SPEND, TOKEN, UTXO, splitBalanceKey } from './store.js'

/**
 * A durable store on SQLite, using Node's built-in `node:sqlite`.
 *
 * No native dependency and no build step - which matters for a thing meant to
 * be run, not packaged. The trade is availability: `node:sqlite` arrived in
 * Node 22.5, so on older runtimes `open()` refuses rather than pretending, and
 * the in-memory store remains the fallback.
 *
 * Same four record kinds as MemoryStore, same rollback contract. The undo log
 * lives in the database too, so the reorg window survives a restart instead of
 * resetting to nothing every time the process starts.
 */

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS records (
    kind  TEXT NOT NULL,
    key   TEXT NOT NULL,
    value TEXT NOT NULL,
    owner TEXT,
    token TEXT,
    PRIMARY KEY (kind, key)
  );
  CREATE INDEX IF NOT EXISTS records_owner ON records (kind, owner);
  CREATE INDEX IF NOT EXISTS records_token ON records (kind, token);

  CREATE TABLE IF NOT EXISTS blocks (
    height   INTEGER PRIMARY KEY,
    hash     TEXT NOT NULL,
    previous TEXT,
    undo     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );
`

export async function sqliteAvailable () {
  try {
    await import('node:sqlite')
    return true
  } catch {
    return false
  }
}

export class SqliteStore {
  constructor (db, { undoDepth = 200 } = {}) {
    this.db = db
    this.undoDepth = undoDepth
    this.db.exec(SCHEMA)
    this.statements = {
      get: db.prepare('SELECT value FROM records WHERE kind = ? AND key = ?'),
      put: db.prepare(
        'INSERT INTO records (kind, key, value, owner, token) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT (kind, key) DO UPDATE SET value = excluded.value'
      ),
      del: db.prepare('DELETE FROM records WHERE kind = ? AND key = ?'),
      byKind: db.prepare('SELECT value FROM records WHERE kind = ?'),
      byOwner: db.prepare('SELECT key, value FROM records WHERE kind = ? AND owner = ?'),
      byToken: db.prepare('SELECT key, value FROM records WHERE kind = ? AND token = ?'),
      count: db.prepare('SELECT COUNT(*) AS n FROM records WHERE kind = ?'),
      pushBlock: db.prepare(
        'INSERT OR REPLACE INTO blocks (height, hash, previous, undo) VALUES (?, ?, ?, ?)'
      ),
      lastBlock: db.prepare(
        'SELECT height, hash, previous, undo FROM blocks ORDER BY height DESC LIMIT 1'
      ),
      firstHeight: db.prepare('SELECT MIN(height) AS h FROM blocks'),
      blockAt: db.prepare('SELECT hash FROM blocks WHERE height = ?'),
      dropBlock: db.prepare('DELETE FROM blocks WHERE height = ?'),
      trimBlocks: db.prepare('DELETE FROM blocks WHERE height <= ?'),
      blockCount: db.prepare('SELECT COUNT(*) AS n FROM blocks'),
      setMeta: db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)'),
      getMeta: db.prepare('SELECT v FROM meta WHERE k = ?')
    }
  }

  /** Opens a database file, or refuses on a runtime without node:sqlite. */
  static async open (path, options = {}) {
    let sqlite
    try {
      sqlite = await import('node:sqlite')
    } catch {
      throw new Error(
        'node:sqlite is unavailable on this runtime (needs Node 22.5+); ' +
        'use the JSON snapshot store instead'
      )
    }
    const db = new sqlite.DatabaseSync(path)
    db.exec('PRAGMA journal_mode = WAL')
    return new SqliteStore(db, options)
  }

  get (kind, key) {
    const row = this.statements.get.get(kind, key)
    return row ? JSON.parse(row.value) : null
  }

  /** Balance rows carry owner and token as columns so they can be queried. */
  #columns (kind, key) {
    if (kind !== BALANCE) return [null, null]
    const { owner, tokenKey } = splitBalanceKey(key)
    return [owner, tokenKey]
  }

  apply (writes) {
    const before = []
    this.db.exec('BEGIN')
    try {
      for (const { kind, key, value } of writes) {
        const existing = this.statements.get.get(kind, key)
        before.push({ kind, key, value: existing ? JSON.parse(existing.value) : undefined })

        if (value === undefined) {
          this.statements.del.run(kind, key)
        } else {
          const [owner, token] = this.#columns(kind, key)
          this.statements.put.run(kind, key, JSON.stringify(value), owner, token)
        }
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return before
  }

  revert (before) {
    this.db.exec('BEGIN')
    try {
      for (let i = before.length - 1; i >= 0; i--) {
        const { kind, key, value } = before[i]
        if (value === undefined) {
          this.statements.del.run(kind, key)
        } else {
          const [owner, token] = this.#columns(kind, key)
          this.statements.put.run(kind, key, JSON.stringify(value), owner, token)
        }
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  commitBlock ({ height, hash, previousHash = null, before }) {
    this.statements.pushBlock.run(height, hash, previousHash, JSON.stringify(before))
    const count = this.statements.blockCount.get().n
    if (count > this.undoDepth) {
      const oldest = this.statements.firstHeight.get().h
      this.statements.trimBlocks.run(oldest + (count - this.undoDepth) - 1)
    }
    this.statements.setMeta.run('cursor', JSON.stringify({ height, hash }))
  }

  rollbackBlock () {
    const last = this.statements.lastBlock.get()
    if (!last) return null

    this.revert(JSON.parse(last.undo))
    this.statements.dropBlock.run(last.height)

    const previous = this.statements.lastBlock.get()
    // As in MemoryStore: fall back to the rolled-back block's named parent, so
    // the fit check survives the undo log emptying.
    const cursor = previous
      ? { height: previous.height, hash: previous.hash }
      : { height: last.height - 1, hash: last.previous ?? null }
    this.statements.setMeta.run('cursor', JSON.stringify(cursor))
    return { height: last.height, hash: last.hash }
  }

  safeHeight () {
    return this.statements.firstHeight.get().h ?? null
  }

  blockHashAt (height) {
    const hash = this.statements.blockAt.get(height)?.hash
    if (hash) return hash
    const cursor = this.getCursor()
    return cursor?.height === height ? cursor.hash : null
  }

  getCursor () {
    const row = this.statements.getMeta.get('cursor')
    if (!row || row.v === 'null') return null
    return JSON.parse(row.v)
  }

  stats () {
    return {
      tokens: this.statements.count.get(TOKEN).n,
      utxos: this.statements.count.get(UTXO).n,
      spends: this.statements.count.get(SPEND).n,
      balances: this.statements.count.get(BALANCE).n,
      undoDepth: this.statements.blockCount.get().n,
      cursor: this.getCursor()
    }
  }

  tokens () {
    return this.statements.byKind
      .all(TOKEN)
      .map((row) => JSON.parse(row.value))
      .sort((a, b) => b.height - a.height)
  }

  balancesOf (owner) {
    return this.statements.byOwner
      .all(BALANCE, owner)
      .map((row) => ({ tokenKey: splitBalanceKey(row.key).tokenKey, amount: JSON.parse(row.value) }))
      .filter((held) => BigInt(held.amount) > 0n)
  }

  holdersOf (tokenKey) {
    return this.statements.byToken
      .all(BALANCE, tokenKey)
      .map((row) => ({ owner: splitBalanceKey(row.key).owner, amount: JSON.parse(row.value) }))
      .filter((held) => BigInt(held.amount) > 0n)
      .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1))
  }

  close () {
    this.db.close()
  }
}
