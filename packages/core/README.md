# @smartledger/ordinals

The [1Sat Ordinals](https://docs.1satordinals.com) protocol as pure functions:
envelope parsing, ordinal theory arithmetic, and BSV-20 / BSV-21 token rules.

No network, no database, no framework. That is the point — the same code backs
an API, an indexer, a wallet, or a test.

```bash
npm install @smartledger/ordinals
```

## Reading an inscription

```js
import { inscriptionAt, parseEnvelopes } from '@smartledger/ordinals'

const insc = inscriptionAt(output.script, `${txid}_${vout}`)
insc.contentType   // 'image/png'
insc.content       // Buffer
insc.token         // BSV-20 / BSV-21 document, or null
insc.lock          // the locking script, envelope removed
```

`parseEnvelopes` gives the full picture when you need it: every field/value pair
(not just content-type), `OP_1`-`OP_16` aliases normalised, repeated fields
resolved last-wins with the repeats reported, multi-push bodies counted, and
every envelope in the script — only the first of which can be an ordinal.

## Token rules

```js
import { detectToken } from '@smartledger/ordinals'

const token = detectToken({ body, contentType, outpoint })
token.standard    // 'BSV-20' (tick) | 'BSV-21' (id)
token.wellFormed  // the document is correctly shaped for its op
token.validated   // 'document' - see below
```

`wellFormed` is not `valid`. It says one document is correctly shaped; it says
nothing about conservation, supply, or ticker priority, which are properties of
a chain rather than of an output. `notValidated` names them so the difference
cannot be missed.

## Ordinal theory

The nth satoshi in is the nth satoshi out. These functions are that rule:

```js
import { followForward, followBackward, outputAtOffset } from '@smartledger/ordinals'

followBackward(tx, vout, 0, inputValues)  // where did this satoshi come from
followForward(spendingTx, outpoint, 0, inputValues)  // where did it go
outputAtOffset(tx, offset)  // { vout, satoshis } or { burned: 'fee' }
```

Absolute satoshi offsets make the mapping an identity, so the same two functions
trace an ordinal to its origin, follow it to its holder, and tell a transfer
apart from a burn.

## What is here

| | |
| --- | --- |
| `parseEnvelopes`, `inscriptionAt`, `tokenAt`, `tokenOutputs` | inscriptions |
| `detectToken`, `classifyToken`, `applyDeploy` | BSV-20 / BSV-21 |
| `followForward`, `followBackward`, `outputAtOffset`, `inputAtOffset`, `inputOutpoint`, `inputSpending`, `outputOffset` | ordinal theory |
| `FIELD_DEFS`, `resolveField`, `encodeValue`, `effectiveEncoding` | envelope fields |
| `parseOutpoint`, `formatOutpoint`, `assertTxid` | outpoints |

Built on [`@smartledger/bsv`](https://www.npmjs.com/package/@smartledger/bsv).

MIT.
