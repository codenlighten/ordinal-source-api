import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test, { after, before } from 'node:test'
import bsv from '@smartledger/bsv'
import { concatScripts, envelope, p2pkh, startApp } from './helpers.js'

const { Opcode } = bsv

let app
let rawtx

before(async () => {
  app = await startApp()
  rawtx = (await readFile(new URL('./fixtures/inscription-10f44.hex', import.meta.url), 'utf8')).trim()
})

after(async () => {
  await app.close()
})

test('GET /health reports the configured network', async () => {
  const body = await (await app.get('/health')).json()
  assert.equal(body.ok, true)
})

test('GET /v1/fields documents every selector', async () => {
  const body = await (await app.get('/v1/fields')).json()
  const names = body.envelopeFields.map((f) => f.name)
  assert.deepEqual(names.slice(0, 3), ['content', 'contentType', 'pointer'])
  assert.ok(body.outputFields.includes('outpoint'))
})

test('POST /v1/parse reads a raw transaction without any network call', async () => {
  const body = await (await app.post('/v1/parse', { rawtx })).json()
  assert.equal(body.txid, '10f4465cd18c39fbc7aa4089268e57fc719bf19c8c24f2e09156f4a89a2809d6')
  assert.equal(body.outputCount, 2)
  assert.equal(body.inscriptionCount, 1)

  const [first] = body.outputs
  assert.equal(first.satoshis, 1)
  assert.equal(first.isOrdinal, true)
  assert.equal(first.inscription.contentType, 'model/gltf-binary')
  assert.equal(first.inscription.contentLength, 2180)
  assert.equal(first.lock.address, '1FHy8WBx1ZhQ2T86ZftxZUjbiBMQ6dNxeJ')
  assert.equal(first.opReturn.map.app, 'ord-demo')
})

test('POST /v1/parse projects a chosen field across the outputs', async () => {
  const body = await (await app.post('/v1/parse?field=contentType&inscribed=1', { rawtx })).json()
  assert.equal(body.outputs.length, 1)
  assert.equal(body.outputs[0].field, 'contentType')
  assert.equal(body.outputs[0].value, 'model/gltf-binary')
})

test('POST /v1/parse accepts a bare output script', async () => {
  const script = concatScripts(
    p2pkh(),
    envelope({
      fields: [[Opcode.OP_1, Buffer.from('text/plain')]],
      body: Buffer.from('one sat')
    })
  ).toHex()

  const body = await (
    await app.post('/v1/parse?field=content&encoding=utf8', { script, satoshis: 1 })
  ).json()
  assert.equal(body.value, 'one sat')
})

test('an unknown field selector is a 400 with a hint', async () => {
  const res = await app.post('/v1/parse?field=banana', { rawtx })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.error.code, 'bad_request')
  assert.match(body.error.message, /unknown field selector/)
})

test('an invalid outpoint is rejected before any provider is contacted', async () => {
  const res = await app.get('/v1/outpoint/not-an-outpoint')
  assert.equal(res.status, 400)
  assert.match((await res.json()).error.message, /invalid outpoint/)
})

test('an invalid network is rejected', async () => {
  const res = await app.post('/v1/parse?network=regtest', { rawtx })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error.message, /invalid network/)
})

test('unknown routes return a structured 404', async () => {
  const res = await app.get('/v1/nope')
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error.code, 'not_found')
})

test('POST /v1/parse detects a BSV-21 token in an inscription', async () => {
  const script = concatScripts(
    p2pkh(),
    envelope({
      fields: [[Opcode.OP_1, Buffer.from('application/bsv-20')]],
      body: Buffer.from(JSON.stringify({ p: 'bsv-20', op: 'deploy+mint', sym: 'TEST', amt: '100', dec: '2' }))
    })
  ).toHex()

  const body = await (await app.post('/v1/parse', { script, satoshis: 1 })).json()
  assert.equal(body.inscription.isToken, true)
  assert.equal(body.inscription.token.standard, 'BSV-21')
  assert.equal(body.inscription.token.symbol, 'TEST')
  assert.equal(body.inscription.token.amountDisplay, '1')
})

test('token fields are selectable like any other field', async () => {
  const script = concatScripts(
    envelope({
      fields: [[Opcode.OP_1, Buffer.from('application/bsv-20')]],
      body: Buffer.from(JSON.stringify({ p: 'bsv-20', op: 'mint', tick: 'ORDI', amt: '1000' }))
    }),
    p2pkh()
  ).toHex()

  const body = await (
    await app.post('/v1/parse?field=standard,op,tick,amount,isToken', { script, satoshis: 1 })
  ).json()
  assert.deepEqual(body.fields, {
    standard: 'BSV-20',
    op: 'mint',
    tick: 'ORDI',
    amount: '1000',
    isToken: true
  })
})

test('a non-token inscription reports isToken false', async () => {
  const body = await (await app.post('/v1/parse?field=isToken,token&inscribed=1', { rawtx })).json()
  assert.equal(body.outputs[0].fields.isToken, false)
  assert.equal(body.outputs[0].fields.token, null)
})
