/**
 * A small TrueType reader and subsetter.
 *
 * Why not fontkit: its subsetter throws on common fonts, and embedding whole fonts makes a one-line PDF 200-300 KB.
 * The converters only need a few things from a font: which glyph a character maps to, how wide each glyph is, the
 * vertical metrics, and a copy of the font that holds only the glyphs the document uses. Glyph numbers are kept
 * as they are (unused glyphs are emptied, and the tail is cut), so the PDF can address glyphs by their original number.
 *
 * Only TrueType outlines (the `glyf` table) are supported, which is what the bundled fonts use.
 */
import { zlibSync } from "fflate";

export interface TtfFont {
  readonly unitsPerEm: number;
  /** Space above the baseline in a text line, in font units (includes the font's line gap). */
  readonly ascent: number;
  /** Space below the baseline in a text line, in font units. */
  readonly descent: number;
  readonly capHeight: number;
  readonly xHeight: number;
  /** Degrees counter-clockwise from vertical; 0 for upright fonts, negative for italic. */
  readonly italicAngle: number;
  /** Glyph bounding box of the whole font, in font units: [xMin, yMin, xMax, yMax]. */
  readonly bbox: readonly [number, number, number, number];
  readonly glyphCount: number;
  /** The glyph for a character, or 0 (".notdef") when the font has none. */
  glyphFor(codePoint: number): number;
  has(codePoint: number): boolean;
  /** Advance width of a glyph in font units. */
  advance(glyphId: number): number;
  /** A TrueType file holding only these glyphs (and .notdef), with their original numbers. */
  subset(glyphIds: Iterable<number>): Uint8Array;
}

class Reader {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8 = (at: number) => this.view.getUint8(at);
  u16 = (at: number) => this.view.getUint16(at);
  i16 = (at: number) => this.view.getInt16(at);
  u32 = (at: number) => this.view.getUint32(at);
}

interface TableRecord {
  offset: number;
  length: number;
}

const GLYF_FLAGS = { ARG_WORDS: 0x0001, HAVE_SCALE: 0x0008, MORE: 0x0020, XY_SCALE: 0x0040, TWO_BY_TWO: 0x0080 };

export class FontParseError extends Error {}

export function parseTtf(bytes: Uint8Array): TtfFont {
  const r = new Reader(bytes);
  if (bytes.length < 12) throw new FontParseError("The font file is too short.");
  const version = r.u32(0);
  if (version === 0x4f54544f) throw new FontParseError("OpenType fonts with CFF outlines are not supported.");
  if (version !== 0x00010000 && version !== 0x74727565) throw new FontParseError("This is not a TrueType font.");
  const tableCount = r.u16(4);
  const tables = new Map<string, TableRecord>();
  for (let i = 0; i < tableCount; i += 1) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(r.u8(at), r.u8(at + 1), r.u8(at + 2), r.u8(at + 3));
    const offset = r.u32(at + 8);
    const length = r.u32(at + 12);
    if (offset + length > bytes.length) throw new FontParseError(`The font table "${tag}" runs past the end of the file.`);
    tables.set(tag, { offset, length });
  }
  const need = (tag: string): TableRecord => {
    const table = tables.get(tag);
    if (!table) throw new FontParseError(`The font has no "${tag}" table.`);
    return table;
  };

  const head = need("head");
  const hhea = need("hhea");
  const maxp = need("maxp");
  const hmtx = need("hmtx");
  const loca = need("loca");
  const glyf = need("glyf");

  const unitsPerEm = r.u16(head.offset + 18) || 1000;
  const bbox: [number, number, number, number] = [r.i16(head.offset + 36), r.i16(head.offset + 38), r.i16(head.offset + 40), r.i16(head.offset + 42)];
  const locaLong = r.i16(head.offset + 50) === 1;
  const glyphCount = r.u16(maxp.offset + 4);

  const hheaAscent = r.i16(hhea.offset + 4);
  const hheaDescent = r.i16(hhea.offset + 6);
  const hheaGap = r.i16(hhea.offset + 8);
  const metricCount = r.u16(hhea.offset + 34);

  // Vertical metrics the way Word lays out a "single" line: the larger of the font's own line spacing and the Windows box.
  let winAscent = 0;
  let winDescent = 0;
  let capHeight = 0;
  let xHeight = 0;
  const os2 = tables.get("OS/2");
  if (os2 && os2.length >= 78) {
    winAscent = r.u16(os2.offset + 74);
    winDescent = r.u16(os2.offset + 76);
    if (os2.length >= 90 && r.u16(os2.offset) >= 2) {
      xHeight = r.i16(os2.offset + 86);
      capHeight = r.i16(os2.offset + 88);
    }
  }
  const hheaLine = hheaAscent - hheaDescent + hheaGap;
  const winLine = winAscent + winDescent;
  const lineUnits = Math.max(hheaLine, winLine) || unitsPerEm * 1.2;
  const descent = Math.max(-hheaDescent, winDescent) || Math.round(unitsPerEm * 0.2);
  const ascent = lineUnits - descent;
  if (!capHeight) capHeight = Math.round(ascent * 0.7);
  if (!xHeight) xHeight = Math.round(capHeight * 0.72);

  let italicAngle = 0;
  const post = tables.get("post");
  if (post && post.length >= 8) italicAngle = r.i16(post.offset + 4) + r.u16(post.offset + 6) / 65536;

  // ---- character map
  const cmapTable = need("cmap");
  const charMap = readCmap(r, cmapTable);

  const advance = (glyphId: number): number => {
    if (glyphId < 0 || glyphId >= glyphCount || metricCount === 0) return 0;
    const index = Math.min(glyphId, metricCount - 1);
    return r.u16(hmtx.offset + index * 4);
  };

  const glyphRange = (glyphId: number): [number, number] => {
    if (locaLong) return [r.u32(loca.offset + glyphId * 4), r.u32(loca.offset + (glyphId + 1) * 4)];
    return [r.u16(loca.offset + glyphId * 2) * 2, r.u16(loca.offset + (glyphId + 1) * 2) * 2];
  };

  return {
    unitsPerEm,
    ascent,
    descent,
    capHeight,
    xHeight,
    italicAngle,
    bbox,
    glyphCount,
    glyphFor: (codePoint) => charMap.get(codePoint) ?? 0,
    has: (codePoint) => (charMap.get(codePoint) ?? 0) !== 0,
    advance,
    subset: (glyphIds) => {
      // 1. Every glyph that is used, plus the glyphs that composite glyphs (letters with accents) are made of.
      const keep = new Set<number>([0]);
      const queue: number[] = [];
      for (const id of glyphIds) {
        if (id > 0 && id < glyphCount && !keep.has(id)) {
          queue.push(id);
          keep.add(id);
        }
      }
      for (let i = 0; i < queue.length; i += 1) {
        const [start, end] = glyphRange(queue[i] as number);
        if (end <= start) continue;
        const at = glyf.offset + start;
        if (r.i16(at) >= 0) continue; // a simple glyph
        let cursor = at + 10;
        for (let guard = 0; guard < 64; guard += 1) {
          const flags = r.u16(cursor);
          const component = r.u16(cursor + 2);
          if (component < glyphCount && !keep.has(component)) {
            keep.add(component);
            queue.push(component);
          }
          cursor += 4 + (flags & GLYF_FLAGS.ARG_WORDS ? 4 : 2);
          if (flags & GLYF_FLAGS.HAVE_SCALE) cursor += 2;
          else if (flags & GLYF_FLAGS.XY_SCALE) cursor += 4;
          else if (flags & GLYF_FLAGS.TWO_BY_TWO) cursor += 8;
          if (!(flags & GLYF_FLAGS.MORE)) break;
        }
      }
      keep.add(0);
      const lastKept = Math.max(...keep);
      const newCount = lastKept + 1;

      // 2. A new glyf table with only those glyphs, and a long-format loca for it.
      const chunks: Uint8Array[] = [];
      const newLoca = new Uint8Array((newCount + 1) * 4);
      const locaView = new DataView(newLoca.buffer);
      let glyfLength = 0;
      for (let id = 0; id < newCount; id += 1) {
        locaView.setUint32(id * 4, glyfLength);
        if (!keep.has(id)) continue;
        const [start, end] = glyphRange(id);
        if (end <= start) continue;
        const piece = bytes.subarray(glyf.offset + start, glyf.offset + end);
        const padded = new Uint8Array((piece.length + 3) & ~3);
        padded.set(piece);
        chunks.push(padded);
        glyfLength += padded.length;
      }
      locaView.setUint32(newCount * 4, glyfLength);
      const newGlyf = concat(chunks);

      // 3. Metrics cut to the same length, and the small tables copied over.
      const newMetricCount = Math.min(metricCount, newCount);
      const newHmtx = new Uint8Array(newMetricCount * 4 + (newCount - newMetricCount) * 2);
      newHmtx.set(bytes.subarray(hmtx.offset, hmtx.offset + newMetricCount * 4));
      if (newCount > newMetricCount) {
        const sideBearings = hmtx.offset + metricCount * 4;
        for (let id = newMetricCount; id < newCount; id += 1) {
          const from = sideBearings + (id - metricCount) * 2;
          if (from + 2 <= hmtx.offset + hmtx.length) newHmtx.set(bytes.subarray(from, from + 2), newMetricCount * 4 + (id - newMetricCount) * 2);
        }
      }
      const newHead = copy(bytes, head);
      new DataView(newHead.buffer).setInt16(50, 1); // long loca
      new DataView(newHead.buffer).setUint32(8, 0); // checksum adjustment, set below
      const newHhea = copy(bytes, hhea);
      new DataView(newHhea.buffer).setUint16(34, newMetricCount);
      const newMaxp = copy(bytes, maxp);
      new DataView(newMaxp.buffer).setUint16(4, newCount);
      const newPost = new Uint8Array(32); // version 3.0: no glyph names
      new DataView(newPost.buffer).setUint32(0, 0x00030000);

      const parts: [string, Uint8Array][] = [
        ["glyf", newGlyf],
        ["head", newHead],
        ["hhea", newHhea],
        ["hmtx", newHmtx],
        ["loca", newLoca],
        ["maxp", newMaxp],
        ["post", newPost],
      ];
      for (const tag of ["cvt ", "fpgm", "prep"]) {
        const table = tables.get(tag);
        if (table) parts.push([tag, bytes.slice(table.offset, table.offset + table.length)]);
      }
      return assemble(parts);
    },
  };
}

function copy(bytes: Uint8Array, table: TableRecord): Uint8Array {
  return bytes.slice(table.offset, table.offset + table.length);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function checksum(data: Uint8Array): number {
  let sum = 0;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const whole = data.length & ~3;
  for (let i = 0; i < whole; i += 4) sum = (sum + view.getUint32(i)) >>> 0;
  if (data.length > whole) {
    let last = 0;
    for (let i = whole; i < data.length; i += 1) last |= (data[i] as number) << (24 - 8 * (i - whole));
    sum = (sum + (last >>> 0)) >>> 0;
  }
  return sum;
}

/** Writes a TrueType file from named tables: directory sorted by tag, 4-byte aligned, checksums, and the head adjustment. */
function assemble(parts: [string, Uint8Array][]): Uint8Array {
  parts.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const count = parts.length;
  let power = 1;
  let log = 0;
  while (power * 2 <= count) {
    power *= 2;
    log += 1;
  }
  const directorySize = 12 + count * 16;
  let offset = directorySize;
  const offsets = parts.map(([, data]) => {
    const at = offset;
    offset += (data.length + 3) & ~3;
    return at;
  });
  const out = new Uint8Array(offset);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, count);
  view.setUint16(6, power * 16);
  view.setUint16(8, log);
  view.setUint16(10, count * 16 - power * 16);
  let headAt = -1;
  parts.forEach(([tag, data], index) => {
    const at = 12 + index * 16;
    for (let i = 0; i < 4; i += 1) out[at + i] = tag.charCodeAt(i);
    view.setUint32(at + 4, checksum(data));
    view.setUint32(at + 8, offsets[index] as number);
    view.setUint32(at + 12, data.length);
    out.set(data, offsets[index] as number);
    if (tag === "head") headAt = offsets[index] as number;
  });
  if (headAt >= 0) view.setUint32(headAt + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out;
}

/** Compresses a font program for a PDF FontFile2 stream. */
export function deflate(data: Uint8Array): Uint8Array {
  return zlibSync(data, { level: 9 });
}

// ---- character map ---------------------------------------------------------------------------------

function readCmap(r: Reader, table: TableRecord): Map<number, number> {
  const count = r.u16(table.offset + 2);
  const candidates: { platform: number; encoding: number; offset: number; format: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = table.offset + 4 + i * 8;
    const platform = r.u16(at);
    const encoding = r.u16(at + 2);
    const offset = table.offset + r.u32(at + 4);
    candidates.push({ platform, encoding, offset, format: r.u16(offset) });
  }
  const rank = (c: (typeof candidates)[number]): number => {
    if (c.platform === 3 && c.encoding === 10) return 6;
    if (c.platform === 0 && c.format === 12) return 5;
    if (c.platform === 3 && c.encoding === 1) return 4;
    if (c.platform === 0) return 3;
    if (c.platform === 3 && c.encoding === 0) return 2;
    if (c.platform === 1) return 1;
    return 0;
  };
  const best = candidates.filter((c) => [0, 4, 6, 12].includes(c.format)).sort((a, b) => rank(b) - rank(a))[0];
  if (!best) throw new FontParseError("The font has no usable character map.");
  const map = new Map<number, number>();
  const symbol = best.platform === 3 && best.encoding === 0;
  const put = (code: number, glyph: number) => {
    if (glyph === 0) return;
    map.set(code, glyph);
    // Symbol fonts keep their characters at U+F000 and up; also make them reachable at the plain code.
    if (symbol && code >= 0xf000 && code <= 0xf0ff) map.set(code - 0xf000, glyph);
  };
  const at = best.offset;
  if (best.format === 0) {
    for (let code = 0; code < 256; code += 1) put(code, r.u8(at + 6 + code));
  } else if (best.format === 6) {
    const first = r.u16(at + 6);
    const entries = r.u16(at + 8);
    for (let i = 0; i < entries; i += 1) put(first + i, r.u16(at + 10 + i * 2));
  } else if (best.format === 4) {
    const segments = r.u16(at + 6) / 2;
    const endCodes = at + 14;
    const startCodes = endCodes + segments * 2 + 2;
    const deltas = startCodes + segments * 2;
    const rangeOffsets = deltas + segments * 2;
    for (let s = 0; s < segments; s += 1) {
      const end = r.u16(endCodes + s * 2);
      const start = r.u16(startCodes + s * 2);
      const delta = r.i16(deltas + s * 2);
      const rangeOffset = r.u16(rangeOffsets + s * 2);
      if (start > end) continue;
      for (let code = start; code <= end && code < 0xffff; code += 1) {
        let glyph: number;
        if (rangeOffset === 0) {
          glyph = (code + delta) & 0xffff;
        } else {
          const index = rangeOffsets + s * 2 + rangeOffset + (code - start) * 2;
          if (index + 2 > r.bytes.length) continue;
          glyph = r.u16(index);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        put(code, glyph);
      }
    }
  } else {
    const groups = r.u32(at + 12);
    for (let g = 0; g < groups; g += 1) {
      const base = at + 16 + g * 12;
      const start = r.u32(base);
      const end = r.u32(base + 4);
      const glyph = r.u32(base + 8);
      if (end < start || end - start > 0x10ffff) continue;
      for (let code = start; code <= end; code += 1) put(code, glyph + (code - start));
    }
  }
  return map;
}
