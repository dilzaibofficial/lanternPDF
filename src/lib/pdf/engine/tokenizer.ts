/**
 * A tolerant parser for PDF content streams that keeps **byte offsets**: every operation records exactly which
 * bytes of the stream it came from, so an edit can replace those bytes and leave the rest untouched.
 *
 * It is a tokenizer plus just enough structure to group operands with their operator. It does not interpret
 * anything (that is `interpret.ts`) and it never throws on bad input: whatever it cannot read is skipped and
 * counted in `problems`, because real-world files are routinely a little wrong.
 */

export interface Num {
  t: "num";
  v: number;
  s: number;
  e: number;
}
export interface Name {
  t: "name";
  v: string;
  s: number;
  e: number;
}
export interface Str {
  t: "str";
  bytes: Uint8Array;
  hex: boolean;
  s: number;
  e: number;
}
export interface Arr {
  t: "arr";
  items: Operand[];
  s: number;
  e: number;
}
export interface Dict {
  t: "dict";
  entries: Map<string, Operand>;
  s: number;
  e: number;
}
export interface Lit {
  t: "lit";
  v: boolean | null;
  s: number;
  e: number;
}
export type Operand = Num | Name | Str | Arr | Dict | Lit;

export interface InlineImage {
  dict: Map<string, Operand>;
  /** Byte range of the image data between `ID` and `EI`. */
  dataStart: number;
  dataEnd: number;
}

export interface Operation {
  op: string;
  args: Operand[];
  /** Offset of the first operand, or of the operator when it has none. */
  start: number;
  /** Offset of the operator keyword. */
  opStart: number;
  /** Offset just past the operator (for `BI`, just past `EI`). */
  end: number;
  inline?: InlineImage;
}

export interface ParseResult {
  ops: Operation[];
  /** True when parsing stopped early because a limit was reached. */
  truncated: boolean;
  /** How many malformed things were skipped. */
  problems: number;
}

export interface ParseLimits {
  maxOps?: number;
  maxDepth?: number;
  /** Operands remembered while waiting for an operator. Content streams never need many; CMap blocks list thousands. */
  maxOperands?: number;
}

const DEFAULT_MAX_OPS = 3_000_000;
const DEFAULT_MAX_DEPTH = 24;
const MAX_PENDING_OPERANDS = 2048;

const isSpace = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDelimiter = (c: number) => c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
const isRegular = (c: number) => !isSpace(c) && !isDelimiter(c);
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
const SKIPPED = Symbol("skipped");

function ascii(data: Uint8Array, start: number, end: number): string {
  let text = "";
  for (let i = start; i < end; i += 1) text += String.fromCharCode(data[i] as number);
  return text;
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

class Reader {
  pos = 0;
  problems = 0;
  constructor(readonly data: Uint8Array) {}

  skipSpace(): void {
    const { data } = this;
    for (;;) {
      while (this.pos < data.length && isSpace(data[this.pos] as number)) this.pos += 1;
      if (this.pos < data.length && data[this.pos] === 0x25) {
        while (this.pos < data.length && data[this.pos] !== 10 && data[this.pos] !== 13) this.pos += 1;
        continue;
      }
      return;
    }
  }

  get done(): boolean {
    return this.pos >= this.data.length;
  }

  /** Reads the next operand, or returns the keyword text when the next token is an operator. */
  next(depth: number, maxDepth: number): Operand | string | null {
    for (;;) {
      const result = this.nextToken(depth, maxDepth);
      if (result !== SKIPPED) return result;
    }
  }

  private nextToken(depth: number, maxDepth: number): Operand | string | null | typeof SKIPPED {
    this.skipSpace();
    const { data } = this;
    if (this.pos >= data.length) return null;
    const start = this.pos;
    const c = data[this.pos] as number;

    if (c === 0x2f) {
      this.pos += 1;
      const from = this.pos;
      while (this.pos < data.length && isRegular(data[this.pos] as number)) this.pos += 1;
      return { t: "name", v: decodeName(data, from, this.pos), s: start, e: this.pos };
    }
    if (c === 0x28) return this.literalString(start);
    if (c === 0x3c) {
      if (data[this.pos + 1] === 0x3c) return this.dictionary(start, depth, maxDepth);
      return this.hexString(start);
    }
    if (c === 0x5b) return this.array(start, depth, maxDepth);
    if (c === 0x3e || c === 0x29 || c === 0x5d || c === 0x7b || c === 0x7d) {
      // A stray closer: skip it. (`>>` is two bytes.)
      this.pos += c === 0x3e && data[this.pos + 1] === 0x3e ? 2 : 1;
      this.problems += 1;
      return SKIPPED;
    }

    while (this.pos < data.length && isRegular(data[this.pos] as number)) this.pos += 1;
    if (this.pos === start) {
      this.pos += 1;
      this.problems += 1;
      return SKIPPED;
    }
    const word = ascii(data, start, this.pos);
    if (NUMBER.test(word)) return { t: "num", v: Number(word), s: start, e: this.pos };
    if (word === "true") return { t: "lit", v: true, s: start, e: this.pos };
    if (word === "false") return { t: "lit", v: false, s: start, e: this.pos };
    if (word === "null") return { t: "lit", v: null, s: start, e: this.pos };
    return word;
  }

  private literalString(start: number): Str {
    const { data } = this;
    const out: number[] = [];
    this.pos += 1;
    let depth = 1;
    while (this.pos < data.length) {
      const c = data[this.pos] as number;
      this.pos += 1;
      if (c === 0x5c) {
        const n = data[this.pos];
        if (n === undefined) break;
        this.pos += 1;
        switch (n) {
          case 0x6e:
            out.push(10);
            break;
          case 0x72:
            out.push(13);
            break;
          case 0x74:
            out.push(9);
            break;
          case 0x62:
            out.push(8);
            break;
          case 0x66:
            out.push(12);
            break;
          case 0x0d:
            if (data[this.pos] === 0x0a) this.pos += 1; // line continuation
            break;
          case 0x0a:
            break;
          default:
            if (n >= 0x30 && n <= 0x37) {
              let value = n - 0x30;
              for (let k = 0; k < 2; k += 1) {
                const d = data[this.pos];
                if (d !== undefined && d >= 0x30 && d <= 0x37) {
                  value = value * 8 + (d - 0x30);
                  this.pos += 1;
                } else break;
              }
              out.push(value & 0xff);
            } else {
              out.push(n); // \( \) \\ and unknown escapes keep the character
            }
        }
      } else if (c === 0x28) {
        depth += 1;
        out.push(c);
      } else if (c === 0x29) {
        depth -= 1;
        if (depth === 0) return { t: "str", bytes: Uint8Array.from(out), hex: false, s: start, e: this.pos };
        out.push(c);
      } else if (c === 0x0d) {
        // An unescaped CR or CRLF inside a string reads as a single LF.
        if (data[this.pos] === 0x0a) this.pos += 1;
        out.push(10);
      } else {
        out.push(c);
      }
    }
    this.problems += 1;
    return { t: "str", bytes: Uint8Array.from(out), hex: false, s: start, e: this.pos };
  }

  private hexString(start: number): Str {
    const { data } = this;
    this.pos += 1;
    const out: number[] = [];
    let high = -1;
    while (this.pos < data.length) {
      const c = data[this.pos] as number;
      this.pos += 1;
      if (c === 0x3e) {
        if (high >= 0) out.push(high << 4);
        return { t: "str", bytes: Uint8Array.from(out), hex: true, s: start, e: this.pos };
      }
      const value = hexValue(c);
      if (value < 0) continue; // whitespace and stray characters are ignored
      if (high < 0) high = value;
      else {
        out.push((high << 4) | value);
        high = -1;
      }
    }
    this.problems += 1;
    return { t: "str", bytes: Uint8Array.from(out), hex: true, s: start, e: this.pos };
  }

  /** Skips a container nested too deeply to keep, without recursion. `pos` is just past its opening bracket. */
  private skipContainer(): void {
    const { data } = this;
    let open = 1;
    while (this.pos < data.length && open > 0) {
      const c = data[this.pos] as number;
      if (c === 0x28) {
        this.literalString(this.pos);
      } else if (c === 0x3c && data[this.pos + 1] === 0x3c) {
        open += 1;
        this.pos += 2;
      } else if (c === 0x3c) {
        this.hexString(this.pos);
      } else if (c === 0x3e && data[this.pos + 1] === 0x3e) {
        open -= 1;
        this.pos += 2;
      } else if (c === 0x5b) {
        open += 1;
        this.pos += 1;
      } else if (c === 0x5d) {
        open -= 1;
        this.pos += 1;
      } else if (c === 0x25) {
        while (this.pos < data.length && data[this.pos] !== 10 && data[this.pos] !== 13) this.pos += 1;
      } else {
        this.pos += 1;
      }
    }
  }

  private array(start: number, depth: number, maxDepth: number): Arr {
    this.pos += 1;
    const items: Operand[] = [];
    if (depth >= maxDepth) {
      this.problems += 1;
      this.skipContainer();
      return { t: "arr", items, s: start, e: this.pos };
    }
    for (;;) {
      this.skipSpace();
      if (this.pos >= this.data.length) {
        this.problems += 1;
        break;
      }
      if (this.data[this.pos] === 0x5d) {
        this.pos += 1;
        break;
      }
      const item = this.next(depth + 1, maxDepth);
      if (item === null) break;
      if (typeof item === "string") {
        this.problems += 1; // an operator inside an array
        continue;
      }
      items.push(item);
    }
    return { t: "arr", items, s: start, e: this.pos };
  }

  private dictionary(start: number, depth: number, maxDepth: number): Dict {
    this.pos += 2;
    const entries = new Map<string, Operand>();
    if (depth >= maxDepth) {
      this.problems += 1;
      this.skipContainer();
      return { t: "dict", entries, s: start, e: this.pos };
    }
    for (;;) {
      this.skipSpace();
      if (this.pos >= this.data.length) {
        this.problems += 1;
        break;
      }
      if (this.data[this.pos] === 0x3e && this.data[this.pos + 1] === 0x3e) {
        this.pos += 2;
        break;
      }
      const key = this.next(depth + 1, maxDepth);
      if (key === null) break;
      if (typeof key === "string" || key.t !== "name") {
        this.problems += 1;
        continue;
      }
      this.skipSpace();
      if (this.data[this.pos] === 0x3e && this.data[this.pos + 1] === 0x3e) {
        this.problems += 1;
        continue;
      }
      const value = this.next(depth + 1, maxDepth);
      if (value === null) break;
      if (typeof value === "string") {
        this.problems += 1;
        continue;
      }
      entries.set(key.v, value);
    }
    return { t: "dict", entries, s: start, e: this.pos };
  }
}

function decodeName(data: Uint8Array, from: number, to: number): string {
  let name = "";
  for (let i = from; i < to; i += 1) {
    const c = data[i] as number;
    if (c === 0x23 && i + 2 < to && hexValue(data[i + 1] as number) >= 0 && hexValue(data[i + 2] as number) >= 0) {
      name += String.fromCharCode((hexValue(data[i + 1] as number) << 4) | hexValue(data[i + 2] as number));
      i += 2;
    } else {
      name += String.fromCharCode(c);
    }
  }
  return name;
}

/**
 * After `BI`: reads the image's key/value pairs up to `ID`, then finds the end of the binary data. The data is
 * located by its `/L` length when present, else by scanning for an `EI` that is plausibly the real end.
 */
function readInlineImage(reader: Reader, maxDepth: number): InlineImage | null {
  const dict = new Map<string, Operand>();
  for (;;) {
    const key = reader.next(1, maxDepth);
    if (key === null) return null;
    if (typeof key === "string") {
      if (key === "ID") break;
      reader.problems += 1;
      continue;
    }
    if (key.t !== "name") {
      reader.problems += 1;
      continue;
    }
    const value = reader.next(1, maxDepth);
    if (value === null) return null;
    if (typeof value === "string") {
      if (value === "ID") break;
      reader.problems += 1;
      continue;
    }
    dict.set(key.v, value);
  }
  const { data } = reader;
  if (reader.pos < data.length && isSpace(data[reader.pos] as number)) reader.pos += 1;
  const dataStart = reader.pos;

  const declared = dict.get("L") ?? dict.get("Length");
  if (declared && declared.t === "num" && declared.v >= 0 && dataStart + declared.v <= data.length) {
    const at = dataStart + declared.v;
    let k = at;
    while (k < data.length && isSpace(data[k] as number)) k += 1;
    if (data[k] === 0x45 && data[k + 1] === 0x49) {
      reader.pos = k + 2;
      return { dict, dataStart, dataEnd: at };
    }
  }

  const plausibleAfter = (from: number) => {
    for (let i = from; i < Math.min(data.length, from + 12); i += 1) {
      const byte = data[i] as number;
      if (!isSpace(byte) && (byte < 0x21 || byte > 0x7e)) return false; // binary: the "EI" was inside the data
    }
    return true;
  };
  for (let i = dataStart; i + 1 < data.length; i += 1) {
    if (data[i] === 0x45 && data[i + 1] === 0x49 && (i === dataStart || isSpace(data[i - 1] as number)) && (i + 2 >= data.length || isSpace(data[i + 2] as number)) && plausibleAfter(i + 2)) {
      reader.pos = i + 2;
      let dataEnd = i;
      if (dataEnd > dataStart && isSpace(data[dataEnd - 1] as number)) dataEnd -= 1;
      return { dict, dataStart, dataEnd };
    }
  }
  reader.pos = data.length;
  reader.problems += 1;
  return { dict, dataStart, dataEnd: data.length };
}

/** Parses a content stream into operations. Never throws. */
export function parseContentStream(data: Uint8Array, limits: ParseLimits = {}): ParseResult {
  const maxOps = limits.maxOps ?? DEFAULT_MAX_OPS;
  const maxDepth = limits.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxOperands = limits.maxOperands ?? MAX_PENDING_OPERANDS;
  const reader = new Reader(data);
  const ops: Operation[] = [];
  let args: Operand[] = [];
  let truncated = false;

  while (!reader.done) {
    reader.skipSpace();
    if (reader.done) break;
    const token = reader.next(0, maxDepth);
    if (token === null) break;
    if (typeof token !== "string") {
      args.push(token);
      if (args.length > maxOperands) args = args.slice(-maxOperands / 2);
      continue;
    }
    // `next` may have skipped stray bytes before the keyword; the keyword really starts where the word does.
    const opStart = reader.pos - token.length;
    const start = args.length > 0 ? (args[0] as Operand).s : opStart;
    if (token === "BI") {
      const inline = readInlineImage(reader, maxDepth);
      ops.push({ op: "BI", args: [], start, opStart, end: reader.pos, inline: inline ?? undefined });
      args = [];
    } else {
      ops.push({ op: token, args, start, opStart, end: reader.pos });
      args = [];
    }
    if (ops.length >= maxOps) {
      truncated = true;
      break;
    }
  }
  return { ops, truncated, problems: reader.problems };
}

// ---------------------------------------------------------------------------------------------
// Helpers for reading operands
// ---------------------------------------------------------------------------------------------

export function numberAt(args: readonly Operand[], index: number): number | null {
  const a = args[index];
  return a && a.t === "num" ? a.v : null;
}

export function numbersOf(args: readonly Operand[], count: number): number[] | null {
  if (args.length < count) return null;
  const out: number[] = [];
  for (let i = args.length - count; i < args.length; i += 1) {
    const a = args[i];
    if (!a || a.t !== "num") return null;
    out.push(a.v);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Writing operands back out
// ---------------------------------------------------------------------------------------------

const encoder = new TextEncoder();

/** A number in PDF syntax: plain decimal, no exponent, trailing zeros trimmed. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return String(value);
  const text = value.toFixed(4);
  return text.replace(/0+$/, "").replace(/\.$/, "");
}

export function hexString(bytes: Uint8Array): string {
  let text = "<";
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
  return `${text}>`;
}

/** `/Name` with the characters PDF requires to be escaped written as `#xx`. */
export function formatName(name: string): string {
  let text = "/";
  for (const ch of name) {
    const code = ch.codePointAt(0) as number;
    text += code < 0x21 || code > 0x7e || "()<>[]{}/%#".includes(ch) ? `#${(code & 0xff).toString(16).padStart(2, "0")}` : ch;
  }
  return text;
}

export function toBytes(text: string): Uint8Array {
  return encoder.encode(text);
}
