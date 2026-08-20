import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { clearCaches, fetchTransaction } from '../src/services/txProvider.js'
import { startApp } from './helpers.js'

const TXID = '10f4465cd18c39fbc7aa4089268e57fc719bf19c8c24f2e09156f4a89a2809d6'
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  clearCaches()
})

const bodyOf = (buf) => ({
  getReader () {
    let sent = false
    return {
      read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: buf })),
      cancel: async () => {}
    }
  }
})

/** Serves the fixture transaction, counting how many upstream calls happen. */
function mockProvider (rawBytes, { declareLength = true } = {}) {
  const state = { calls: 0 }
  globalThis.fetch = async () => {
    state.calls++
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => (h === 'content-length' && declareLength ? String(rawBytes.length) : null) },
      body: bodyOf(rawBytes),
      arrayBuffer: async () => rawBytes
    }
  }
  return state
}

const fixture = async () => {
  const { readFile } = await import('node:fs/promises')
  const hex = (await readFile(new URL('./fixtures/inscription-10f44.hex', import.meta.url), 'utf8')).trim()
  return Buffer.from(hex, 'hex')
}

test('a transaction is fetched as bytes and verified against its txid', async () => {
  const raw = await fixture()
  mockProvider(raw)
  const res = await fetchTransaction(TXID, { providers: 'gorillapool' })
  assert.equal(res.tx.hash, TXID)
  assert.equal(res.size, raw.length)
})

test('bytes that do not hash to the requested txid are rejected', async () => {
  const raw = await fixture()
  mockProvider(raw)
  await assert.rejects(
    fetchTransaction('b'.repeat(64), { providers: 'gorillapool' }),
    /no provider could serve/
  )
})

test('concurrent requests for the same transaction make one upstream call', async () => {
  const raw = await fixture()
  const state = mockProvider(raw)
  const results = await Promise.all(
    Array.from({ length: 5 }, () => fetchTransaction(TXID, { providers: 'gorillapool' }))
  )
  assert.equal(state.calls, 1)
  for (const r of results) assert.equal(r.tx.hash, TXID)
})

test('there is no download limit by default, so media inscriptions still resolve', async () => {
  const raw = await fixture()
  mockProvider(raw)
  const res = await fetchTransaction(TXID, { providers: 'gorillapool' })
  assert.equal(res.tx.hash, TXID) // no maxBytes passed, nothing refused
})

test('a configured limit aborts an oversized download rather than buffering it', async () => {
  const raw = await fixture()
  mockProvider(raw)
  await assert.rejects(
    fetchTransaction(TXID, { providers: 'gorillapool', maxBytes: 100 }),
    (err) => err.code === 'too_large' && /100 byte fetch limit/.test(err.message)
  )
})

test('a limit is enforced even when the response declares no length', async () => {
  const raw = await fixture()
  mockProvider(raw, { declareLength: false })
  await assert.rejects(
    fetchTransaction(TXID, { providers: 'gorillapool', maxBytes: 100 }),
    (err) => err.code === 'too_large'
  )
})

test('the rate limiter returns 429 with a retry-after once the burst is spent', async () => {
  const express = (await import('express')).default
  const { rateLimit } = await import('../src/lib/rateLimit.js')

  const app = express()
  app.use(rateLimit({ perMinute: 60, burst: 2 }))
  app.get('/ping', (_req, res) => res.json({ ok: true }))

  const server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`

  try {
    const first = await fetch(`${base}/ping`)
    const second = await fetch(`${base}/ping`)
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.equal(first.headers.get('x-ratelimit-limit'), '60')

    const third = await fetch(`${base}/ping`)
    assert.equal(third.status, 429)
    assert.ok(Number(third.headers.get('retry-after')) >= 1)
    assert.equal((await third.json()).error.code, 'rate_limited')
  } finally {
    server.close()
  }
})

test('the bucket refills over time rather than resetting on a window', async () => {
  const express = (await import('express')).default
  const { rateLimit } = await import('../src/lib/rateLimit.js')

  const app = express()
  app.use(rateLimit({ perMinute: 6000, burst: 1 })) // 100/second
  app.get('/ping', (_req, res) => res.json({ ok: true }))

  const server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`

  try {
    assert.equal((await fetch(`${base}/ping`)).status, 200)
    assert.equal((await fetch(`${base}/ping`)).status, 429)
    await new Promise((r) => setTimeout(r, 40))
    assert.equal((await fetch(`${base}/ping`)).status, 200)
  } finally {
    server.close()
  }
})

test('large bodies are not inlined but are reachable at contentUrl', async () => {
  const app = await startApp()
  try {
    const { concatScripts, envelope, p2pkh } = await import('./helpers.js')
    const bsv = (await import('@smartledger/bsv')).default
    const script = concatScripts(
      p2pkh(),
      envelope({
        fields: [[bsv.Opcode.OP_1, Buffer.from('video/mp4')]],
        body: Buffer.alloc(5000, 9)
      })
    ).toHex()

    const body = await (await app.post('/v1/parse?maxContent=1024', { script, satoshis: 1 })).json()
    assert.equal(body.inscription.contentTruncated, true)
    assert.equal(body.inscription.content, null)
    assert.equal(body.inscription.contentLength, 5000)
    assert.match(body.inscription.contentUrl, /\/content$/)
  } finally {
    await app.close()
  }
})
