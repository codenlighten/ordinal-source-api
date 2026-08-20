import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_ORDER, resolveProviders } from '../src/services/providers.js'
import { TtlCache } from '../src/services/cache.js'

test('mainnet uses the full provider chain in order', () => {
  assert.deepEqual(resolveProviders('', 'main').map((p) => p.name), DEFAULT_ORDER)
})

test('testnet drops the mainnet-only providers', () => {
  const names = resolveProviders('', 'test').map((p) => p.name)
  assert.deepEqual(names, ['whatsonchain', 'bitails'])
})

test('only some providers can serve a single output script', () => {
  const names = resolveProviders('', 'main', 'output').map((p) => p.name)
  assert.deepEqual(names, ['whatsonchain', 'bitails'])
})

test('an explicit provider list is honoured in the order given', () => {
  const names = resolveProviders('bitails,whatsonchain', 'main').map((p) => p.name)
  assert.deepEqual(names, ['bitails', 'whatsonchain'])
})

test('unknown or unusable providers are rejected', () => {
  assert.throws(() => resolveProviders('nope', 'main'), /unknown provider/)
  assert.throws(() => resolveProviders('gorillapool', 'test'), /none of the requested providers/)
})

test('cache evicts the least recently used entry past its limit', () => {
  const cache = new TtlCache({ max: 2, ttlMs: 1000 })
  cache.set('a', 1)
  cache.set('b', 2)
  cache.get('a') // refresh recency, so 'b' is now the oldest
  cache.set('c', 3)
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a'), 1)
  assert.equal(cache.get('c'), 3)
})

test('cache entries expire', async () => {
  const cache = new TtlCache({ max: 4, ttlMs: 10 })
  cache.set('a', 1)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(cache.get('a'), undefined)
})
