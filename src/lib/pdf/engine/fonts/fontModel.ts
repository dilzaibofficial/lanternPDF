import { PDFArray, PDFDict, PDFName, type PDFObject, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from "@cantoo/pdf-lib";
import { Encodings, Font } from "@cantoo/pdf-lib/standard-fonts";
import type { Matrix } from "../matrix";
import { type CMap, type CodeSpace, cidFromCMap, parseCMap, splitCodes, unicodeEntries, unicodeFromCMap } from "./cmap";
import { applyDifferences, baseEncoding } from "./encodings";
import { unicodeForGlyphName } from "./glyphNames";

/**
 * What the editor needs to know about a font used by a page: how to turn the bytes of a text-showing operation
 * into characters and advances (reading), and which codes produce which characters (writing).
 *
 * Built straight from the PDF's font dictionary: `/ToUnicode`, `/Encoding` with `/Differences`, `/Widths`,
 * `/W` and `/DW`, the descendant font of a composite font, and the FontDescriptor.
 */

export type FontFamilyClass = "sans" | "serif" | "mono" | "symbol";
export type EmbeddedKind = "none" | "truetype" | "type1" | "cff" | "opentype" | "unknown";

export interface GlyphCode {
  code: number;
  /** Number of bytes of the string this code occupies. */
  length: number;
}

export interface FontModel {
  /** Identity within the document: the object reference, or a synthetic key for a direct dictionary. */
  readonly key: string;
  readonly resourceName: string;
  readonly baseFont: string;
  readonly subsetTag: string | null;
  readonly subtype: string;
  readonly composite: boolean;
  readonly type3: boolean;
  readonly vertical: boolean;
  readonly embedded: EmbeddedKind;
  readonly family: FontFamilyClass;
  readonly bold: boolean;
  readonly italic: boolean;
  /** Ascent and descent in 1/1000 em (descent is negative). */
  readonly ascent: number;
  readonly descent: number;
  /** Type 3 only. */
  readonly fontMatrix: Matrix | null;
  /** Why text in this font cannot be edited in place, or `null` when it can. */
  readonly readOnlyReason: string | null;
  /** True when the width or code-length information is a guess (so positions are approximate). */
  readonly approximate: boolean;
  /** Codes seen in use with this font in the document; set by the analysis to know which glyphs an embedded subset has. */
  readonly used: Set<number>;
  decode(bytes: Uint8Array): GlyphCode[];
  /** The text a code stands for, if the font says. */
  unicodeOf(code: number): string | undefined;
  /** Advance width in 1/1000 of the font size. */
  widthOf(code: number): number;
  /** True for the single-byte code 32, which word spacing applies to. */
  isWordSpace(glyph: GlyphCode): boolean;
  /** The code that draws `char` in this font, if the font can; honours the subset the document actually uses. */
  encodeChar(char: string): GlyphCode | null;
  /** Every character this font can draw. */
  availableChars(): Set<string>;
  /** Bytes of the string for `codes`. */
  toBytes(codes: readonly GlyphCode[]): Uint8Array;
}

const N = {
  Type: PDFName.of("Type"),
  Subtype: PDFName.of("Subtype"),
  BaseFont: PDFName.of("BaseFont"),
  Encoding: PDFName.of("Encoding"),
  BaseEncoding: PDFName.of("BaseEncoding"),
  Differences: PDFName.of("Differences"),
  ToUnicode: PDFName.of("ToUnicode"),
  Widths: PDFName.of("Widths"),
  FirstChar: PDFName.of("FirstChar"),
  LastChar: PDFName.of("LastChar"),
  FontDescriptor: PDFName.of("FontDescriptor"),
  MissingWidth: PDFName.of("MissingWidth"),
  Flags: PDFName.of("Flags"),
  Ascent: PDFName.of("Ascent"),
  Descent: PDFName.of("Descent"),
  ItalicAngle: PDFName.of("ItalicAngle"),
  FontWeight: PDFName.of("FontWeight"),
  StemV: PDFName.of("StemV"),
  FontFile: PDFName.of("FontFile"),
  FontFile2: PDFName.of("FontFile2"),
  FontFile3: PDFName.of("FontFile3"),
  DescendantFonts: PDFName.of("DescendantFonts"),
  W: PDFName.of("W"),
  DW: PDFName.of("DW"),
  CIDToGIDMap: PDFName.of("CIDToGIDMap"),
  FontMatrix: PDFName.of("FontMatrix"),
  WMode: PDFName.of("WMode"),
};

// ---- small readers -------------------------------------------------------------------------------------------

const nameOf = (object: PDFObject | undefined): string | undefined => (object instanceof PDFName ? object.decodeText() : undefined);
const numberOf = (object: PDFObject | undefined): number | undefined => (object instanceof PDFNumber ? object.asNumber() : undefined);

/** The decoded bytes of a stream, or `null` when it cannot be decoded (unsupported filter, damage). */
export function streamBytes(object: PDFObject | undefined): Uint8Array | null {
  try {
    if (object instanceof PDFRawStream) return decodePDFRawStream(object).decode();
    if (object instanceof PDFStream) return object.getContents();
  } catch {
    return null;
  }
  return null;
}

// ---- classification ------------------------------------------------------------------------------------------

function classify(baseFont: string, flags: number | undefined): FontFamilyClass {
  const name = baseFont.toLowerCase();
  if (/^(symbol|zapfdingbats|wingdings|webdings)/.test(name)) return "symbol";
  if (/courier|mono|consolas|menlo|typewriter|lucidaconsole|inconsolata/.test(name)) return "mono";
  if (/times|serif(?!ic)|georgia|garamond|palatino|minion|cambria|bookman|baskerville|caslon|century|didot|merriweather|roman|constantia|charter/.test(name) && !/sans/.test(name)) return "serif";
  if (flags !== undefined) {
    if (flags & 1) return "mono";
    if (flags & 2) return "serif";
  }
  return "sans";
}

const detectBold = (baseFont: string, descriptor: PDFDict | undefined): boolean => {
  if (/bold|black|heavy|semibold|demi|extrabold|ultra/i.test(baseFont)) return true;
  const weight = numberOf(descriptor?.lookup(N.FontWeight));
  if (weight !== undefined && weight >= 600) return true;
  const flags = numberOf(descriptor?.lookup(N.Flags));
  return flags !== undefined && (flags & 0x40000) !== 0;
};

const detectItalic = (baseFont: string, descriptor: PDFDict | undefined): boolean => {
  if (/italic|oblique|slanted|kursiv/i.test(baseFont)) return true;
  const angle = numberOf(descriptor?.lookup(N.ItalicAngle));
  if (angle !== undefined && angle !== 0) return true;
  const flags = numberOf(descriptor?.lookup(N.Flags));
  return flags !== undefined && (flags & 0x40) !== 0;
};

type StandardName = "Helvetica" | "Helvetica-Bold" | "Helvetica-Oblique" | "Helvetica-BoldOblique" | "Times-Roman" | "Times-Bold" | "Times-Italic" | "Times-BoldItalic" | "Courier" | "Courier-Bold" | "Courier-Oblique" | "Courier-BoldOblique" | "Symbol" | "ZapfDingbats";

/** The standard-14 font whose metrics stand in for `baseFont` (Arial is Helvetica-metric, and so on), or null. */
export function standardFontFor(baseFont: string, bold: boolean, italic: boolean): StandardName | null {
  const compact = baseFont.replace(/[\s,_-]/g, "").toLowerCase();
  if (/^(arial|helvetica)/.test(compact)) return bold ? (italic ? "Helvetica-BoldOblique" : "Helvetica-Bold") : italic ? "Helvetica-Oblique" : "Helvetica";
  if (/^(timesnewroman|times)/.test(compact)) return bold ? (italic ? "Times-BoldItalic" : "Times-Bold") : italic ? "Times-Italic" : "Times-Roman";
  if (/^(couriernew|courier)/.test(compact)) return bold ? (italic ? "Courier-BoldOblique" : "Courier-Bold") : italic ? "Courier-Oblique" : "Courier";
  if (compact.startsWith("symbol")) return "Symbol";
  if (compact.startsWith("zapfdingbats")) return "ZapfDingbats";
  return null;
}

function embeddedKind(descriptor: PDFDict | undefined): EmbeddedKind {
  if (!descriptor) return "none";
  if (descriptor.has(N.FontFile2)) return "truetype";
  if (descriptor.has(N.FontFile)) return "type1";
  if (descriptor.has(N.FontFile3)) {
    const subtype = nameOf(descriptor.lookup(N.FontFile3, PDFStream).dict.lookup(N.Subtype));
    if (subtype === "OpenType") return "opentype";
    if (subtype === "Type1C" || subtype === "CIDFontType0C") return "cff";
    return "unknown";
  }
  return "none";
}

// ---- building ------------------------------------------------------------------------------------------------

/**
 * Identifies "the same font" across documents (a page copied into its own document gets new object numbers): the
 * subset tag, base font name and subtype. Used to carry glyph availability over to a copy of a page.
 */
export const fontSignature = (font: Pick<FontModel, "subsetTag" | "baseFont" | "subtype" | "embedded">): string => `${font.subsetTag ?? ""}+${font.baseFont}|${font.subtype}|${font.embedded}`;

let anonymous = 0;
const anonymousKeys = new WeakMap<PDFDict, string>();

export function fontKeyOf(entry: PDFObject | undefined, dict: PDFDict): string {
  if (entry instanceof PDFRef) return entry.toString();
  let key = anonymousKeys.get(dict);
  if (!key) {
    anonymous += 1;
    key = `direct:${anonymous}`;
    anonymousKeys.set(dict, key);
  }
  return key;
}

interface CidWidths {
  single: Map<number, number>;
  ranges: { lo: number; hi: number; w: number }[];
  defaultWidth: number;
}

function parseW(array: PDFArray | undefined, defaultWidth: number): CidWidths {
  const out: CidWidths = { single: new Map(), ranges: [], defaultWidth };
  if (!array) return out;
  const items = array.asArray();
  const read = (index: number): PDFObject | undefined => (items[index] instanceof PDFRef ? array.lookup(index) : items[index]);
  let i = 0;
  while (i < items.length) {
    const first = numberOf(read(i));
    const second = read(i + 1);
    if (first === undefined) {
      i += 1;
      continue;
    }
    if (second instanceof PDFArray) {
      second.asArray().forEach((_, k) => {
        const w = numberOf(second.lookup(k));
        if (w !== undefined) out.single.set(first + k, w);
      });
      i += 2;
    } else {
      const last = numberOf(second);
      const w = numberOf(read(i + 2));
      if (last !== undefined && w !== undefined) out.ranges.push({ lo: first, hi: last, w });
      i += 3;
    }
  }
  return out;
}

function cidWidth(widths: CidWidths, cid: number): number {
  const single = widths.single.get(cid);
  if (single !== undefined) return single;
  for (const range of widths.ranges) if (cid >= range.lo && cid <= range.hi) return range.w;
  return widths.defaultWidth;
}

function readDifferences(array: PDFArray | undefined): { code: number; name: string }[] {
  const out: { code: number; name: string }[] = [];
  if (!array) return out;
  let code = 0;
  for (let i = 0; i < array.size(); i += 1) {
    const item = array.lookup(i);
    if (item instanceof PDFNumber) code = item.asNumber();
    else if (item instanceof PDFName) {
      out.push({ code, name: item.decodeText() });
      code += 1;
    }
  }
  return out;
}

const PREDEFINED_IDENTITY = new Set(["Identity-H", "Identity-V"]);

export function buildFontModel(fontDict: PDFDict, resourceName: string, key: string): FontModel {
  const subtype = nameOf(fontDict.lookup(N.Subtype)) ?? "Unknown";
  const rawBase = nameOf(fontDict.lookup(N.BaseFont)) ?? resourceName;
  const tagged = /^([A-Z]{6})\+(.+)$/.exec(rawBase);
  const subsetTag = tagged ? (tagged[1] as string) : null;
  const baseFont = tagged ? (tagged[2] as string) : rawBase;
  const composite = subtype === "Type0";
  const type3 = subtype === "Type3";

  const descendant = composite ? fontDict.lookupMaybe(N.DescendantFonts, PDFArray)?.lookupMaybe(0, PDFDict) : undefined;
  const descriptor = (composite ? descendant : fontDict)?.lookupMaybe(N.FontDescriptor, PDFDict);
  const flags = numberOf(descriptor?.lookup(N.Flags));
  const bold = detectBold(baseFont, descriptor);
  const italic = detectItalic(baseFont, descriptor);
  const embedded = embeddedKind(descriptor);
  const family = classify(baseFont, flags);
  const standard = !composite && !type3 && embedded === "none" ? standardFontFor(baseFont, bold, italic) : null;
  const afm = standard ? Font.load(standard) : null;

  const clampAscent = (value: number | undefined, fallback: number) => (value !== undefined && value >= 300 && value <= 1300 ? value : fallback);
  const clampDescent = (value: number | undefined, fallback: number) => {
    const negative = value !== undefined && value > 0 ? -value : value;
    return negative !== undefined && negative >= -600 && negative <= 0 ? negative : fallback;
  };
  const ascent = clampAscent(numberOf(descriptor?.lookup(N.Ascent)) ?? (typeof afm?.Ascender === "number" ? afm.Ascender : undefined), 800);
  const descent = clampDescent(numberOf(descriptor?.lookup(N.Descent)) ?? (typeof afm?.Descender === "number" ? afm.Descender : undefined), -200);

  let readOnlyReason: string | null = null;
  let approximate = false;

  // ---- ToUnicode ---------------------------------------------------------------------------------------------
  const toUnicodeStream = fontDict.lookup(N.ToUnicode);
  let toUnicode: CMap | null = null;
  if (toUnicodeStream instanceof PDFStream) {
    const bytes = streamBytes(toUnicodeStream);
    if (bytes) toUnicode = parseCMap(bytes);
  }

  // ---- code splitting and code -> CID (composite) ------------------------------------------------------------
  let codespaces: CodeSpace[] = [{ lo: 0, hi: 255, bytes: 1 }];
  let encodingCMap: CMap | null = null;
  let identityEncoding = false;
  let vertical = false;
  let cidWidths: CidWidths | null = null;
  let cidToGid: "identity" | "map" = "identity";

  if (composite) {
    const encoding = fontDict.lookup(N.Encoding);
    const encodingName = nameOf(encoding);
    codespaces = [{ lo: 0, hi: 0xffff, bytes: 2 }];
    if (encodingName && PREDEFINED_IDENTITY.has(encodingName)) {
      identityEncoding = true;
      vertical = encodingName === "Identity-V";
    } else if (encoding instanceof PDFStream) {
      const bytes = streamBytes(encoding);
      if (bytes) {
        encodingCMap = parseCMap(bytes);
        if (encodingCMap.codespaces.length > 0) codespaces = encodingCMap.codespaces;
        vertical = encodingCMap.wmode === 1 || numberOf(encoding.dict.lookup(N.WMode)) === 1;
        if (encodingCMap.useCMap && PREDEFINED_IDENTITY.has(encodingCMap.useCMap)) identityEncoding = encodingCMap.cidRanges.length === 0 && encodingCMap.cidChars.size === 0;
        if (encodingCMap.useCMap && !PREDEFINED_IDENTITY.has(encodingCMap.useCMap)) {
          readOnlyReason = `Uses the predefined character map “${encodingCMap.useCMap}”, which the editor cannot read.`;
          approximate = true;
        }
      } else {
        readOnlyReason = "Its character map could not be read.";
        approximate = true;
      }
    } else if (encodingName) {
      readOnlyReason = `Uses the predefined character map “${encodingName}”, which the editor cannot read.`;
      approximate = true;
      vertical = encodingName.endsWith("-V");
    }
    const dw = numberOf(descendant?.lookup(N.DW)) ?? 1000;
    cidWidths = parseW(descendant?.lookupMaybe(N.W, PDFArray), dw);
    cidToGid = descendant?.lookup(N.CIDToGIDMap) instanceof PDFStream ? "map" : "identity";
  }

  // ---- simple font tables ------------------------------------------------------------------------------------
  let encodingTable: (string | undefined)[] = new Array<string | undefined>(256).fill(undefined);
  const glyphNameByCode = new Map<number, string>();
  const widths: (number | undefined)[] = new Array<number | undefined>(256).fill(undefined);
  let missingWidth = 0;
  let fontMatrix: Matrix | null = null;

  if (!composite) {
    const encoding = fontDict.lookup(N.Encoding);
    const symbolicStandard = standard === "Symbol" || standard === "ZapfDingbats";
    let base: (string | undefined)[];
    let differences: { code: number; name: string }[] = [];
    if (encoding instanceof PDFName) {
      base = baseEncoding((nameOf(encoding) as "WinAnsiEncoding") ?? "StandardEncoding");
    } else if (encoding instanceof PDFDict) {
      const baseName = nameOf(encoding.lookup(N.BaseEncoding));
      base = baseName ? baseEncoding(baseName as "WinAnsiEncoding") : symbolicStandard ? baseEncoding(standard as "Symbol") : subtype === "TrueType" ? baseEncoding("WinAnsiEncoding") : baseEncoding("StandardEncoding");
      differences = readDifferences(encoding.lookupMaybe(N.Differences, PDFArray));
    } else {
      base = symbolicStandard ? baseEncoding(standard as "Symbol") : subtype === "TrueType" ? baseEncoding("WinAnsiEncoding") : baseEncoding("StandardEncoding");
    }
    encodingTable = applyDifferences(base, differences);
    for (const { code, name } of differences) glyphNameByCode.set(code, name);

    const first = numberOf(fontDict.lookup(N.FirstChar)) ?? 0;
    const widthArray = fontDict.lookupMaybe(N.Widths, PDFArray);
    if (widthArray) {
      for (let i = 0; i < widthArray.size(); i += 1) {
        const w = numberOf(widthArray.lookup(i));
        const code = first + i;
        if (w !== undefined && code >= 0 && code < 256) widths[code] = w;
      }
    }
    missingWidth = numberOf(descriptor?.lookup(N.MissingWidth)) ?? 0;

    if (type3) {
      const matrix = fontDict.lookupMaybe(N.FontMatrix, PDFArray);
      const values = matrix ? Array.from({ length: 6 }, (_, i) => numberOf(matrix.lookup(i)) ?? Number.NaN) : [0.001, 0, 0, 0.001, 0, 0];
      fontMatrix = values.every(Number.isFinite) ? (values as unknown as Matrix) : [0.001, 0, 0, 0.001, 0, 0];
      readOnlyReason = "Its letters are drawings (a Type 3 font), so there is no text to change.";
    }
  }

  const symbolTable = standard === "Symbol" || standard === "ZapfDingbats" ? baseEncoding(standard) : null;

  const unicodeOf = (code: number): string | undefined => {
    if (toUnicode) {
      const text = unicodeFromCMap(toUnicode, code);
      if (text !== undefined && text !== "") return text;
    }
    if (composite) return undefined;
    return encodingTable[code] ?? symbolTable?.[code];
  };

  const widthOf = (code: number): number => {
    if (composite) {
      const cid = encodingCMap && !identityEncoding ? (cidFromCMap(encodingCMap, code) ?? code) : code;
      return cidWidths ? cidWidth(cidWidths, cid) : 1000;
    }
    if (type3 && fontMatrix) {
      const w = widths[code];
      return w === undefined ? 0 : w * fontMatrix[0] * 1000;
    }
    const declared = widths[code];
    if (declared !== undefined) return declared;
    if (afm) {
      const glyph = glyphNameByCode.get(code) ?? glyphNameFromUnicode(unicodeOf(code), standard as StandardName);
      const w = glyph ? afm.getWidthOfGlyph(glyph) : undefined;
      if (typeof w === "number") return w;
    }
    return missingWidth;
  };

  // A simple font with no widths and no standard metrics only has guessed advances.
  if (!composite && !type3 && !widths.some((w) => w !== undefined) && !afm) approximate = true;

  const used = new Set<number>();
  let reverse: Map<string, GlyphCode> | null = null;
  let reverseFor = -1;

  const candidateCodes = (): number[] => {
    if (composite) {
      const codes = new Set<number>();
      if (toUnicode) for (const [code] of unicodeEntries(toUnicode)) codes.add(code);
      // Where we know what the document uses, an embedded subset can only draw those glyphs.
      if (used.size > 0) return [...codes].filter((code) => used.has(code));
      return [...codes];
    }
    const codes: number[] = [];
    const restrict = embedded !== "none";
    for (let code = 0; code < 256; code += 1) {
      if (restrict && !used.has(code) && !(toUnicode && unicodeFromCMap(toUnicode, code) !== undefined && used.size === 0)) continue;
      codes.push(code);
    }
    return codes;
  };

  const buildReverse = (): Map<string, GlyphCode> => {
    const map = new Map<string, GlyphCode>();
    const length = composite ? (codespaces[0]?.bytes ?? 2) : 1;
    const consider = (code: number) => {
      const text = unicodeOf(code);
      if (text === undefined || text === "") return;
      const isSpace = text === " " || text === " ";
      if (!isSpace && widthOf(code) <= 0) return;
      const existing = map.get(text);
      // Prefer a code the document actually uses, then the lower code.
      if (existing && (used.has(existing.code) || !used.has(code)) && existing.code <= code) return;
      map.set(text, { code, length });
    };
    for (const code of candidateCodes()) consider(code);
    return map;
  };

  const model: FontModel = {
    key,
    resourceName,
    baseFont,
    subsetTag,
    subtype,
    composite,
    type3,
    vertical,
    embedded,
    family,
    bold,
    italic,
    ascent,
    descent,
    fontMatrix,
    readOnlyReason,
    approximate,
    used,
    decode(bytes) {
      if (!composite) return Array.from(bytes, (code) => ({ code, length: 1 }));
      return splitCodes(bytes, codespaces);
    },
    unicodeOf,
    widthOf,
    isWordSpace: (glyph) => glyph.length === 1 && glyph.code === 32,
    encodeChar(char) {
      if (reverse === null || reverseFor !== used.size) {
        reverse = buildReverse();
        reverseFor = used.size;
      }
      return reverse.get(char) ?? null;
    },
    availableChars() {
      if (reverse === null || reverseFor !== used.size) {
        reverse = buildReverse();
        reverseFor = used.size;
      }
      return new Set(reverse.keys());
    },
    toBytes(codes) {
      const out: number[] = [];
      for (const { code, length } of codes) for (let shift = (length - 1) * 8; shift >= 0; shift -= 8) out.push(Math.floor(code / 2 ** shift) & 0xff);
      return Uint8Array.from(out);
    },
  };

  void cidToGid;
  return model;
}

/** The glyph name to look up in the AFM metrics for a character, using the Symbol/ZapfDingbats/WinAnsi tables. */
function glyphNameFromUnicode(text: string | undefined, standard: StandardName): string | undefined {
  if (!text) return undefined;
  const codePoint = text.codePointAt(0) as number;
  const encoding = standard === "Symbol" ? Encodings.Symbol : standard === "ZapfDingbats" ? Encodings.ZapfDingbats : Encodings.WinAnsi;
  if (!encoding.canEncodeUnicodeCodePoint(codePoint)) return undefined;
  return encoding.encodeUnicodeCodePoint(codePoint).name;
}

export { unicodeForGlyphName };
