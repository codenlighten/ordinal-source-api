import bsv from '@smartledger/bsv'

const { Opcode, Script } = bsv

export const ORD = Buffer.from('ord')

/** Builds an inscription envelope from field/value pairs. */
export function envelope ({ fields = [], body, terminate = true } = {}) {
  const s = new Script().add(Opcode.OP_FALSE).add(Opcode.OP_IF).add(ORD)
  for (const [field, value] of fields) {
    s.add(field)
    s.add(value)
  }
  if (body !== undefined) {
    s.add(Opcode.OP_0)
    for (const part of Array.isArray(body) ? body : [body]) s.add(part)
  }
  if (terminate) s.add(Opcode.OP_ENDIF)
  return s
}

export const p2pkh = () =>
  Script.fromASM(
    'OP_DUP OP_HASH160 9cc74552f4cbc188358fedb5fa001c8768e303a4 OP_EQUALVERIFY OP_CHECKSIG'
  )

export function concatScripts (...scripts) {
  const out = new Script()
  for (const s of scripts) for (const c of s.chunks) out.chunks.push(c)
  return out
}

/** Starts the app on an ephemeral port and returns a fetch helper. */
export async function startApp () {
  const { createApp } = await import('../src/app.js')
  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    get: (path) => fetch(`${base}${path}`),
    post: (path, body) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }),
    close: () => new Promise((resolve) => server.close(resolve))
  }
}
