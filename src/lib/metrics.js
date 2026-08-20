/**
 * A minimal Prometheus-compatible registry - counters, histograms, and gauges
 * held in memory and rendered on demand. No dependency, and nothing is sampled
 * or aggregated away, because the numbers worth having here are small.
 *
 * Label values are kept low cardinality on purpose: routes are recorded as
 * their patterns, never as concrete paths, so a million txids do not become a
 * million time series.
 */

const counters = new Map()
const histograms = new Map()
const gauges = new Map()

const BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]

const escape = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')

const key = (name, labels = {}) => {
  const pairs = Object.entries(labels)
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escape(v)}"`)
  return pairs.length ? `${name}{${pairs.join(',')}}` : name
}

export const counter = (name, labels, value = 1) => {
  const k = key(name, labels)
  counters.set(k, (counters.get(k) ?? 0) + value)
}

export const gauge = (name, value, labels) => gauges.set(key(name, labels), value)

export function observe (name, seconds, labels) {
  const k = key(name, labels)
  const hit = histograms.get(k) ?? { count: 0, sum: 0, buckets: new Array(BUCKETS.length).fill(0) }
  hit.count++
  hit.sum += seconds
  for (let i = 0; i < BUCKETS.length; i++) {
    if (seconds <= BUCKETS[i]) hit.buckets[i]++
  }
  histograms.set(k, hit)
}

/** Times an async call and records its outcome under one histogram + counter. */
export async function timed (name, labels, run) {
  const started = process.hrtime.bigint()
  try {
    const result = await run()
    observe(`${name}_seconds`, Number(process.hrtime.bigint() - started) / 1e9, labels)
    return result
  } catch (err) {
    observe(`${name}_seconds`, Number(process.hrtime.bigint() - started) / 1e9, labels)
    throw err
  }
}

const HELP = {
  ordinal_api_http_requests_total: ['counter', 'HTTP requests by route pattern and status'],
  ordinal_api_http_request_seconds: ['histogram', 'HTTP request duration'],
  ordinal_api_upstream_requests_total: ['counter', 'Upstream provider calls by outcome'],
  ordinal_api_upstream_seconds: ['histogram', 'Upstream provider call duration'],
  ordinal_api_cache_total: ['counter', 'Transaction and output cache hits and misses'],
  ordinal_api_coalesced_total: ['counter', 'Fetches served by joining an in-flight request'],
  ordinal_api_rate_limited_total: ['counter', 'Requests rejected by the rate limiter'],
  ordinal_api_verify_total: ['counter', 'Verification runs by agreement with the indexer'],
  ordinal_api_uptime_seconds: ['gauge', 'Process uptime'],
  ordinal_api_memory_bytes: ['gauge', 'Process memory usage']
}

const baseName = (k) => k.split('{')[0].replace(/_(bucket|sum|count)$/, '')

function refreshProcessGauges () {
  const mem = process.memoryUsage()
  gauge('ordinal_api_uptime_seconds', process.uptime())
  gauge('ordinal_api_memory_bytes', mem.rss, { kind: 'rss' })
  gauge('ordinal_api_memory_bytes', mem.heapUsed, { kind: 'heap_used' })
}

/** Renders the Prometheus text exposition format. */
export function render () {
  refreshProcessGauges()
  const lines = []
  const described = new Set()

  const describe = (name) => {
    const base = baseName(name)
    if (described.has(base) || !HELP[base]) return
    described.add(base)
    const [type, help] = HELP[base]
    lines.push(`# HELP ${base} ${help}`, `# TYPE ${base} ${type}`)
  }

  for (const [k, value] of [...counters].sort()) {
    describe(k)
    lines.push(`${k} ${value}`)
  }
  for (const [k, hit] of [...histograms].sort()) {
    describe(k)
    const [name, labelPart = ''] = k.split('{')
    const labels = labelPart ? labelPart.slice(0, -1) : ''
    const withLe = (le) => `${name}_bucket{${labels ? labels + ',' : ''}le="${le}"}`
    for (let i = 0; i < BUCKETS.length; i++) lines.push(`${withLe(BUCKETS[i])} ${hit.buckets[i]}`)
    lines.push(`${withLe('+Inf')} ${hit.count}`)
    lines.push(`${name}_sum${labels ? `{${labels}}` : ''} ${hit.sum}`)
    lines.push(`${name}_count${labels ? `{${labels}}` : ''} ${hit.count}`)
  }
  for (const [k, value] of [...gauges].sort()) {
    describe(k)
    lines.push(`${k} ${value}`)
  }
  return lines.join('\n') + '\n'
}

/** The same numbers as JSON, for reading by eye rather than by scraper. */
export function snapshot () {
  refreshProcessGauges()
  return {
    counters: Object.fromEntries([...counters].sort()),
    histograms: Object.fromEntries(
      [...histograms].sort().map(([k, h]) => [k, { count: h.count, sum: Number(h.sum.toFixed(4)) }])
    ),
    gauges: Object.fromEntries([...gauges].sort())
  }
}

export const reset = () => {
  counters.clear()
  histograms.clear()
  gauges.clear()
}

export { BUCKETS }
