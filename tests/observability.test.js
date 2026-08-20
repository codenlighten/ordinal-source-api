import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { counter, gauge, observe, render, reset, snapshot } from '../src/lib/metrics.js'
import { startApp } from './helpers.js'

afterEach(() => reset())

test('counters render in the Prometheus exposition format', () => {
  counter('ordinal_api_upstream_requests_total', { provider: 'bitails', outcome: 'not_found' })
  counter('ordinal_api_upstream_requests_total', { provider: 'bitails', outcome: 'not_found' })
  const text = render()

  assert.match(text, /# TYPE ordinal_api_upstream_requests_total counter/)
  assert.match(text, /ordinal_api_upstream_requests_total\{outcome="not_found",provider="bitails"\} 2/)
})

test('labels are ordered so the same series is never split in two', () => {
  counter('ordinal_api_cache_total', { result: 'hit', kind: 'transaction' })
  counter('ordinal_api_cache_total', { kind: 'transaction', result: 'hit' })
  assert.match(render(), /ordinal_api_cache_total\{kind="transaction",result="hit"\} 2/)
})

test('label values with quotes cannot break the output', () => {
  counter('ordinal_api_upstream_requests_total', { provider: 'a"b\\c', outcome: 'ok' })
  assert.match(render(), /provider="a\\"b\\\\c"/)
})

test('histograms record cumulative buckets, a sum, and a count', () => {
  observe('ordinal_api_http_request_seconds', 0.02, { route: '/v1/fields' })
  observe('ordinal_api_http_request_seconds', 0.4, { route: '/v1/fields' })
  const text = render()

  assert.match(text, /le="0\.01"\} 0/)
  assert.match(text, /le="0\.05"\} 1/)
  assert.match(text, /le="0\.5"\} 2/)
  assert.match(text, /le="\+Inf"\} 2/)
  assert.match(text, /ordinal_api_http_request_seconds_count\{route="\/v1\/fields"\} 2/)
})

test('gauges overwrite rather than accumulate', () => {
  gauge('test_queue_depth', 100, { kind: 'upstream' })
  gauge('test_queue_depth', 200, { kind: 'upstream' })
  assert.match(render(), /test_queue_depth\{kind="upstream"\} 200/)
})

test('process gauges are sampled fresh on every scrape', () => {
  gauge('ordinal_api_memory_bytes', 1, { kind: 'rss' })
  assert.doesNotMatch(render(), /ordinal_api_memory_bytes\{kind="rss"\} 1$/m)
})

test('the JSON view carries the same numbers', () => {
  counter('ordinal_api_rate_limited_total', undefined, 3)
  const json = snapshot()
  assert.equal(json.counters.ordinal_api_rate_limited_total, 3)
  assert.ok(json.gauges.ordinal_api_uptime_seconds > 0)
})

test('GET /metrics serves both formats', async () => {
  const app = await startApp()
  try {
    const text = await app.get('/metrics')
    assert.match(text.headers.get('content-type'), /text\/plain/)
    assert.match(await text.text(), /ordinal_api_uptime_seconds/)

    const json = await (await app.get('/metrics?format=json')).json()
    assert.ok('counters' in json && 'gauges' in json)
  } finally {
    await app.close()
  }
})

test('every request gets an id, echoed back and repeated in errors', async () => {
  const app = await startApp()
  try {
    const ok = await app.get('/v1/fields')
    assert.match(ok.headers.get('x-request-id'), /^[0-9a-f-]{36}$/)

    const bad = await app.get('/v1/outpoint/nope')
    assert.equal(bad.status, 400)
    const body = await bad.json()
    assert.equal(body.error.requestId, bad.headers.get('x-request-id'))
  } finally {
    await app.close()
  }
})

test('an inbound request id is honoured so a trace survives a proxy', async () => {
  const app = await startApp()
  try {
    const res = await fetch(`${app.base}/v1/fields`, { headers: { 'x-request-id': 'trace-abc' } })
    assert.equal(res.headers.get('x-request-id'), 'trace-abc')
  } finally {
    await app.close()
  }
})

test('requests are counted by route pattern, not by concrete path', async () => {
  const app = await startApp()
  try {
    // Two different txids must land on one series, or a busy instance would
    // produce a metric series per transaction.
    await app.get(`/v1/outpoint/${'a'.repeat(64)}_0?field=txid`).catch(() => {})
    await app.get('/v1/fields')
    const text = await (await app.get('/metrics')).text()

    assert.match(text, /ordinal_api_http_requests_total\{method="GET",route="\/v1\/fields",status="200"\} 1/)
    assert.doesNotMatch(text, new RegExp('a'.repeat(64)))
  } finally {
    await app.close()
  }
})

test('a 404 is labelled unmatched rather than by its path', async () => {
  const app = await startApp()
  try {
    await app.get('/no/such/thing')
    const text = await (await app.get('/metrics')).text()
    assert.match(text, /route="unmatched",status="404"/)
  } finally {
    await app.close()
  }
})
