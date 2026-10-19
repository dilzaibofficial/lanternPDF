import { Encodings } from "@cantoo/pdf-lib/standard-fonts";
import { unicodeForGlyphName } from "./glyphNames";

/**
 * Single-byte base encodings of simple fonts: code to Unicode text. `undefined` means the code has no character
 * in that encoding.
 */

export type BaseEncodingName = "WinAnsiEncoding" | "MacRomanEncoding" | "MacExpertEncoding" | "StandardEncoding";

const cache = new Map<string, (string | undefined)[]>();

function fromTextDecoder(label: string): (string | undefined)[] {
  const decoder = new TextDecoder(label);
  const table: (string | undefined)[] = new Array<string | undefined>(256).fill(undefined);
  for (let code = 0x20; code < 256; code += 1) {
    const text = decoder.decode(Uint8Array.of(code));
    const cp = text.codePointAt(0) as number;
    // C1 control characters stand for codes the encoding leaves undefined.
    if (text.length === 1 && cp >= 0x7f && cp <= 0x9f) continue;
    if (text !== "�") table[code] = text;
  }
  return table;
}

/** Adobe StandardEncoding: ASCII with two quote differences, and the high range of typographic characters. */
function standard(): (string | undefined)[] {
  const table: (string | undefined)[] = new Array<string | undefined>(256).fill(undefined);
  for (let code = 0x20; code < 0x7f; code += 1) table[code] = String.fromCharCode(code);
  table[0x27] = "’"; // quoteright
  table[0x60] = "‘"; // quoteleft
  const high: Record<number, number> = {
    0xa1: 0xa1, 0xa2: 0xa2, 0xa3: 0xa3, 0xa4: 0x2044, 0xa5: 0xa5, 0xa6: 0x192, 0xa7: 0xa7, 0xa8: 0xa4, 0xa9: 0x27,
    0xaa: 0x201c, 0xab: 0xab, 0xac: 0x2039, 0xad: 0x203a, 0xae: 0xfb01, 0xaf: 0xfb02, 0xb1: 0x2013, 0xb2: 0x2020,
    0xb3: 0x2021, 0xb4: 0xb7, 0xb6: 0xb6, 0xb7: 0x2022, 0xb8: 0x201a, 0xb9: 0x201e, 0xba: 0x201d, 0xbb: 0xbb,
    0xbc: 0x2026, 0xbd: 0x2030, 0xbf: 0xbf, 0xc1: 0x60, 0xc2: 0xb4, 0xc3: 0x2c6, 0xc4: 0x2dc, 0xc5: 0xaf, 0xc6: 0x2d8,
    0xc7: 0x2d9, 0xc8: 0xa8, 0xca: 0x2da, 0xcb: 0xb8, 0xcd: 0x2dd, 0xce: 0x2db, 0xcf: 0x2c7, 0xd0: 0x2014,
    0xe1: 0xc6, 0xe3: 0xaa, 0xe8: 0x141, 0xe9: 0xd8, 0xea: 0x152, 0xeb: 0xba, 0xf1: 0xe6, 0xf5: 0x131, 0xf8: 0x142,
    0xf9: 0xf8, 0xfa: 0x153, 0xfb: 0xdf,
  };
  for (const [code, cp] of Object.entries(high)) table[Number(code)] = String.fromCodePoint(cp);
  return table;
}

/** Built-in encoding of the Symbol and ZapfDingbats standard fonts. */
function symbolic(which: "Symbol" | "ZapfDingbats"): (string | undefined)[] {
  const table: (string | undefined)[] = new Array<string | undefined>(256).fill(undefined);
  const encoding = Encodings[which];
  for (const cp of encoding.supportedCodePoints) {
    const { code } = encoding.encodeUnicodeCodePoint(cp);
    if (table[code] === undefined) table[code] = String.fromCodePoint(cp);
  }
  return table;
}

export function baseEncoding(name: BaseEncodingName | "Symbol" | "ZapfDingbats"): (string | undefined)[] {
  let table = cache.get(name);
  if (!table) {
    switch (name) {
      case "WinAnsiEncoding":
        table = fromTextDecoder("windows-1252");
        break;
      case "MacRomanEncoding":
        table = fromTextDecoder("macintosh");
        break;
      case "StandardEncoding":
        table = standard();
        break;
      case "Symbol":
      case "ZapfDingbats":
        table = symbolic(name);
        break;
      default:
        table = new Array<string | undefined>(256).fill(undefined);
    }
    cache.set(name, table);
  }
  return table;
}

/** Applies a `Differences` array (already read into code/name pairs) on top of a base table. */
export function applyDifferences(base: readonly (string | undefined)[], differences: readonly { code: number; name: string }[]): (string | undefined)[] {
  const table = [...base];
  for (const { code, name } of differences) {
    if (code < 0 || code > 255) continue;
    table[code] = unicodeForGlyphName(name);
  }
  return table;
}
