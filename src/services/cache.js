/** Small LRU with TTL - enough to keep hot transactions out of the providers. */
export class TtlCache {
  constructor ({ max = 500, ttlMs = 600000 } = {}) {
    this.max = max
    this.ttlMs = ttlMs
    this.map = new Map()
  }

  get (key) {
    const hit = this.map.get(key)
    if (!hit) return undefined
    if (hit.expires <= Date.now()) {
      this.map.delete(key)
      return undefined
    }
    // refresh recency
    this.map.delete(key)
    this.map.set(key, hit)
    return hit.value
  }

  set (key, value) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, { value, expires: Date.now() + this.ttlMs })
    while (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value)
    }
  }

  get size () {
    return this.map.size
  }

  clear () {
    this.map.clear()
  }
}
