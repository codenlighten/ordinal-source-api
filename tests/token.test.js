import assert from 'node:assert/strict'
import test from 'node:test'
import { applyDeploy, classifyToken, detectToken } from '../src/lib/token.js'

const OUTPOINT = `${'3b'.repeat(32)}_0`
const TOKEN_ID = `${'a1'.repeat(32)}_1`
const body = (obj) => Buffer.from(JSON.stringify(obj))
const detect = (obj, contentType = 'application/bsv-20') =>
  detectToken({ body: body(obj), contentType, outpoint: OUTPOINT })

test('non-JSON and non-bsv-20 content is not a token', () => {
  assert.equal(detectToken({ body: Buffer.from('hello'), contentType: 'text/plain' }), null)
  assert.equal(detect({ p: 'map', op: 'set' }), null)
  assert.equal(detectToken({ body: Buffer.alloc(0), contentType: 'application/bsv-20' }), null)
})

test('image content is never parsed as JSON', () => {
  assert.equal(detectToken({ body: body({ p: 'bsv-20' }), contentType: 'image/png' }), null)
})

test('BSV-20 deploy is identified by its ticker', () => {
  const t = detect({ p: 'bsv-20', op: 'deploy', tick: 'ORDI', max: '21000000', lim: '1000' })
  assert.equal(t.standard, 'BSV-20')
  assert.equal(t.deprecated, true)
  assert.equal(t.tick, 'ORDI')
  assert.equal(t.tickNormalized, 'ordi') // tickers are case insensitive
  assert.equal(t.max, '21000000')
  assert.equal(t.limit, '1000')
  assert.equal(t.id, OUTPOINT) // a deploy claims the ticker at its own outpoint
  assert.equal(t.valid, true)
})

test('BSV-20 mint and transfer carry a ticker and an amount', () => {
  for (const op of ['mint', 'transfer']) {
    const t = detect({ p: 'bsv-20', op, tick: 'ORDI', amt: '1000' })
    assert.equal(t.standard, 'BSV-20')
    assert.equal(t.op, op)
    assert.equal(t.amount, '1000')
    assert.equal(t.valid, true)
  }
})

test('BSV-21 is identified by an id or a v2-only op', () => {
  const deployMint = detect({ p: 'bsv-20', op: 'deploy+mint', sym: 'RUNES', amt: '100', dec: '8' })
  assert.equal(deployMint.standard, 'BSV-21')
  assert.equal(deployMint.id, OUTPOINT) // the token id is where it was deployed
  assert.equal(deployMint.symbol, 'RUNES')
  assert.equal(deployMint.amountDisplay, '0.000001')

  const transfer = detect({ p: 'bsv-20', op: 'transfer', id: TOKEN_ID, amt: '100' })
  assert.equal(transfer.standard, 'BSV-21')
  assert.equal(transfer.id, TOKEN_ID)
})

test('auth operations carry authority, not an amount', () => {
  const auth = detect({ p: 'bsv-20', op: 'deploy+auth', sym: 'AUTH' })
  assert.equal(auth.standard, 'BSV-21')
  assert.equal(auth.authority, true)
  assert.equal(auth.valid, true)

  const withAmt = detect({ p: 'bsv-20', op: 'auth', id: TOKEN_ID, amt: '5' })
  assert.equal(withAmt.valid, false)
  assert.match(withAmt.errors.join(' '), /amt must not be present/)
})

test('invalid documents are reported rather than dropped', () => {
  assert.match(detect({ p: 'bsv-20', op: 'deploy', max: '1' }).errors.join(' '), /tick is required/)
  assert.match(detect({ p: 'bsv-20', op: 'deploy', tick: 'TOOLONG', max: '1' }).errors.join(' '), /4 characters/)
  assert.match(detect({ p: 'bsv-20', op: 'transfer', id: 'nope', amt: '1' }).errors.join(' '), /<txid>_<vout>/)
  assert.match(detect({ p: 'bsv-20', op: 'transfer', id: TOKEN_ID, amt: '1.5' }).errors.join(' '), /digits/)
  assert.match(detect({ p: 'bsv-20', op: 'mint', tick: 'A', amt: '1', dec: '20' }).errors.join(' '), /cannot exceed 18/)
  assert.equal(detect({ p: 'bsv-20', op: 'nonsense' }).standard, 'unknown')
})

test('an amount above uint64 max is rejected', () => {
  const t = detect({ p: 'bsv-20', op: 'transfer', id: TOKEN_ID, amt: '18446744073709551616' })
  assert.equal(t.valid, false)
  assert.match(t.errors.join(' '), /maximum/)
})

test('a text/plain token is detected but flagged', () => {
  const t = detect({ p: 'bsv-20', op: 'mint', tick: 'ORDI', amt: '1' }, 'text/plain;charset=utf-8')
  assert.equal(t.valid, true)
  assert.match(t.warnings.join(' '), /application\/bsv-20/)
})

test('a transfer reports unknown precision instead of assuming zero', () => {
  const t = detect({ p: 'bsv-20', op: 'transfer', id: TOKEN_ID, amt: '800000000' })
  assert.equal(t.decimals, null)
  assert.equal(t.amountDisplay, undefined)
  assert.equal(t.decimalsFrom, TOKEN_ID)

  const deploy = classifyToken(
    { p: 'bsv-20', op: 'deploy+mint', sym: 'BLASTER', amt: '1', dec: '8' },
    { outpoint: TOKEN_ID }
  )
  const resolved = applyDeploy(t, deploy)
  assert.equal(resolved.decimals, 8)
  assert.equal(resolved.symbol, 'BLASTER')
  assert.equal(resolved.amountDisplay, '8')
  assert.equal(resolved.resolvedFromDeploy, true)
})

test('unrecognised JSON fields are preserved but ignored', () => {
  const t = detect({ p: 'bsv-20', op: 'deploy+mint', amt: '1', contract: 'pow-20', difficulty: '3' })
  assert.equal(t.valid, true)
  assert.equal(t.json.contract, 'pow-20')
})
