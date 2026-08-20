import assert from 'node:assert/strict'
import test from 'node:test'
import bsv from '@smartledger/bsv'
import { inscriptionAt, splitLock, tokenAt } from '../src/inscription.js'
import { concatScripts, envelope, p2pkh } from './helpers.js'

const { Opcode, Script } = bsv

const MAP = Script.fromASM(
  'OP_RETURN ' +
  Buffer.from('1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5').toString('hex') + ' ' +
  Buffer.from('SET').toString('hex') + ' ' +
  Buffer.from('app').toString('hex') + ' ' +
  Buffer.from('demo').toString('hex')
)

const inscribed = (body, contentType = 'text/plain') =>
  envelope({
    fields: [[Opcode.OP_1, Buffer.from(contentType)]],
    body: Buffer.from(body)
  })

test('the lock is the locking script alone, so an address resolves', () => {
  // With the OP_RETURN left in, toAddress fails - which is what the lock is for.
  const script = concatScripts(p2pkh(), inscribed('hi'), MAP)
  const insc = inscriptionAt(script)

  assert.equal(String(insc.lock.toAddress('livenet')), '1FHy8WBx1ZhQ2T86ZftxZUjbiBMQ6dNxeJ')
  assert.equal(insc.lock.toASM(), p2pkh().toASM())
})

test('trailing OP_RETURN data is kept, with MAP tags decoded', () => {
  const insc = inscriptionAt(concatScripts(p2pkh(), inscribed('hi'), MAP))
  assert.deepEqual(insc.opReturn.map, { app: 'demo' })
  assert.equal(insc.opReturn.pushes.length, 4)
})

test('an output with no OP_RETURN has none reported', () => {
  const insc = inscriptionAt(concatScripts(p2pkh(), inscribed('hi')))
  assert.equal(insc.opReturn, null)
  assert.equal(insc.lock.toASM(), p2pkh().toASM())
})

test('inscriptionAt reads content, type, and any token', () => {
  const insc = inscriptionAt(
    concatScripts(p2pkh(), inscribed('{"p":"bsv-20","op":"mint","tick":"ORDI","amt":"1"}', 'application/bsv-20')),
    `${'ab'.repeat(32)}_0`
  )
  assert.equal(insc.contentType, 'application/bsv-20')
  assert.equal(insc.contentLength, 50)
  assert.equal(insc.token.standard, 'BSV-20')
  assert.equal(insc.token.tick, 'ORDI')
})

test('a script with no inscription reads as none', () => {
  assert.equal(inscriptionAt(p2pkh()), null)
  assert.equal(tokenAt(p2pkh()), null)
})

test('splitLock is usable on its own', () => {
  const { lock, opReturn } = splitLock(concatScripts(p2pkh(), MAP))
  assert.equal(lock.toASM(), p2pkh().toASM())
  assert.equal(opReturn.pushes[1].text, 'SET')
})

test('OP_FALSE OP_RETURN is data, not part of the lock', () => {
  // The standard safe-data form. Leaving the OP_FALSE on the lock was enough on
  // its own to stop toAddress resolving, which is what the lock is for.
  const script = concatScripts(p2pkh(), inscribed('hi'))
  script.add(Opcode.OP_FALSE).add(Opcode.OP_RETURN).add(Buffer.from('data'))

  // Through the consumer path: the envelope comes off, then the data output.
  const { lock, opReturn } = inscriptionAt(script)
  assert.equal(lock.toASM(), p2pkh().toASM())
  assert.equal(String(lock.toAddress('livenet')), '1FHy8WBx1ZhQ2T86ZftxZUjbiBMQ6dNxeJ')
  assert.equal(opReturn.pushes.length, 1)
  assert.equal(opReturn.pushes[0].text, 'data')
})

test('a lone OP_FALSE that is not a data prefix stays on the lock', () => {
  const odd = Script.fromASM('OP_FALSE OP_DROP OP_TRUE')
  const { lock, opReturn } = splitLock(odd)
  assert.equal(lock.toASM(), odd.toASM())
  assert.equal(opReturn, null)
})

test('splitLock takes hex and ASM like every other entry point', () => {
  const script = concatScripts(p2pkh(), MAP)
  for (const form of [script, script.toHex(), script.toBuffer(), script.toASM()]) {
    assert.equal(splitLock(form).lock.toASM(), p2pkh().toASM())
  }
})

test('MAP is decoded when another protocol comes first', () => {
  // BitCom joins protocols in one OP_RETURN with a pipe; MAP is often not first.
  const joined = Script.fromASM(
    'OP_RETURN ' +
    Buffer.from('19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut').toString('hex') + ' ' +
    Buffer.from('some file').toString('hex') + ' ' +
    Buffer.from('|').toString('hex') + ' ' +
    Buffer.from('1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5').toString('hex') + ' ' +
    Buffer.from('SET').toString('hex') + ' ' +
    Buffer.from('app').toString('hex') + ' ' +
    Buffer.from('demo').toString('hex')
  )
  assert.deepEqual(splitLock(concatScripts(p2pkh(), joined)).opReturn.map, { app: 'demo' })
})

test('MAP parsing stops at the next protocol rather than reading past it', () => {
  const trailing = Script.fromASM(
    'OP_RETURN ' +
    Buffer.from('1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5').toString('hex') + ' ' +
    Buffer.from('SET').toString('hex') + ' ' +
    Buffer.from('app').toString('hex') + ' ' +
    Buffer.from('demo').toString('hex') + ' ' +
    Buffer.from('|').toString('hex') + ' ' +
    Buffer.from('1SomeOtherProtocol').toString('hex') + ' ' +
    Buffer.from('notAKey').toString('hex')
  )
  assert.deepEqual(splitLock(concatScripts(p2pkh(), trailing)).opReturn.map, { app: 'demo' })
})

test('an unpaired trailing key is not read as a tag', () => {
  const odd = Script.fromASM(
    'OP_RETURN ' +
    Buffer.from('1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5').toString('hex') + ' ' +
    Buffer.from('SET').toString('hex') + ' ' +
    Buffer.from('app').toString('hex') + ' ' +
    Buffer.from('demo').toString('hex') + ' ' +
    Buffer.from('dangling').toString('hex')
  )
  assert.deepEqual(splitLock(concatScripts(p2pkh(), odd)).opReturn.map, { app: 'demo' })
})

test('tokenAt reads a token without doing the lock work', () => {
  const script = concatScripts(
    p2pkh(),
    inscribed('{"p":"bsv-20","op":"mint","tick":"ORDI","amt":"5"}', 'application/bsv-20'),
    MAP
  )
  const token = tokenAt(script, `${'ab'.repeat(32)}_0`)
  assert.equal(token.tick, 'ORDI')
  assert.equal(token.amount, '5')
  // Same answer as the fuller path, just without the discarded work.
  assert.deepEqual(token, inscriptionAt(script, `${'ab'.repeat(32)}_0`).token)
})

test('the arrangement of envelope and lock is reported', () => {
  const insc = inscribed('hi')
  assert.equal(inscriptionAt(concatScripts(insc, p2pkh())).arrangement, 'envelope-first')
  assert.equal(inscriptionAt(concatScripts(p2pkh(), insc)).arrangement, 'lock-first')
  assert.equal(inscriptionAt(insc).arrangement, 'envelope-only')
})

test('a trailing OP_RETURN does not disguise the arrangement', () => {
  // Lock, envelope, then MAP data: still lock-first, not "between two locks".
  const script = concatScripts(p2pkh(), inscribed('hi'), MAP)
  assert.equal(inscriptionAt(script).arrangement, 'lock-first')
})

test('a code separator between lock and envelope is named', () => {
  const sep = new Script().add(Opcode.OP_CODESEPARATOR)
  const script = concatScripts(inscribed('hi'), sep, p2pkh())
  assert.equal(inscriptionAt(script).arrangement, 'envelope-first-separated')
})
