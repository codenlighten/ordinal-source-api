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
