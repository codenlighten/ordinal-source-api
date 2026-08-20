# ordinal-source-api

A read-only HTTP API for [1Sat Ordinals](https://docs.1satordinals.com) on BSV.

Give it a **txid** or an **outpoint**, and optionally name the **ordinal field**
you want, and it returns just that. It also builds its own token index, so the
answers it cannot verify alone stop being assumptions. Every inscription is parsed from the raw
transaction bytes with [`@smartledger/bsv`](https://www.npmjs.com/package/@smartledger/bsv) —
the txid is verified locally, so no indexer is trusted for the parse.

```bash
npm install
npm start          # http://localhost:3000
npm test           # 129 tests, no network required
```

The protocol itself lives in [`packages/core`](packages/core) and is published
as [`@smartledger/ordinals`](packages/core/README.md): envelope parsing, ordinal
theory arithmetic, and token rules as pure functions, with no network,
database, or framework. The API and the indexer are both just consumers of it.

```
packages/core/   the protocol, as pure functions
src/             the HTTP API
src/indexer/     the token indexer: ingest, rules, storage
```

## The four ways to ask

```bash
TX=10f4465cd18c39fbc7aa4089268e57fc719bf19c8c24f2e09156f4a89a2809d6

# 1. by txid - every output
curl "localhost:3000/v1/tx/$TX"

# 2. by outpoint - one output (1Sat inscription id form)
curl "localhost:3000/v1/outpoint/${TX}_0"

# 3. by field - one value out of that output
curl "localhost:3000/v1/outpoint/${TX}_0?field=contentType"
# {"field":"contentType","key":"0x01","value":"model/gltf-binary", ...}

# 4. by ordinal - the genesis and the current holder, from either end
curl "localhost:3000/v1/ordinal/${TX}_0?field=role,origin,current,currentOwner"
```

Field selection composes with all of these, so `?field=` on a txid projects that
field across every output.

## Selecting fields

`?field=` accepts a spec name, an alias, a field number, or a raw hex key —
these are all the same request:

```
?field=contentType   ?field=content_type   ?field=mime   ?field=1   ?field=0x01
```

| Field | Key | Aliases |
| --- | --- | --- |
| `content` | `OP_0` | `body`, `data`, `file`, `payload` |
| `contentType` | `0x01` | `content_type`, `mime`, `ct`, `type` |
| `pointer` | `0x02` | |
| `parent` | `0x03` | |
| `metadata` | `0x05` | `meta` |
| `metaprotocol` | `0x07` | `protocol` |
| `contentEncoding` | `0x09` | `content_encoding` |
| `delegate` | `0x0b` | |

Fields the spec doesn't name are still parsed — reach them by number
(`?field=13`) or hex (`?field=0x0d`). Output-level values are selectable the
same way: `txid`, `vout`, `outpoint`, `satoshis`, `isOrdinal`, `address`,
`contentHash`, `contentLength`, `script`, `asm`, `lock`, `map`, `warnings`, the
token fields, and the chain-position fields. `GET /v1/fields` lists all of them.

Ask for several at once, or for the raw bytes:

```bash
curl "localhost:3000/v1/outpoint/${TX}_0?field=contentType,contentLength,address,isOrdinal"
curl "localhost:3000/v1/outpoint/${TX}_0?field=contentType&raw=1"        # bare value
curl "localhost:3000/v1/outpoint/${TX}_0/content" -o model.glb            # body + content-type
```

## Tokens (BSV-20 / BSV-21)

Inscription content is checked for a `{"p":"bsv-20"}` document, and the result
lands on `inscription.token` with `isToken` beside it. Both standards use the
same protocol tag and the content type `application/bsv-20`; they are told apart
by their identifier — **BSV-20** (deprecated, "first is first") uses a `tick`
ticker, **BSV-21** uses an `id` pointing at the deploy outpoint. Deploy
operations carry no id, so the outpoint being parsed is filled in as the token id.

```bash
curl "localhost:3000/v1/outpoint/${ORDI}_0?field=standard,op,tick,max"
# {"standard":"BSV-20","op":"deploy","tick":"ordi","max":"21000000"}

curl "localhost:3000/v1/outpoint/${XFER}_6?resolveToken=1&field=standard,symbol,amount,amountDisplay,decimals"
# {"standard":"BSV-21","symbol":"BLASTER","amount":"800000000","amountDisplay":"8","decimals":8}
```

Selectable token fields: `token`, `isToken`, `standard`, `op`, `tokenId`,
`tick`, `symbol`, `amount`, `amountDisplay`, `decimals`, `max`. `?tokens=1` on a
txid keeps only the outputs carrying one.

Each document is checked against the spec rather than merely detected — required
fields per op, `amt` prohibited on `auth`/`deploy+auth`, uint64 range, `dec` ≤ 18,
`id` in `<txid>_<vout>` form, `tick` ≤ 4 characters — and reported as
`wellFormed` with `errors`.

**The field is called `wellFormed`, not `valid`, on purpose.** It says the
document is correctly shaped for the operation it declares — not that the
operation is legal on chain. The response states its own scope with
`validated: "document"` and `notValidated: ["conservation", "supply-limit",
"ticker-priority"]`. For conservation, see below; it is checkable, just not from
one document. Unrecognised JSON fields are preserved in `token.json` and
ignored, as BSV-21 requires. Historical BSV-20 inscriptions using `text/plain` are
still detected, with a warning noting the content type.

Precision belongs to the deploy, not the transfer. A transfer that doesn't
restate `dec` reports `decimals: null` and no `amountDisplay`, plus
`decimalsFrom` naming the deploy to read it from — rather than silently assuming
zero and displaying a wrong number. `?resolveToken=1` fetches that deploy and
fills in symbol, decimals, and the scaled amount.

## Is the transfer actually valid?

`?validateTokens=1` checks a transfer against the chain: do its token inputs
cover what its outputs claim to move?

```bash
curl "localhost:3000/v1/tx/$TXID?validateTokens=1"
```

```json
{ "tokenValidation": {
    "conserved": true, "proven": false,
    "assuming": "the token inputs are themselves valid",
    "checked":    ["document", "conservation", "satoshi-value", "auth-input"],
    "notChecked": ["ticker-priority", "supply-limit"],
    "tokens": [{ "tokenId": "429bf199…_0",
                 "inputTotal": "6100000000", "outputTotal": "6100000000",
                 "conserved": true, "errors": [] }] } }
```

**Conservation is a property of a transaction, not of an output** — an output
cannot be over-spent by itself — so validation always runs over the whole
transaction, and an outpoint query validates the transaction containing it.

What is decided, and what is not:

| | |
| --- | --- |
| **Decided here** | conservation across the transaction, the 1 satoshi requirement on token outputs, a mint's auth input, and that a deploy defines its own id |
| **Decided by walking** | whether the token inputs were themselves valid — `?depth=2..4` recurses toward the deploy; when every path reaches one, `proven: true` and the assumption disappears |
| **Not decidable** | "first is first" ticker priority and BSV-20 supply limits, which need every deploy and mint that ever happened. Listed in `notChecked`, never reported as valid |

At `depth=1` the answer is honest about resting on something: `conserved: true`
with `assuming: "the token inputs are themselves valid"`. That single hop is
still what catches the case that actually matters — outputs claiming more than
the inputs carry.

Deploys create supply rather than moving it, so a `deploy+mint` needs nothing
behind it and comes back `proven: true` on its own. Transfers and burns both
consume balance (a burn is not a discount), and tokens a transfer leaves behind
are reported as `burnedSurplus` rather than quietly dropped. BSV-20 balances are
keyed by ticker case-insensitively, BSV-21 by token id, so the two standards
validate through the same path. An input that cannot be fetched is listed in
`unresolvedInputs` and makes the result unconserved — never silently skipped.

Selectors: `conserved`, `provenValid`, `assuming`, `conservation`,
`tokenValidation`. Bounded by `TOKEN_VALIDATE_MAX_FETCHES` (60) and
`TOKEN_VALIDATE_MAX_DEPTH` (4).

## Origin and current holder

Neither end of an ordinal's life is in the transaction you're holding: `origin`
is the first outpoint where the satoshi stood alone, and the holder is the
unspent tip of the transfer chain. Both need a chain-wide index, so
`GET /v1/ordinal/:outpoint` resolves them — **starting from either end, or from
any transfer in between**:

```bash
curl "localhost:3000/v1/ordinal/$ANY_OUTPOINT?field=role,origin,genesisOwner,current,currentOwner"
```

| Queried | `role` |
| --- | --- |
| the origin outpoint | `genesis` |
| an unspent origin | `genesis+current` |
| a transfer along the way | `transfer` |
| the unspent tip | `current` |

The response is the **genesis** output view — that is where the inscription
lives, so `contentType`, `content`, and token fields resolve even when you asked
about a later transfer that carries no envelope — with the chain position under
`ordinal` (`genesis`, `current`, `queried`, `role`). Selectors: `origin`,
`originNumber`, `genesisOwner`, `current`, `currentOwner` (or `holder`), `role`,
`spent`, `spentIn`, `height`, `ordinal`.

**By default this block is the indexer's word, and says so** — `verified: false`
and `assertedBy` naming the source, unlike the inscription beside it, which is
parsed from transaction bytes whose hash this API checked. Add `?verify=1` to
close that gap; see below. The same enrichment attaches to `/v1/outpoint/...`
with `?origin=1`, or automatically when you select one of those fields. GorillaPool indexes both
directions; WhatsOnChain resolves origin only, so it serves as an origin
fallback. If no indexer answers, the on-chain parse still returns and the
`ordinal` block is marked `unavailable` with what was tried.

## Verifying it yourself

`?verify=1` recomputes the ordinal's position from transaction bytes instead of
taking the indexer's word, and reports whether the two agree:

```bash
curl "localhost:3000/v1/ordinal/$OUTPOINT?verify=1&field=origin,computedOrigin,current,computedCurrent,agreement"
```

```json
{ "origin":   "10f4465c…_0", "computedOrigin":  "10f4465c…_0",
  "current":  "662104c5…_0", "computedCurrent": "662104c5…_0",
  "agreement": { "origin": "match", "current": "match" } }
```

The two directions have genuinely different strength, and the response says
which is which under `proven`:

**Backward, to the origin — needs no index at all.** A transaction names its own
inputs, so the walk back is self-contained: take the satoshi's absolute offset
in the output sequence, find the input covering that same offset, and repeat
until an ancestor output held more than one satoshi. That outpoint is the
origin. The indexer's claim can be confirmed or contradicted outright, and the
origin still resolves when every indexer is down.

**Forward, to the holder — needs a spend lookup**, because "what spent this
output" is not answerable from the output. Every answer is then checked against
real bytes: the named transaction must actually contain an input spending the
outpoint, and ordinal theory is reapplied to find where the satoshi landed. A
wrong hop is caught — `contradicted: true`. What cannot be reached is omission:
"nothing has spent it" is not provable from chain data without a full index, so
a live tip is reported `tipUnrefuted: true` and `proven.stillUnspent: false`
rather than being called proven.

Burns are recognised rather than guessed at. A satoshi landing past the last
output went to the miner (`burned: "paid to fee"`); one landing inside a larger
output is no longer a 1SatOrdinal (`burned: "merged into a 3500 satoshi
output"`, with `lastSeen`).

Every hop is returned under `hops.backward` / `hops.forward` — outpoint, satoshi
offset, which input spent it, where it landed — so the conclusion can be audited
rather than trusted. If the computed answer and the indexer's disagree, both are
shown under `disagreement`; this API does not quietly pick a winner.

Walks are bounded by `VERIFY_MAX_HOPS` (32) and `VERIFY_MAX_FETCHES` (120), and
`cost.transactionsFetched` is reported. It is cheaper than it sounds: inputs are
valued lazily and only up to the one being followed, so with the usual 1Sat
convention of putting the ordinal first, most hops need no extra fetch at all. A
nine-transfer chain verifies end to end in about 10 transaction fetches.

## Query parameters

| Param | Meaning |
| --- | --- |
| `field` / `fields` | one selector or a comma-separated list |
| `encoding` | `auto` (default), `utf8`, `hex`, `base64`, `json`, `number`, `id` |
| `raw` | return the single selected field as the response body |
| `network` | `main` (default) or `test` |
| `provider` / `providers` | source order, e.g. `whatsonchain,bitails` |
| `origin` | add genesis origin, current holder, and spend data |
| `verify` | recompute that position from chain data and compare |
| `validateTokens` | check token conservation across the transaction |
| `depth` | how far back to validate token inputs (1-4) |
| `resolveToken` | fill in a transfer's symbol and decimals from its deploy |
| `tokens` | on a txid, only outputs carrying a bsv-20 / bsv-21 token |
| `fast` | fetch only the output script instead of the whole transaction |
| `all` | include envelopes after the first |
| `concat` | join a multi-push body BTC-style (see below) |
| `inscribed` | on a txid, only outputs carrying an inscription |
| `asm` | include script ASM |
| `maxContent` | inline body byte limit for this request |

`encoding=auto` picks per field: text for text-ish values, a number for
`pointer`, and base64 for a binary body — the choice is reported back as
`contentEncodingUsed` / `fields.*.encoding`.

## Sources

Raw transactions are fetched with failover, and the returned bytes must hash to
the requested txid or the source is skipped:

1. **GorillaPool** (`ordinals.gorillapool.io`) — mainnet
2. **WhatsOnChain** — mainnet + testnet
3. **Bitails** — mainnet + testnet (set `BITAILS_API_KEY` to lift rate limits)
4. **Junglebus** (GorillaPool) — mainnet

`GET /v1/providers` shows the chain and cache state. WhatsOnChain and Bitails
can also serve a single output script, which `?fast=1` uses to avoid pulling a
multi-megabyte inscription; that path carries no satoshi value, so `satoshis`
and `isOrdinal` come back `null` with a warning saying why.

## Size, memory, and load

Inscriptions are legitimately large — images, audio, video — so **there is no
download size limit by default**. What is limited is the cost of carrying one:

- Transactions are streamed and parsed **as bytes**, never round-tripped through
  a hex string, which would double the footprint of every video inscription.
- Bodies over `maxContent` (256 KB default) are **not inlined into JSON**. The
  response carries `contentLength`, `contentHash`, and a `contentUrl`; the bytes
  come from `/content` with their real content-type.
- Transactions over `CACHE_MAX_TX_BYTES` (2 MB default) are served but **not
  cached**, so one large file cannot pin its full size in memory for the TTL.
- Concurrent upstream fetches are capped (`MAX_CONCURRENT_FETCHES`, 6) and
  identical in-flight requests are **coalesced into one** — a burst for the same
  popular inscription is a single call upstream, not a burst at the provider.
- A per-IP token bucket (`RATE_LIMIT_RPM`, 120, burst 30) returns `429` with
  `retry-after`. This guards the providers as much as this process: WhatsOnChain
  and Bitails throttle by origin, so one heavy client can otherwise get the whole
  instance limited. Set `RATE_LIMIT=off` to disable, and `TRUST_PROXY` when
  running behind a proxy so real client IPs are seen.

`MAX_TX_BYTES` is available for a public instance that wants a ceiling — `0`
means unlimited. When it is set, an oversized download is aborted mid-stream
rather than buffered, and a single-outpoint request quietly falls back to
fetching just that output script instead of failing.

## Parsing rules

Implements the 1Sat envelope:

```
OP_FALSE OP_IF "ord" <field1> <value1> ... <fieldN> <valueN> OP_0 <content> OP_ENDIF
```

- **All pairs are walked**, not just content-type. Fields the spec doesn't name
  are returned under their hex key.
- **`OP_1`-`OP_16` are aliases** of a single-byte push of 1-16.
- **Repeated fields**: the later value wins, and the repeat is reported in
  `warnings` with an occurrence count, so nothing is dropped silently.
- **One body per envelope.** `OP_0` opens the content and is the last element.
  BTC concatenates every push after it (its 520-byte limit); BSV has no such
  limit and the 1Sat spec says values are *not* concatenated across pushes, so
  the first push is the content, extra pushes are counted in `bodyParts`, and
  `?concat=1` joins them if you need BTC behaviour.
- **Only the first envelope in an output** can be an ordinal; later ones are
  counted in `ignoredEnvelopes` and shown with `?all=1`.
- **1 satoshi**: an envelope on a larger output is reported as an inscription
  but `isOrdinal: false`, with a warning.
- The locking script is whatever sits outside the envelope, in any of the
  spec's arrangements (prepended, appended, or split by `OP_CODESEPARATOR`).
  A trailing `OP_RETURN` is split off, and MAP (`SET`) tags are decoded into
  `opReturn.map`.

Multiple inscriptions in one transaction are normal — one per output. `GET
/v1/tx/:txid` returns them all; `?inscribed=1` keeps only the outputs that
carry one.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /v1/tx/:txid` | every output of a transaction |
| `GET /v1/tx/:txid?validateTokens=1` | token conservation across that transaction |
| `GET /v1/tx/:txid/out/:vout` | one output |
| `GET /v1/outpoint/:outpoint` | one output by inscription id (`txid_vout`, also `:` `.` `-`) |
| `GET /v1/ordinal/:outpoint` | genesis origin + current holder, from either end |
| `GET /v1/ordinal/:outpoint?verify=1` | the same, recomputed from transaction bytes |
| `GET /v1/outpoint/:outpoint/content` | body served with its own content-type |
| `GET /v1/tx/:txid/out/:vout/content` | same, addressed by txid + index |
| `POST /v1/parse` | parse a `rawtx` or bare `script` with no network call |
| `GET /v1/fields` | selectable fields and encodings |
| `GET /v1/providers` | configured sources and cache state |
| `GET /v1/index` | what the local index covers |
| `GET /v1/index/token/:key` | supply and holders from ordered history |
| `GET /v1/index/address/:address` | token balances for an address |
| `GET /v1/index/outpoint/:outpoint` | spent or unspent, answered locally |
| `GET /health` | liveness |
| `GET /metrics` | Prometheus metrics (`?format=json` to read by eye) |

`POST /v1/parse` takes `{ "rawtx": "01000000..." }` or
`{ "script": "76a914...", "satoshis": 1 }` and accepts the same query
parameters, which makes it useful for validating a transaction before
broadcast.

## Building your own index

Everything above answers questions about transactions it fetches on demand.
Some questions cannot be answered that way at all — which deploy claimed a
ticker first, whether a mint still fits under the supply cap, what spent an
output — because they are properties of ordered history rather than of any one
transaction. Those are the ones the API has to mark `notChecked` or
`verified: false`.

The indexer resolves them by doing the one thing an on-demand API cannot:
reading the chain **in order**.

```bash
# one token's own history, without scanning the chain
npm run index -- --token <outpoint> --out index.json

# or block by block
npm run index -- --from 793000 --to 793010 --out index.json
npm run index -- --from 793000 --follow

# then serve it
INDEX_FILE=index.json npm start
```

```bash
curl localhost:3000/v1/index/token/429bf199…_0
# { "symbol": "BLASTER", "supply": "2100000000000000", "supplyDecided": true,
#   "holders": 5, "circulating": "102782500000000" }

curl localhost:3000/v1/index/address/1fMyXg2…
curl localhost:3000/v1/index/outpoint/5dcac02e…_6   # spent or not, answered locally
```

With an index loaded, `lookupSpend` stops asking a third party — the index
recorded the spend when it ingested the block — so `?verify=1` runs against
your own history rather than someone else's.

### What order makes decidable

| Asked of one transaction | Asked of ordered history |
| --- | --- |
| "has this ticker been claimed?" — unknowable | the first deploy is already recorded, so later ones are rejected |
| "does this mint exceed supply?" — unknowable | mints accumulate; the one that crosses the cap is filled to the fraction that fits |
| "were the inputs valid?" — an assumption | only valid outputs were ever written, so an input in the store is valid by construction |
| "what spent this?" — ask an indexer | a lookup |

Reorgs are handled by capturing each block's previous values as it is applied,
so a block that does not build on the tip is rolled back rather than resynced.

### The honest cost

Block-by-block ingest over a public REST API is slow, and the numbers are worth
knowing before you start. No BSV service serves whole raw blocks, so a block
means "list the txids, then fetch those transactions" — twenty at a time, at
about three requests a second before WhatsOnChain throttles you:

| Block | Transactions | Roughly |
| --- | --- | --- |
| 781,000 | 1,942 | 19 seconds *(measured)* |
| 793,000 | 13,025 | ~2 minutes |
| 792,686 (the ORDI deploy) | 254,173 | ~70 minutes |
| 800,000 | 541,261 | hours |

So: `--token` replay for a single token's history (a few hundred fetches),
`--follow` to track the tip, and a node or bulk archive behind the same
`BlockSource` interface for a real full sync. The indexer backs off politely
when throttled — it is a client before it is anything else.

### Storage

`MemoryStore` is the reference implementation, with `toJSON`/`fromJSON` for
snapshots. The interface it satisfies is four record kinds — `utxo`, `token`,
`spend`, `balance` — and every write goes through `apply`, which captures the
previous value so a block can be undone. Point that at SQLite or Postgres and
nothing above it changes.

## Running it

```bash
npm start                                  # http://localhost:3000
LOG_FORMAT=pretty LOG_LEVEL=debug npm run dev

docker build -t ordinal-source-api .
docker run -p 3000:3000 ordinal-source-api
```

The image runs as the `node` user, carries no dev dependencies or tests, and
declares a `HEALTHCHECK` against `/health`. `SIGTERM` drains in-flight requests
before exiting — downloads can be long — and forces exit after
`SHUTDOWN_GRACE_MS` (15s) rather than hanging on a stuck socket.

## Observability

**Logs** are one JSON object per line on stdout (`LOG_FORMAT=pretty` for a
readable dev format, `LOG_LEVEL` from `debug` to `silent`):

```json
{"ts":"…","level":"info","msg":"request","requestId":"a2c387dd-…",
 "method":"GET","route":"/v1/outpoint/:outpoint","status":200,"ms":317}
```

Every request gets an id — an inbound `x-request-id` is honoured so a trace
survives a proxy — echoed in the response header and repeated in the error body,
so a user's failure can be found in the logs from the id alone.

A provider degrading is logged even when the request succeeds by failing over to
the next one, because that is otherwise invisible until every provider is down:

```json
{"level":"warn","msg":"upstream attempt failed","provider":"bitails",
 "outcome":"not_found","status":404,"txid":"10f4465c…"}
```

**Metrics** at `GET /metrics` in Prometheus format, or `?format=json` to read by
eye:

| Metric | What it tells you |
| --- | --- |
| `ordinal_api_http_requests_total` | traffic by route pattern and status |
| `ordinal_api_http_request_seconds` | latency histogram per route |
| `ordinal_api_upstream_requests_total` | per provider: `ok`, `not_found`, `timeout`, `too_large`, `http_5xx` |
| `ordinal_api_upstream_seconds` | how slow each provider is being |
| `ordinal_api_cache_total` | hits and misses, transaction and output |
| `ordinal_api_coalesced_total` | fetches saved by joining an in-flight request |
| `ordinal_api_rate_limited_total` | requests rejected by the bucket |
| `ordinal_api_verify_total` | verification outcomes: match, mismatch, contradicted |
| `ordinal_api_uptime_seconds`, `ordinal_api_memory_bytes` | process health |

Labels are deliberately low cardinality: routes are recorded as patterns
(`/v1/outpoint/:outpoint`), never as concrete paths, so a million txids do not
become a million time series. Unmatched requests are labelled `unmatched`.

`ordinal_api_upstream_requests_total{provider="bitails",outcome="not_found"}`
climbing while gorillapool stays flat is the shape of a provider going bad —
which is exactly what happened to Bitails while this was being built.

## Continuous integration

`.github/workflows/ci.yml` runs on push and pull request:

- **test** — the suite on Node 20 and 22. It is fully offline: fixtures and a
  mocked `fetch`, so CI never depends on a provider being up.
- **smoke** — boots the server and checks `/health`, `/v1/fields`, `/metrics`.
- **docker** — builds the image, runs it, and waits for it to answer.

## Configuration

Copy `.env.example` to `.env`. Everything has a working default:
`PORT`, `HOST`, `NETWORK`, `RAW_TX_TIMEOUT_MS`, `CACHE_MAX`, `CACHE_TTL_MS`,
`MAX_INLINE_CONTENT_BYTES`, `MAX_ENVELOPES_PER_OUTPUT`, `BITAILS_API_KEY`,
`MAX_TX_BYTES`, `CACHE_MAX_TX_BYTES`, `MAX_CONCURRENT_FETCHES`, `MAX_BODY_BYTES`,
`RATE_LIMIT`, `RATE_LIMIT_RPM`, `RATE_LIMIT_BURST`, `TRUST_PROXY`,
`VERIFY_MAX_HOPS`, `VERIFY_MAX_FETCHES`, `TOKEN_VALIDATE_MAX_FETCHES`,
`TOKEN_VALIDATE_MAX_DEPTH`, `LOG_LEVEL`, `LOG_FORMAT`, `SHUTDOWN_GRACE_MS`,
`INDEX_FILE`, `INDEX_START_HEIGHT`, `INDEX_CONCURRENCY`.

## Errors

```json
{ "error": { "code": "not_found", "message": "...", "details": { "attempts": [...] } } }
```

`400` bad txid, outpoint, field, encoding, or network · `404` transaction or
output not found (with what each provider said) · `413` over a configured
`MAX_TX_BYTES` · `429` rate limited (with `retry-after`) · `502` all providers
failed · `504` upstream timeout.

## License

MIT - see [LICENSE](LICENSE).
