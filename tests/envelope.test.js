import assert from 'node:assert/strict'
import test from 'node:test'
import bsv from '@smartledger/bsv'
import { parseEnvelopes } from '../src/lib/envelope.js'
import { concatScripts, envelope, p2pkh } from './helpers.js'

const { Opcode, Script } = bsv
const text = (buf) => (buf ? buf.toString('utf8') : null)

test('parses a minimal content-type + body envelope', () => {
  const { envelopes } = parseEnvelopes(
    envelope({ fields: [[Opcode.OP_1, Buffer.from('text/plain')]], body: Buffer.from('hello') })
  )
  assert.equal(envelopes.length, 1)
  const [env] = envelopes
  assert.equal(env.valid, true)
  assert.equal(text(env.fields.get('01')), 'text/plain')
  assert.equal(text(env.body), 'hello')
})

test('treats OP_1-OP_16 as aliases of single-byte pushes', () => {
  const viaOpcode = parseEnvelopes(
    envelope({ fields: [[Opcode.OP_11, Buffer.from('abc')]], body: Buffer.alloc(0) })
  ).envelopes[0]
  const viaPush = parseEnvelopes(
    envelope({ fields: [[Buffer.from([11]), Buffer.from('abc')]], body: Buffer.alloc(0) })
  ).envelopes[0]

  assert.equal(text(viaOpcode.fields.get('0b')), 'abc')
  assert.deepEqual([...viaOpcode.fields.keys()], [...viaPush.fields.keys()])
})

test('walks every field pair, not just content-type', () => {
  const { envelopes } = parseEnvelopes(
    envelope({
      fields: [
        [Opcode.OP_1, Buffer.from('image/png')],
        [Opcode.OP_3, Buffer.from('parent_0')],
        [Opcode.OP_5, Buffer.from([0xa1, 0x62])],
        [Opcode.OP_7, Buffer.from('bsv-20')],
        [Buffer.from([0x63]), Buffer.from('custom')]
      ],
      body: Buffer.from('PNG')
    })
  )
  const [env] = envelopes
  assert.equal(env.fields.size, 6) // five fields plus the body
  assert.equal(text(env.fields.get('07')), 'bsv-20')
  assert.equal(text(env.fields.get('63')), 'custom')
})

test('later values overwrite repeated fields and the repeat is reported', () => {
  const { envelopes } = parseEnvelopes(
    envelope({
      fields: [
        [Opcode.OP_1, Buffer.from('text/plain')],
        [Opcode.OP_1, Buffer.from('application/json')]
      ],
      body: Buffer.from('{}')
    })
  )
  const [env] = envelopes
  assert.equal(text(env.fields.get('01')), 'application/json')
  assert.equal(env.occurrences.get('01').length, 2)
  assert.match(env.warnings[0], /repeated/)
})

test('keeps only the first push as the body but reports the extra parts', () => {
  const { envelopes } = parseEnvelopes(
    envelope({
      fields: [[Opcode.OP_1, Buffer.from('text/plain')]],
      body: [Buffer.from('one'), Buffer.from('two')]
    })
  )
  const [env] = envelopes
  assert.equal(text(env.body), 'one')
  assert.equal(env.bodyParts.length, 2)
  assert.equal(text(env.bodyConcat), 'onetwo')
  assert.match(env.warnings.join(' '), /not concatenate/)
})

test('finds the envelope whether the lock is prepended, appended, or separated', () => {
  const insc = envelope({
    fields: [[Opcode.OP_1, Buffer.from('text/plain')]],
    body: Buffer.from('hi')
  })
  const sep = new Script().add(Opcode.OP_CODESEPARATOR)

  for (const script of [
    concatScripts(p2pkh(), insc),
    concatScripts(insc, p2pkh()),
    concatScripts(insc, sep, p2pkh())
  ]) {
    const parsed = parseEnvelopes(script)
    assert.equal(parsed.envelopes.length, 1)
    assert.equal(parsed.envelopes[0].valid, true)
    assert.match(parsed.lock.toASM(), /OP_DUP OP_HASH160/)
  }
})

test('reports every envelope so callers can ignore all but the first', () => {
  const script = concatScripts(
    envelope({ fields: [[Opcode.OP_1, Buffer.from('text/plain')]], body: Buffer.from('first') }),
    envelope({ fields: [[Opcode.OP_1, Buffer.from('text/html')]], body: Buffer.from('second') }),
    p2pkh()
  )
  const { envelopes, lock } = parseEnvelopes(script)
  assert.equal(envelopes.length, 2)
  assert.equal(envelopes[0].index, 0)
  assert.equal(lock.toASM(), p2pkh().toASM())
})

test('flags an envelope with no OP_ENDIF as invalid', () => {
  const { envelopes } = parseEnvelopes(
    envelope({
      fields: [[Opcode.OP_1, Buffer.from('text/plain')]],
      body: Buffer.from('hi'),
      terminate: false
    })
  )
  assert.equal(envelopes[0].valid, false)
  assert.match(envelopes[0].errors.join(' '), /OP_ENDIF/)
})

test('a field with no value is an error, not a silent drop', () => {
  const script = new Script()
    .add(Opcode.OP_FALSE)
    .add(Opcode.OP_IF)
    .add(Buffer.from('ord'))
    .add(Opcode.OP_1)
    .add(Opcode.OP_ENDIF)
  const [env] = parseEnvelopes(script).envelopes
  assert.equal(env.valid, false)
  assert.equal(env.fields.size, 0)
})

test('a script with no envelope yields none and keeps the whole lock', () => {
  const parsed = parseEnvelopes(p2pkh())
  assert.equal(parsed.envelopes.length, 0)
  assert.equal(parsed.lock.toASM(), p2pkh().toASM())
})
