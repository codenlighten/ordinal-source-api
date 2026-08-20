import assert from 'node:assert/strict'
import test from 'node:test'
import bsv from '@smartledger/bsv'
import { buildOutputView } from '../src/lib/inscription.js'
import { parseOutpoint } from '../src/lib/outpoint.js'
import { parseSelectors, projectOutput } from '../src/lib/select.js'
import { concatScripts, envelope, p2pkh } from './helpers.js'

const { Opcode } = bsv

const TXID = 'a'.repeat(64)

const sample = (options = {}) =>
  buildOutputView({
    txid: TXID,
    vout: 0,
    satoshis: 1,
    script: concatScripts(
      p2pkh(),
      envelope({
        fields: [
          [Opcode.OP_1, Buffer.from('application/json')],
          [Opcode.OP_2, Buffer.from([5, 0])],
          [Opcode.OP_3, Buffer.from('b'.repeat(64) + '_2')],
          [Opcode.OP_7, Buffer.from('bsv-20')]
        ],
        body: Buffer.from('{"p":"bsv-20"}')
      })
    ),
    network: 'main',
    options
  })

test('outpoint accepts the 1Sat id form and common separators', () => {
  for (const sep of ['_', ':', '.', '-']) {
    assert.deepEqual(parseOutpoint(`${TXID}${sep}7`), { txid: TXID, vout: 7 })
  }
  assert.throws(() => parseOutpoint('nope_0'), /invalid outpoint/)
})

test('builds a view with named fields and 1-satoshi ordinality', () => {
  const { view } = sample()
  assert.equal(view.isOrdinal, true)
  assert.equal(view.inscription.contentType, 'application/json')
  assert.equal(view.inscription.pointer, 5) // little-endian number
  assert.equal(view.inscription.metaprotocol, 'bsv-20')
  assert.equal(view.inscription.parent, `${'b'.repeat(64)}_2`)
  assert.equal(view.lock.address, '1FHy8WBx1ZhQ2T86ZftxZUjbiBMQ6dNxeJ')
})

test('a multi-satoshi output with an envelope is not an ordinal', () => {
  const { view } = buildOutputView({
    txid: TXID,
    vout: 0,
    satoshis: 2,
    script: envelope({
      fields: [[Opcode.OP_1, Buffer.from('text/plain')]],
      body: Buffer.from('hi')
    })
  })
  assert.equal(view.hasInscription, true)
  assert.equal(view.isOrdinal, false)
  assert.match(view.warnings.join(' '), /1 satoshi output/)
})

test('selects a single field by name, alias, number, and hex', () => {
  const { view, raw } = sample()
  for (const selector of ['contentType', 'content_type', 'mime', '1', '0x01']) {
    const out = projectOutput(view, raw, parseSelectors(selector), {})
    assert.equal(out.value, 'application/json', selector)
    assert.equal(out.key, '0x01')
  }
})

test('selects several fields at once, mixing envelope and output data', () => {
  const { view, raw } = sample()
  const out = projectOutput(view, raw, parseSelectors('contentType,address,satoshis,isOrdinal'), {})
  assert.deepEqual(out.fields, {
    contentType: 'application/json',
    address: '1FHy8WBx1ZhQ2T86ZftxZUjbiBMQ6dNxeJ',
    satoshis: 1,
    isOrdinal: true
  })
})

test('encoding overrides how a value is rendered', () => {
  const { view, raw } = sample()
  const asJson = projectOutput(view, raw, parseSelectors('content'), { encoding: 'json' })
  assert.deepEqual(asJson.value, { p: 'bsv-20' })

  const asHex = projectOutput(view, raw, parseSelectors('content'), { encoding: 'hex' })
  assert.equal(asHex.value, Buffer.from('{"p":"bsv-20"}').toString('hex'))
})

test('a missing field selects as null rather than failing', () => {
  const { view, raw } = sample()
  const out = projectOutput(view, raw, parseSelectors('delegate'), {})
  assert.equal(out.value, null)
})

test('bodies over the inline limit are omitted and flagged', () => {
  const { view } = buildOutputView({
    txid: TXID,
    vout: 0,
    satoshis: 1,
    script: envelope({
      fields: [[Opcode.OP_1, Buffer.from('image/png')]],
      body: Buffer.alloc(2048, 7)
    }),
    options: { maxInlineContentBytes: 1024 }
  })
  assert.equal(view.inscription.content, null)
  assert.equal(view.inscription.contentTruncated, true)
  assert.equal(view.inscription.contentLength, 2048)
})
