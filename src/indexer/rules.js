import bsv from '@smartledger/bsv'
import { formatOutpoint, inputOutpoint, tokenOutputs } from '@smartledger/ordinals'
import { BALANCE, SPEND, TOKEN, UTXO, balanceKey } from './store.js'

/**
 * The token state machine: one transaction, applied in block order.
 *
 * This is where the limits the API has to declare become decidable. Asked about
 * a single transaction in isolation, "has this ticker already been claimed" and
 * "does this mint exceed supply" are unanswerable. Processed in order with a
 * store behind it, they are just lookups:
 *
 *   ticker priority  the first deploy of a ticker wins, and every later one is
 *                    rejected, because by then the first is already recorded
 *   supply limits    mints accumulate against the deploy's max, and the mint
 *                    that crosses it is filled to the fraction that fits
 *   input validity   only valid outputs were ever written, so an input found in
 *                    the store is valid by construction - no assumption left
 *
 * Pure apart from the store reads: it returns the writes to make rather than
 * making them, which is what allows a block to be rolled back on a reorg.
 */

const { Script } = bsv

const isAuth = (token) => token.op === 'auth' || token.op === 'deploy+auth'
const isDeploy = (token) => token.op.startsWith('deploy')

export const tokenKeyOf = (token) =>
  token.standard === 'BSV-20' ? `tick:${token.tickNormalized}` : token.id ?? null

/** Best-effort owner address; a non-standard lock simply has none. */
function ownerOf (script, network) {
  try {
    const address = script.toAddress(network === 'test' ? 'testnet' : 'livenet')
    const text = String(address)
    return text && text !== 'false' ? text : null
  } catch {
    return null
  }
}

/** Strips the inscription so the owner comes from the locking script alone. */
function lockOf (script) {
  const chunks = script.chunks
  const start = chunks.findIndex(
    (c, i) =>
      c.opcodenum === 0 &&
      chunks[i + 1]?.opcodenum === 99 &&
      chunks[i + 2]?.buf?.toString('utf8') === 'ord'
  )
  if (start === -1) return script
  let end = start
  while (end < chunks.length && chunks[end].opcodenum !== 104) end++
  const lock = new Script()
  chunks.forEach((chunk, i) => {
    if (i < start || i > end) lock.chunks.push(chunk)
  })
  return lock
}

const big = (value) => BigInt(value ?? 0)

/**
 * Applies one transaction. Returns the writes to perform and a record of what
 * happened, including operations that were rejected and why.
 */
export function applyTransaction (store, tx, { height, idx, network = 'main' } = {}) {
  const writes = []
  const events = []
  const txid = tx.hash

  // Inputs that are token outputs we already hold. Anything not in the store is
  // not a token input - only valid outputs were ever written.
  const spent = []
  tx.inputs.forEach((_input, index) => {
    const { outpoint, coinbase } = inputOutpoint(tx, index)
    if (coinbase) return
    const held = store.get(UTXO, outpoint)
    if (held) spent.push({ index, outpoint, ...held })
  })

  const outputs = tokenOutputs(tx)
  if (!spent.length && !outputs.length) return { writes: [], events: [] }

  // Balances are staged rather than written as we go, so a debit and a credit
  // in the same transaction see each other instead of both reading the value
  // the transaction started with.
  const staged = new Map()
  const adjust = (owner, key, delta) => {
    if (!owner || delta === 0n) return
    const bkey = balanceKey(owner, key)
    const current = staged.has(bkey) ? staged.get(bkey) : big(store.get(BALANCE, bkey))
    const next = current + delta
    staged.set(bkey, next > 0n ? next : 0n)
  }

  // Spending a token output consumes it, whatever the transaction then does.
  for (const input of spent) {
    writes.push({ kind: UTXO, key: input.outpoint, value: undefined })
    writes.push({ kind: SPEND, key: input.outpoint, value: txid })
    adjust(input.owner, input.tokenKey, -big(input.amount))
  }

  const keys = new Set([
    ...spent.map((i) => i.tokenKey),
    ...outputs.map((o) => tokenKeyOf(o.token)).filter(Boolean)
  ])

  for (const key of keys) {
    const inputs = spent.filter((i) => i.tokenKey === key)
    const creating = outputs.filter((o) => tokenKeyOf(o.token) === key)
    if (!creating.length) continue

    const authorised = inputs.some((i) => i.authority)
    // Drawn down as outputs are accepted, so two transfers of the same token in
    // one transaction cannot both spend the same balance.
    let remaining = inputs
      .filter((i) => !i.authority)
      .reduce((sum, i) => sum + big(i.amount), 0n)

    for (const output of creating) {
      const { token, vout, outpoint, satoshis } = output
      const reject = (reason) => events.push({ outpoint, op: token.op, accepted: false, reason })

      if (!token.wellFormed) {
        reject(`malformed document: ${token.errors.join('; ')}`)
        continue
      }
      if (satoshis !== 1) {
        reject(`output holds ${satoshis} satoshis; a token output must hold 1`)
        continue
      }

      const record = store.get(TOKEN, key)
      const owner = ownerOf(lockOf(tx.outputs[vout].script), network)
      let amount = 0n

      if (isDeploy(token)) {
        // First is first: a ticker already claimed cannot be claimed again.
        if (record) {
          reject(`${key} was already deployed at ${record.deployOutpoint}`)
          continue
        }
        amount = token.op === 'deploy+mint' ? big(token.amount) : 0n
        writes.push({
          kind: TOKEN,
          key,
          value: {
            tokenKey: key,
            standard: token.standard,
            tick: token.tick ?? null,
            id: token.standard === 'BSV-21' ? outpoint : null,
            symbol: token.symbol ?? null,
            decimals: token.decimals ?? 0,
            max: token.max ?? null,
            limit: token.limit ?? null,
            supply: amount.toString(),
            deployOutpoint: outpoint,
            height,
            idx
          }
        })
      } else if (token.op === 'mint') {
        if (!record) {
          reject(`${key} has not been deployed`)
          continue
        }
        if (token.standard === 'BSV-21' && !authorised) {
          reject('mint requires an auth input for this token')
          continue
        }
        const wanted = big(token.amount)
        if (record.limit && wanted > big(record.limit)) {
          reject(`mint of ${wanted} exceeds the per-mint limit of ${record.limit}`)
          continue
        }
        if (record.max) {
          const room = big(record.max) - big(record.supply)
          if (room <= 0n) {
            reject(`supply of ${record.max} is already fully minted`)
            continue
          }
          // The mint that crosses the cap is filled to the fraction that fits.
          amount = wanted > room ? room : wanted
          if (amount < wanted) {
            events.push({
              outpoint,
              op: token.op,
              accepted: true,
              partial: true,
              reason: `filled ${amount} of ${wanted}; only ${room} remained`
            })
          }
        } else {
          amount = wanted
        }
        writes.push({
          kind: TOKEN,
          key,
          value: { ...record, supply: (big(record.supply) + amount).toString() }
        })
      } else if (token.op === 'burn') {
        const takes = big(token.amount)
        if (takes > remaining) {
          reject(`burn of ${takes} exceeds the ${remaining} still carried by the inputs`)
          continue
        }
        remaining -= takes
        events.push({ outpoint, op: 'burn', accepted: true, amount: takes.toString() })
        writes.push({
          kind: TOKEN,
          key,
          value: record
            ? { ...record, burned: (big(record.burned) + takes).toString() }
            : record
        })
        continue // a burn output holds no spendable balance
      } else {
        // transfer
        const takes = big(token.amount)
        if (takes > remaining) {
          reject(`transfer of ${takes} exceeds the ${remaining} still carried by the inputs`)
          continue
        }
        remaining -= takes
        amount = takes
      }

      // Accepted: record the output as a live token UTXO.
      writes.push({
        kind: UTXO,
        key: outpoint,
        value: {
          tokenKey: key,
          standard: token.standard,
          op: token.op,
          amount: amount.toString(),
          authority: isAuth(token) || undefined,
          owner,
          height,
          idx,
          vout
        }
      })

      adjust(owner, key, amount)

      events.push({
        outpoint,
        op: token.op,
        accepted: true,
        tokenKey: key,
        amount: amount.toString(),
        owner
      })
    }
  }

  for (const [key, value] of staged) {
    writes.push({ kind: BALANCE, key, value: value.toString() })
  }

  return { writes, events, spent: spent.map((i) => i.outpoint) }
}

export { formatOutpoint }
