export {
  ORD,
  concatScripts,
  envelope,
  fakeTx,
  p2pkh
} from '../packages/core/tests/helpers.js'

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

