/**
 * PNG character-card parsing and encoding (SillyTavern/TauriTavern
 * convention): the card JSON is Base64(UTF-8(JSON)) stored in a PNG text
 * chunk. Keyword priority: `ccv3` (v3 cards) wins over `chara` (v2 cards).
 * tEXt is the standard carrier; zTXt/iTXt are tolerated for robustness.
 */

import zlib from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CHARA_KEYWORD = 'chara'
const CCV3_KEYWORD = 'ccv3'

interface PngChunk {
  type: string
  data: Buffer
  /** The complete chunk: length + type + data + CRC. */
  raw: Buffer
}

function isTextChunk(type: string): boolean {
  return type === 'tEXt' || type === 'zTXt' || type === 'iTXt'
}

/** Read one complete PNG chunk at `offset`, or null when truncated. */
function chunkAt(buffer: Buffer, offset: number): PngChunk | null {
  if (offset + 8 > buffer.length) return null
  const length = buffer.readUInt32BE(offset)
  const dataStart = offset + 8
  const dataEnd = dataStart + length
  if (dataEnd + 4 > buffer.length) return null
  return {
    type: buffer.subarray(offset + 4, offset + 8).toString('ascii'),
    data: buffer.subarray(dataStart, dataEnd),
    raw: buffer.subarray(offset, dataEnd + 4),
  }
}

/** Parse the character card JSON out of a PNG buffer. */
export function parsePngCard(buffer: Buffer): { json: string; avatar?: Buffer } | null {
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null
  }
  const imageChunks: Buffer[] = []
  let ended = false
  let offset = 8
  let charaText: string | undefined
  let ccv3Text: string | undefined

  while (true) {
    const current = chunkAt(buffer, offset)
    if (current === null) break
    // Build the avatar from every non-text chunk before IEND. Text chunks are
    // card metadata and must not become part of the exported image region.
    if (!ended) {
      if (!isTextChunk(current.type)) imageChunks.push(current.raw)
      if (current.type === 'IEND') ended = true
    }
    if (isTextChunk(current.type)) {
      const text = parseTextChunk(current.type, current.data)
      if (text !== null) {
        const keyword = text.keyword.toLowerCase()
        // The first *decodable* chunk wins for each keyword: some exporters
        // append a second, empty `ccv3`/`chara` chunk, and letting it through
        // would blank out the card the earlier chunk already carried.
        if (keyword === CCV3_KEYWORD && ccv3Text === undefined) {
          const decoded = decodeCardText(text.payload)
          if (decoded !== undefined) ccv3Text = decoded
        } else if (keyword === CHARA_KEYWORD && charaText === undefined) {
          const decoded = decodeCardText(text.payload)
          if (decoded !== undefined) charaText = decoded
        }
      }
    }
    offset += current.raw.length
  }

  const json = ccv3Text ?? charaText
  if (json === undefined) return null
  const avatar = ended && imageChunks.length > 0
    ? Buffer.concat([PNG_SIGNATURE, ...imageChunks])
    : undefined
  return { json, avatar }
}

interface ParsedText {
  keyword: string
  /**
   * The payload bytes, inflated for zTXt/iTXt but otherwise untouched: the
   * card text is either Base64 (pure ASCII) or raw UTF-8 JSON, and only the
   * decoder can tell which, so the encoding choice must not be made here.
   */
  payload: Buffer
}

/** Hard cap on inflated card text: a real card is tens of KB; a crafted
    zTXt/iTXt block can otherwise expand to gigabytes (decompression bomb). */
const MAX_CARD_TEXT_BYTES = 8 * 1024 * 1024

function inflateBounded(compressed: Buffer): Buffer {
  return zlib.inflateSync(compressed, { maxOutputLength: MAX_CARD_TEXT_BYTES })
}

function parseTextChunk(type: string, data: Buffer): ParsedText | null {
  const nul = data.indexOf(0)
  if (nul < 0) return null
  const keyword = data.subarray(0, nul).toString('latin1')
  const payload = data.subarray(nul + 1)
  try {
    if (type === 'tEXt') {
      return { keyword, payload }
    }
    if (type === 'zTXt') {
      // byte 0 = compression method (0 = zlib).
      if (payload.length < 1 || payload[0] !== 0) return null
      const compressed = payload.subarray(1)
      return { keyword, payload: inflateBounded(compressed) }
    }
    if (type === 'iTXt') {
      const compressionFlag = payload[0]
      const langNul = payload.indexOf(0, 2)
      if (langNul < 0) return null
      const keyNul = payload.indexOf(0, langNul + 1)
      if (keyNul < 0) return null
      const raw = payload.subarray(keyNul + 1)
      return { keyword, payload: compressionFlag === 1 ? inflateBounded(raw) : raw }
    }
  } catch {
    return null
  }
  return null
}

function decodeCardText(payload: Buffer): string | undefined {
  // Base64 is ASCII, so the Latin-1 view is a faithful lens on the encoded
  // form and — unlike a UTF-8 read — never injects replacement characters.
  const trimmed = payload.toString('latin1').trim()
  if (trimmed === '') return undefined
  // Standard cards base64-encode the JSON; some tools store plain JSON.
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8')
    if (decoded.trimStart().startsWith('{')) return decoded
  } catch {
    // Not base64; fall through to plain text.
  }
  // Plain JSON has to be read as UTF-8: tEXt is nominally Latin-1, but every
  // real writer emits UTF-8 bytes, and a Latin-1 read mangles non-ASCII names
  // into mojibake that still parses as JSON — silent corruption.
  const plain = payload.toString('utf8').trim()
  if (plain.startsWith('{')) return plain
  return undefined
}

// ── Encoding (PNG export) ──────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Append one PNG chunk (length + type + data + CRC). */
function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([length, typeBuf, data, crc])
}

/** Extract image chunks (IHDR..IEND, no text chunks) from an avatar PNG. */
function imageChunks(avatar: Buffer): PngChunk[] | null {
  if (avatar.length < PNG_SIGNATURE.length || !avatar.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null
  }
  const chunks: PngChunk[] = []
  let offset = 8
  let ended = false
  while (true) {
    const current = chunkAt(avatar, offset)
    if (current === null) break
    if (current.type === 'IEND') {
      chunks.push(current)
      ended = true
      break
    }
    if (!isTextChunk(current.type)) chunks.push(current)
    offset += current.raw.length
  }
  // Repair old truncated avatars that were cut before IEND.
  if (!ended) chunks.push({ type: 'IEND', data: Buffer.alloc(0), raw: chunk('IEND', Buffer.alloc(0)) })
  if (chunks[0]?.type !== 'IHDR' || !chunks.some(c => c.type === 'IDAT')) return null
  return chunks
}

/** A minimal 1x1 transparent PNG chunk list. */
function blankPngChunks(): PngChunk[] {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const idat = zlib.deflateSync(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]))
  return [
    { type: 'IHDR', data: ihdr, raw: chunk('IHDR', ihdr) },
    { type: 'IDAT', data: idat, raw: chunk('IDAT', idat) },
    { type: 'IEND', data: Buffer.alloc(0), raw: chunk('IEND', Buffer.alloc(0)) },
  ]
}

/**
 * Build a PNG carrying the card JSON in a tEXt chunk (Base64-encoded value,
 * keyword `chara`). The text chunk is inserted BEFORE IEND, as PNG requires.
 * When `avatar` is a PNG buffer its image chunks are reused; otherwise a 1x1
 * transparent PNG is emitted.
 *
 * `avatarEmbedded` exists because the avatar store also accepts jpeg/webp/gif
 * and this encoder has no transcoder: those formats fall back to the blank
 * image, which is indistinguishable from "no avatar" in the output bytes. The
 * flag lets a caller warn the user instead of shipping a blank card silently.
 */
export function encodePngCardResult(json: string, avatar?: Buffer): { png: Buffer; avatarEmbedded: boolean } {
  const embedded = avatar !== undefined ? imageChunks(avatar) : null
  const chunks = embedded ?? blankPngChunks()
  const textData = Buffer.concat([
    Buffer.from(`${CHARA_KEYWORD}\0`, 'latin1'),
    Buffer.from(Buffer.from(json, 'utf8').toString('base64'), 'latin1'),
  ])
  const textChunk = chunk('tEXt', textData)
  const iendIndex = chunks.findIndex(c => c.type === 'IEND')
  chunks.splice(iendIndex < 0 ? chunks.length : iendIndex, 0, {
    type: 'tEXt',
    data: textData,
    raw: textChunk,
  })
  return {
    png: Buffer.concat([PNG_SIGNATURE, ...chunks.map(c => c.raw)]),
    avatarEmbedded: embedded !== null,
  }
}

/** {@link encodePngCardResult} without the avatar-embedding report. */
export function encodePngCard(json: string, avatar?: Buffer): Buffer {
  return encodePngCardResult(json, avatar).png
}
