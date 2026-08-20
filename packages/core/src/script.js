import bsv from '@smartledger/bsv'

const { Opcode, Script } = bsv

export { Script, Opcode }

/**
 * Chunks produced by bsv.Script look like:
 *   push        -> { opcodenum: 1..78, buf: Buffer, len }
 *   OP_0        -> { opcodenum: 0 }                    (an empty push)
 *   OP_1..OP_16 -> { opcodenum: 81..96 }               (small-number opcodes)
 *   other op    -> { opcodenum }
 */

export const isOp = (chunk, op) => !!chunk && chunk.opcodenum === op && !chunk.buf

export const isDataPush = (chunk) => !!chunk && Buffer.isBuffer(chunk.buf)

export const isSmallNum = (chunk) =>
  !!chunk && !chunk.buf && chunk.opcodenum >= Opcode.OP_1 && chunk.opcodenum <= Opcode.OP_16

/**
 * `OP_1`-`OP_16` are aliases of a single-byte push of 1-16, per the 1Sat spec.
 * Returns the bytes a chunk contributes as a field key or value, or null when
 * the chunk is not a push at all.
 */
export function chunkBytes (chunk) {
  if (isDataPush(chunk)) return chunk.buf
  if (isOp(chunk, Opcode.OP_0)) return Buffer.alloc(0)
  if (isSmallNum(chunk)) return Buffer.from([chunk.opcodenum - Opcode.OP_1 + 1])
  return null
}

/** A field key MUST be a single PUSH_DATA or OP_1-OP_16 (never OP_0 — that marks the body). */
export const isFieldChunk = (chunk) => isDataPush(chunk) || isSmallNum(chunk)

/** A field value MUST be a single PUSH_DATA, OP_0, or OP_1-OP_16. */
export const isValueChunk = (chunk) =>
  isDataPush(chunk) || isSmallNum(chunk) || isOp(chunk, Opcode.OP_0)

/** Accepts a Script, Buffer, hex string, or ASM string. */
export function toScript (input) {
  if (input instanceof Script) return input
  if (Buffer.isBuffer(input)) return Script.fromBuffer(input)
  if (typeof input === 'string') {
    const s = input.trim()
    if (/^[0-9a-fA-F]*$/.test(s) && s.length % 2 === 0) return Script.fromHex(s)
    return Script.fromASM(s)
  }
  throw new TypeError('script must be a Script, Buffer, hex string, or ASM string')
}

/** Rebuilds a Script from a chunk range, e.g. to isolate a locking script. */
export function scriptFromChunks (chunks) {
  const s = new Script()
  for (const c of chunks) s.chunks.push(c)
  return s
}
