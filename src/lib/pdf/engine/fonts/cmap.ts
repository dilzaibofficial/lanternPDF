import { type Operand, parseContentStream } from "../tokenizer";

/**
 * Parser for the CMap programs found in PDFs: the `/ToUnicode` map of a font (character code to text) and the
 * `/Encoding` CMap of a composite font (character code to CID, plus how many bytes make one code).
 *
 * A CMap is PostScript, but every real one is a flat list of `begin…`/`end…` blocks, which the content-stream
 * tokenizer already reads: the operands before an `end…` operator are the entries of the block.
 */

export interface CodeSpace {
  lo: number;
  hi: number;
  /** Number of bytes in a code of this range. */
  bytes: number;
}

interface Range {
  lo: number;
  hi: number;
}

interface UnicodeRange extends Range {
  /** Text for `lo`; later codes increment its last UTF-16 unit. */
  text: string;
}

interface UnicodeList extends Range {
  texts: string[];
}

interface CidRange extends Range {
  cid: number;
}

export interface CMap {
  name: string | null;
  /** 0 horizontal, 1 vertical. */
  wmode: 0 | 1;
  codespaces: CodeSpace[];
  /** Another CMap this one builds on (`/Name usecmap`). */
  useCMap: string | null;
  unicodeChars: Map<number, string>;
  unicodeRanges: UnicodeRange[];
  unicodeLists: UnicodeList[];
  cidChars: Map<number, number>;
  cidRanges: CidRange[];
}

const MAX_ENTRIES = 200_000;

function codeOf(bytes: Uint8Array): number {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

/** UTF-16BE bytes to a string. Odd trailing bytes are ignored. */
export function utf16beToString(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) text += String.fromCharCode(((bytes[i] as number) << 8) | (bytes[i + 1] as number));
  // A one-byte destination is written as a single Latin-1 byte by a few generators.
  if (bytes.length === 1) text = String.fromCharCode(bytes[0] as number);
  return text;
}

const asString = (operand: Operand | undefined): { bytes: Uint8Array } | null => (operand && operand.t === "str" ? { bytes: operand.bytes } : null);

export function parseCMap(data: Uint8Array): CMap {
  const cmap: CMap = {
    name: null,
    wmode: 0,
    codespaces: [],
    useCMap: null,
    unicodeChars: new Map(),
    unicodeRanges: [],
    unicodeLists: [],
    cidChars: new Map(),
    cidRanges: [],
  };
  const { ops } = parseContentStream(data, { maxOps: 100_000, maxOperands: 1_000_000 });
  let total = 0;

  for (const op of ops) {
    const args = op.args;
    switch (op.op) {
      case "def": {
        const key = args[0];
        const value = args[1];
        if (key?.t === "name" && key.v === "CMapName" && value?.t === "name") cmap.name = value.v;
        if (key?.t === "name" && key.v === "WMode" && value?.t === "num") cmap.wmode = value.v === 1 ? 1 : 0;
        break;
      }
      case "usecmap": {
        const name = args[args.length - 1];
        if (name?.t === "name") cmap.useCMap = name.v;
        break;
      }
      case "endcodespacerange":
        for (let i = 0; i + 1 < args.length; i += 2) {
          const lo = asString(args[i]);
          const hi = asString(args[i + 1]);
          if (lo && hi && lo.bytes.length > 0 && lo.bytes.length <= 4) cmap.codespaces.push({ lo: codeOf(lo.bytes), hi: codeOf(hi.bytes), bytes: lo.bytes.length });
        }
        break;
      case "endbfchar":
        for (let i = 0; i + 1 < args.length && total < MAX_ENTRIES; i += 2) {
          const src = asString(args[i]);
          const dst = asString(args[i + 1]);
          if (src && dst) {
            cmap.unicodeChars.set(codeOf(src.bytes), utf16beToString(dst.bytes));
            total += 1;
          }
        }
        break;
      case "endbfrange":
        for (let i = 0; i + 2 < args.length && total < MAX_ENTRIES; i += 3) {
          const lo = asString(args[i]);
          const hi = asString(args[i + 1]);
          const dst = args[i + 2];
          if (!lo || !hi || !dst) continue;
          const first = codeOf(lo.bytes);
          const last = codeOf(hi.bytes);
          if (last < first) continue;
          if (dst.t === "arr") {
            const texts: string[] = [];
            for (const item of dst.items) {
              const s = asString(item);
              texts.push(s ? utf16beToString(s.bytes) : "");
            }
            cmap.unicodeLists.push({ lo: first, hi: Math.min(last, first + texts.length - 1), texts });
          } else {
            const s = asString(dst);
            if (s) cmap.unicodeRanges.push({ lo: first, hi: last, text: utf16beToString(s.bytes) });
          }
          total += 1;
        }
        break;
      case "endcidchar":
        for (let i = 0; i + 1 < args.length && total < MAX_ENTRIES; i += 2) {
          const src = asString(args[i]);
          const cid = args[i + 1];
          if (src && cid?.t === "num") {
            cmap.cidChars.set(codeOf(src.bytes), cid.v);
            total += 1;
          }
        }
        break;
      case "endcidrange":
        for (let i = 0; i + 2 < args.length && total < MAX_ENTRIES; i += 3) {
          const lo = asString(args[i]);
          const hi = asString(args[i + 1]);
          const cid = args[i + 2];
          if (lo && hi && cid?.t === "num") {
            cmap.cidRanges.push({ lo: codeOf(lo.bytes), hi: codeOf(hi.bytes), cid: cid.v });
            total += 1;
          }
        }
        break;
      default:
        break;
    }
  }
  return cmap;
}

/** The text a ToUnicode map gives for `code`, or `undefined` when it has no entry. */
export function unicodeFromCMap(cmap: CMap, code: number): string | undefined {
  const direct = cmap.unicodeChars.get(code);
  if (direct !== undefined) return direct;
  for (const range of cmap.unicodeRanges) {
    if (code >= range.lo && code <= range.hi) {
      const offset = code - range.lo;
      if (offset === 0 || range.text === "") return range.text;
      const last = range.text.charCodeAt(range.text.length - 1) + offset;
      return range.text.slice(0, -1) + String.fromCharCode(last & 0xffff);
    }
  }
  for (const list of cmap.unicodeLists) {
    if (code >= list.lo && code <= list.hi) return list.texts[code - list.lo];
  }
  return undefined;
}

/** Every `[code, text]` the map defines, up to a cap, for building the reverse (text to code) table. */
export function* unicodeEntries(cmap: CMap, cap = 70_000): Generator<[number, string]> {
  let count = 0;
  for (const [code, text] of cmap.unicodeChars) {
    yield [code, text];
    if ((count += 1) >= cap) return;
  }
  for (const range of cmap.unicodeRanges) {
    for (let code = range.lo; code <= range.hi; code += 1) {
      const text = unicodeFromCMap({ ...cmap, unicodeChars: new Map(), unicodeLists: [], unicodeRanges: [range] }, code);
      if (text !== undefined) yield [code, text];
      if ((count += 1) >= cap) return;
    }
  }
  for (const list of cmap.unicodeLists) {
    for (let code = list.lo; code <= list.hi; code += 1) {
      const text = list.texts[code - list.lo];
      if (text !== undefined) yield [code, text];
      if ((count += 1) >= cap) return;
    }
  }
}

/** CID for a code in an embedded CMap (`undefined` when unmapped). */
export function cidFromCMap(cmap: CMap, code: number): number | undefined {
  const direct = cmap.cidChars.get(code);
  if (direct !== undefined) return direct;
  for (const range of cmap.cidRanges) {
    if (code >= range.lo && code <= range.hi) return range.cid + (code - range.lo);
  }
  return undefined;
}

/**
 * Splits `bytes` into character codes according to the code space ranges, as a CMap does: a code is as long as
 * the first code space range it matches. Bytes matching no range are consumed as one code of the shortest length.
 */
export function splitCodes(bytes: Uint8Array, codespaces: readonly CodeSpace[]): { code: number; length: number }[] {
  const out: { code: number; length: number }[] = [];
  const lengths = [...new Set(codespaces.map((space) => space.bytes))].sort((a, b) => a - b);
  const shortest = lengths[0] ?? 1;
  let at = 0;
  while (at < bytes.length) {
    let matched = 0;
    let code = 0;
    for (const length of lengths) {
      if (at + length > bytes.length) break;
      code = codeOf(bytes.subarray(at, at + length));
      if (codespaces.some((space) => space.bytes === length && code >= space.lo && code <= space.hi)) {
        matched = length;
        break;
      }
    }
    if (matched === 0) {
      matched = Math.min(shortest, bytes.length - at);
      code = codeOf(bytes.subarray(at, at + matched));
    }
    out.push({ code, length: matched });
    at += matched;
  }
  return out;
}
