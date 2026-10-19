import { PDFArray, PDFDict, type PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } from "@cantoo/pdf-lib";

/**
 * Works out how large each image is actually drawn on its pages, by reading the pages' content streams
 * the way a viewer would: tracking the current transformation matrix through `q`, `Q` and `cm`, and
 * noting every `Do` that paints an image (including images inside form XObjects). That gives each
 * image an effective resolution, which is what decides how far it can be shrunk without visible loss.
 *
 * This is a deliberately small interpreter. Anything it does not understand (patterns, Type 3 glyphs,
 * annotation appearances) simply goes unseen, and an image with no recorded use is left untouched by
 * the compressor, so a gap here can only make it more cautious, never more aggressive.
 */

import { IDENTITY, type Matrix, multiply, unitSquareSize } from "./engine/matrix";

export { IDENTITY, multiply, unitSquareSize };
export type { Matrix };

type Token = { type: "number"; value: number } | { type: "name"; value: string } | { type: "operator"; value: string } | { type: "other" };

const OTHER: Token = { type: "other" };
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

const isSpace = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDelimiter = (c: number) => c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;

function latin1(data: Uint8Array, start: number, end: number): string {
  let text = "";
  for (let i = start; i < end; i += 1) text += String.fromCharCode(data[i] as number);
  return text;
}

class Lexer {
  pos = 0;
  constructor(private readonly data: Uint8Array) {}

  next(): Token | null {
    const { data } = this;
    for (;;) {
      while (this.pos < data.length && isSpace(data[this.pos] as number)) this.pos += 1;
      if (this.pos < data.length && data[this.pos] === 0x25) {
        while (this.pos < data.length && data[this.pos] !== 10 && data[this.pos] !== 13) this.pos += 1; // comment
        continue;
      }
      break;
    }
    if (this.pos >= data.length) return null;

    const c = data[this.pos] as number;
    if (c === 0x2f) {
      this.pos += 1;
      const start = this.pos;
      while (this.pos < data.length && !isSpace(data[this.pos] as number) && !isDelimiter(data[this.pos] as number)) this.pos += 1;
      return { type: "name", value: latin1(data, start, this.pos) };
    }
    if (c === 0x28) {
      this.skipString();
      return OTHER;
    }
    if (c === 0x3c) {
      if (data[this.pos + 1] === 0x3c) {
        this.pos += 2; // dictionary start
      } else {
        while (this.pos < data.length && data[this.pos] !== 0x3e) this.pos += 1; // hex string
        this.pos += 1;
      }
      return OTHER;
    }
    if (c === 0x3e) {
      this.pos += data[this.pos + 1] === 0x3e ? 2 : 1;
      return OTHER;
    }
    if (c === 0x29 || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) {
      this.pos += 1;
      return OTHER;
    }

    const start = this.pos;
    while (this.pos < data.length && !isSpace(data[this.pos] as number) && !isDelimiter(data[this.pos] as number)) this.pos += 1;
    if (this.pos === start) {
      this.pos += 1;
      return OTHER;
    }
    const text = latin1(data, start, this.pos);
    return NUMBER.test(text) ? { type: "number", value: Number(text) } : { type: "operator", value: text };
  }

  private skipString(): void {
    let depth = 0;
    while (this.pos < this.data.length) {
      const c = this.data[this.pos] as number;
      this.pos += 1;
      if (c === 0x5c) this.pos += 1; // backslash: the next byte is escaped
      else if (c === 0x28) depth += 1;
      else if (c === 0x29) {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  /** Called right after a `BI`: skips the inline image's dictionary and its binary data up to the closing `EI`. */
  skipInlineImage(): void {
    const { data } = this;
    for (let token = this.next(); token; token = this.next()) {
      if (token.type === "operator" && token.value === "ID") break;
    }
    if (this.pos < data.length && isSpace(data[this.pos] as number)) this.pos += 1;
    const plausibleAfter = (at: number) => {
      for (let i = at; i < Math.min(data.length, at + 12); i += 1) {
        const byte = data[i] as number;
        if (!isSpace(byte) && (byte < 0x21 || byte > 0x7e)) return false; // binary: this "EI" was inside the image data
      }
      return true;
    };
    for (let i = this.pos; i + 1 < data.length; i += 1) {
      if (data[i] === 0x45 && data[i + 1] === 0x49 && (i === this.pos || isSpace(data[i - 1] as number)) && (i + 2 >= data.length || isSpace(data[i + 2] as number)) && plausibleAfter(i + 2)) {
        this.pos = i + 2;
        return;
      }
    }
    this.pos = data.length;
  }
}

interface Use {
  ref: PDFRef;
  /** Maps the image's unit square into the space of whatever was scanned (a page, or a form's own space). */
  m: Matrix;
}

interface ScanState {
  doc: PDFDocument;
  /** Uses found inside each form XObject, in that form's own space, so a form drawn on many pages is read once. */
  forms: Map<string, Use[]>;
  active: Set<string>;
  unreadable: number;
}

const MAX_FORM_DEPTH = 8;
const N = {
  XObject: PDFName.of("XObject"),
  Subtype: PDFName.of("Subtype"),
  Image: PDFName.of("Image"),
  Form: PDFName.of("Form"),
  Matrix: PDFName.of("Matrix"),
  Resources: PDFName.of("Resources"),
  UserUnit: PDFName.of("UserUnit"),
};

function readMatrix(array: PDFArray | undefined): Matrix | null {
  if (!array || array.size() < 6) return null;
  const values: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const number = array.lookupMaybe(i, PDFNumber);
    if (!number) return null;
    values.push(number.asNumber());
  }
  return values as unknown as Matrix;
}

function streamData(state: ScanState, stream: PDFRawStream): Uint8Array | null {
  try {
    return decodePDFRawStream(stream).decode();
  } catch {
    state.unreadable += 1; // an unsupported filter or a damaged stream
    return null;
  }
}

function interpret(state: ScanState, data: Uint8Array, resources: PDFDict | undefined, depth: number): Use[] {
  const uses: Use[] = [];
  const lexer = new Lexer(data);
  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;
  let numbers: number[] = [];
  let lastName: string | null = null;

  const paint = (name: string) => {
    const entry = resources?.lookupMaybe(N.XObject, PDFDict)?.get(PDFName.of(name));
    if (!(entry instanceof PDFRef)) return;
    const object = state.doc.context.lookup(entry);
    if (!(object instanceof PDFRawStream)) return;
    const subtype = object.dict.get(N.Subtype);
    if (subtype === N.Image) {
      uses.push({ ref: entry, m: ctm });
    } else if (subtype === N.Form && depth < MAX_FORM_DEPTH) {
      const inner = formUses(state, entry, object, resources, depth + 1);
      const toSpace = multiply(readMatrix(object.dict.lookupMaybe(N.Matrix, PDFArray)) ?? IDENTITY, ctm);
      for (const use of inner) uses.push({ ref: use.ref, m: multiply(use.m, toSpace) });
    }
  };

  for (let token = lexer.next(); token; token = lexer.next()) {
    if (token.type === "number") {
      numbers.push(token.value);
      if (numbers.length > 8) numbers.shift();
    } else if (token.type === "name") {
      lastName = token.value;
    } else if (token.type === "operator") {
      switch (token.value) {
        case "q":
          if (stack.length < 512) stack.push(ctm);
          break;
        case "Q":
          ctm = stack.pop() ?? ctm;
          break;
        case "cm":
          if (numbers.length >= 6) ctm = multiply(numbers.slice(-6) as unknown as Matrix, ctm);
          break;
        case "Do":
          if (lastName !== null) paint(lastName);
          break;
        case "BI":
          lexer.skipInlineImage();
          break;
        default:
          break;
      }
      numbers = [];
      lastName = null;
    }
  }
  return uses;
}

function formUses(state: ScanState, ref: PDFRef, form: PDFRawStream, inherited: PDFDict | undefined, depth: number): Use[] {
  const key = ref.toString();
  const cached = state.forms.get(key);
  if (cached) return cached;
  if (state.active.has(key)) return []; // a form that (illegally) draws itself
  state.active.add(key);
  try {
    const data = streamData(state, form);
    const uses = data ? interpret(state, data, form.dict.lookupMaybe(N.Resources, PDFDict) ?? inherited, depth) : [];
    state.forms.set(key, uses);
    return uses;
  } finally {
    state.active.delete(key);
  }
}

export interface ImageUsage {
  /** The largest size, in points, the image is painted at on any page. */
  width: number;
  height: number;
  /** How many times it is painted. */
  uses: number;
}

export interface UsageReport {
  /** Keyed by the image's object reference, e.g. "12 0 R". */
  images: Map<string, ImageUsage>;
  /** Content streams that could not be read (unsupported filter, damage). Their images are unknown. */
  unreadable: number;
}

/** Scans every page of `doc` and reports where and how large each image XObject is painted. */
export function scanImageUsage(doc: PDFDocument, onPage?: (done: number, total: number) => void): UsageReport {
  const state: ScanState = { doc, forms: new Map(), active: new Set(), unreadable: 0 };
  const images = new Map<string, ImageUsage>();
  const pages = doc.getPages();

  pages.forEach((page, index) => {
    const leaf = page.node;
    const contents = leaf.Contents();
    const parts = contents instanceof PDFArray ? contents.asArray().map((item) => doc.context.lookup(item)) : contents ? [contents] : [];
    const chunks: Uint8Array[] = [];
    for (const part of parts) {
      if (!(part instanceof PDFRawStream)) continue;
      const data = streamData(state, part);
      if (data) chunks.push(data, new Uint8Array([10]));
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const content = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      content.set(chunk, at);
      at += chunk.length;
    }

    const userUnit = leaf.lookupMaybe(N.UserUnit, PDFNumber)?.asNumber() ?? 1;
    for (const use of interpret(state, content, leaf.Resources(), 0)) {
      const size = unitSquareSize(use.m);
      const key = use.ref.toString();
      const entry = images.get(key) ?? { width: 0, height: 0, uses: 0 };
      entry.width = Math.max(entry.width, size.width * userUnit);
      entry.height = Math.max(entry.height, size.height * userUnit);
      entry.uses += 1;
      images.set(key, entry);
    }
    onPage?.(index + 1, pages.length);
  });

  return { images, unreadable: state.unreadable };
}
