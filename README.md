# ordinal-source-api

A read-only HTTP API for [1Sat Ordinals](https://docs.1satordinals.com) on BSV.

Give it a **txid** or an **outpoint**, and optionally name the **ordinal field**
you want, and it returns just that. Every inscription is parsed from the raw
transaction bytes with [`@smartledger/bsv`](https://www.npmjs.com/package/@smartledger/bsv) —
the txid is verified locally, so no indexer is trusted for the parse.

```bash
npm install
npm start          # http://localhost:3000
npm test
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

Each document is validated against the spec rather than merely detected — required
fields per op, `amt` prohibited on `auth`/`deploy+auth`, uint64 range, `dec` ≤ 18,
`id` in `<txid>_<vout>` form, `tick` ≤ 4 characters — and reported as
`valid` with `errors`. Unrecognised JSON fields are preserved in `token.json` and
ignored, as BSV-21 requires. Historical BSV-20 inscriptions using `text/plain` are
still detected, with a warning noting the content type.

Precision belongs to the deploy, not the transfer. A transfer that doesn't
restate `dec` reports `decimals: null` and no `amountDisplay`, plus
`decimalsFrom` naming the deploy to read it from — rather than silently assuming
zero and displaying a wrong number. `?resolveToken=1` fetches that deploy and
fills in symbol, decimals, and the scaled amount.

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

The same enrichment attaches to `/v1/outpoint/...` with `?origin=1`, or
automatically when you select one of those fields. GorillaPool indexes both
directions; WhatsOnChain resolves origin only, so it serves as an origin
fallback. If no indexer answers, the on-chain parse still returns and the
`ordinal` block is marked `unavailable` with what was tried.

## Query parameters

| Param | Meaning |
| --- | --- |
| `field` / `fields` | one selector or a comma-separated list |
| `encoding` | `auto` (default), `utf8`, `hex`, `base64`, `json`, `number`, `id` |
| `raw` | return the single selected field as the response body |
| `network` | `main` (default) or `test` |
| `provider` / `providers` | source order, e.g. `whatsonchain,bitails` |
| `origin` | add genesis origin, current holder, and spend data |
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
| `GET /v1/tx/:txid/out/:vout` | one output |
| `GET /v1/outpoint/:outpoint` | one output by inscription id (`txid_vout`, also `:` `.` `-`) |
| `GET /v1/ordinal/:outpoint` | genesis origin + current holder, from either end |
| `GET /v1/outpoint/:outpoint/content` | body served with its own content-type |
| `GET /v1/tx/:txid/out/:vout/content` | same, addressed by txid + index |
| `POST /v1/parse` | parse a `rawtx` or bare `script` with no network call |
| `GET /v1/fields` | selectable fields and encodings |
| `GET /v1/providers` | configured sources and cache state |
| `GET /health` | liveness |

`POST /v1/parse` takes `{ "rawtx": "01000000..." }` or
`{ "script": "76a914...", "satoshis": 1 }` and accepts the same query
parameters, which makes it useful for validating a transaction before
broadcast.

## Configuration

Copy `.env.example` to `.env`. Everything has a working default:
`PORT`, `HOST`, `NETWORK`, `RAW_TX_TIMEOUT_MS`, `CACHE_MAX`, `CACHE_TTL_MS`,
`MAX_INLINE_CONTENT_BYTES`, `MAX_ENVELOPES_PER_OUTPUT`, `BITAILS_API_KEY`.

## Errors

```json
{ "error": { "code": "not_found", "message": "...", "details": { "attempts": [...] } } }
```

`400` bad txid, outpoint, field, encoding, or network · `404` transaction or
output not found (with what each provider said) · `502` all providers failed ·
`504` upstream timeout.
