import { Encodings } from "@cantoo/pdf-lib/standard-fonts";

/**
 * Glyph name to Unicode, for fonts whose encoding is given as a `Differences` array of names (typical for
 * TeX output and many Type 1 fonts).
 *
 * The big sets (Latin-1 and typographic punctuation, Greek and maths from Symbol, Dingbats) come from the
 * encodings bundled with pdf-lib. The remainder below are names that exist in the Adobe Glyph List but not in
 * those encodings: Latin Extended-A, ligatures and a few accents. Unknown names return `undefined`, and the
 * engine then treats that code as not safely re-usable rather than guessing.
 */

const EXTRA =
  "fi:FB01 fl:FB02 ff:FB00 ffi:FB03 ffl:FB04 minus:2212 fraction:2044 dotlessi:0131 Lslash:0141 lslash:0142 " +
  "ring:02DA caron:02C7 breve:02D8 dotaccent:02D9 hungarumlaut:02DD ogonek:02DB nbspace:00A0 nonbreakingspace:00A0 " +
  "softhyphen:00AD sfthyphen:00AD hyphenminus:002D overscore:00AF " +
  "Amacron:0100 amacron:0101 Abreve:0102 abreve:0103 Aogonek:0104 aogonek:0105 Cacute:0106 cacute:0107 " +
  "Ccaron:010C ccaron:010D Dcaron:010E dcaron:010F Dcroat:0110 dcroat:0111 Emacron:0112 emacron:0113 " +
  "Edotaccent:0116 edotaccent:0117 Eogonek:0118 eogonek:0119 Ecaron:011A ecaron:011B Gbreve:011E gbreve:011F " +
  "Gcommaaccent:0122 gcommaaccent:0123 Imacron:012A imacron:012B Iogonek:012E iogonek:012F Idotaccent:0130 " +
  "Kcommaaccent:0136 kcommaaccent:0137 Lacute:0139 lacute:013A Lcommaaccent:013B lcommaaccent:013C Lcaron:013D " +
  "lcaron:013E Nacute:0143 nacute:0144 Ncommaaccent:0145 ncommaaccent:0146 Ncaron:0147 ncaron:0148 Omacron:014C " +
  "omacron:014D Ohungarumlaut:0150 ohungarumlaut:0151 Racute:0154 racute:0155 Rcommaaccent:0156 rcommaaccent:0157 " +
  "Rcaron:0158 rcaron:0159 Sacute:015A sacute:015B Scedilla:015E scedilla:015F Tcommaaccent:0162 tcommaaccent:0163 " +
  "Tcaron:0164 tcaron:0165 Umacron:016A umacron:016B Uring:016E uring:016F Uhungarumlaut:0170 uhungarumlaut:0171 " +
  "Uogonek:0172 uogonek:0173 Zacute:0179 zacute:017A Zdotaccent:017B zdotaccent:017C " +
  "afii10017:0410 afii10018:0411 afii10019:0412 afii10020:0413 afii10021:0414 afii10022:0415 afii10024:0416 " +
  "afii10025:0417 afii10026:0418 afii10027:0419 afii10028:041A afii10029:041B afii10030:041C afii10031:041D " +
  "afii10032:041E afii10033:041F afii10034:0420 afii10035:0421 afii10036:0422 afii10037:0423 afii10038:0424 " +
  "afii10039:0425 afii10040:0426 afii10041:0427 afii10042:0428 afii10043:0429 afii10044:042A afii10045:042B " +
  "afii10046:042C afii10047:042D afii10048:042E afii10049:042F afii10065:0430 afii10066:0431 afii10067:0432 " +
  "afii10068:0433 afii10069:0434 afii10070:0435 afii10072:0436 afii10073:0437 afii10074:0438 afii10075:0439 " +
  "afii10076:043A afii10077:043B afii10078:043C afii10079:043D afii10080:043E afii10081:043F afii10082:0440 " +
  "afii10083:0441 afii10084:0442 afii10085:0443 afii10086:0444 afii10087:0445 afii10088:0446 afii10089:0447 " +
  "afii10090:0448 afii10091:0449 afii10092:044A afii10093:044B afii10094:044C afii10095:044D afii10096:044E " +
  "afii10097:044F afii10023:0401 afii10071:0451 " +
  "arrowleft:2190 arrowup:2191 arrowright:2192 arrowdown:2193 arrowboth:2194 summation:2211 product:220F " +
  "radical:221A infinity:221E integral:222B approxequal:2248 notequal:2260 lessequal:2264 greaterequal:2265 " +
  "partialdiff:2202 lozenge:25CA checkmark:2713";

let table: Map<string, string> | null = null;

function build(): Map<string, string> {
  const map = new Map<string, string>();
  for (const encoding of [Encodings.WinAnsi, Encodings.Symbol, Encodings.ZapfDingbats]) {
    for (const codePoint of encoding.supportedCodePoints) {
      const { name } = encoding.encodeUnicodeCodePoint(codePoint);
      if (name && !map.has(name)) map.set(name, String.fromCodePoint(codePoint));
    }
  }
  for (const entry of EXTRA.split(" ")) {
    const [name, hex] = entry.split(":");
    if (name && hex) map.set(name, String.fromCodePoint(Number.parseInt(hex, 16)));
  }
  map.set("space", " ");
  return map;
}

/** The Unicode text for an Adobe glyph name, or `undefined` when the name is not one we know. */
export function unicodeForGlyphName(rawName: string): string | undefined {
  if (!table) table = build();
  // A suffix after the first period selects a variant ("a.sc", "one.oldstyle"): the base character is meant.
  const dot = rawName.indexOf(".");
  const name = dot > 0 ? rawName.slice(0, dot) : rawName;
  if (name === "" || name === "notdef") return undefined;

  const direct = table.get(name);
  if (direct !== undefined) return direct;

  // Ligatures and other compound names are components joined by underscores: "f_f_i".
  if (name.includes("_")) {
    const parts = name.split("_").map((part) => unicodeForGlyphName(part));
    return parts.every((part) => part !== undefined) ? parts.join("") : undefined;
  }

  const uni = /^uni((?:[0-9A-F]{4})+)$/.exec(name);
  if (uni) {
    const hex = uni[1] as string;
    let text = "";
    for (let i = 0; i < hex.length; i += 4) text += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16));
    return text;
  }
  const u = /^u([0-9A-F]{4,6})$/.exec(name);
  if (u) {
    const value = Number.parseInt(u[1] as string, 16);
    return value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : undefined;
  }
  // Single ASCII letters and digits are their own names ("A", "b"); names like "one" are in the table already.
  if (/^[A-Za-z]$/.test(name)) return name;
  return undefined;
}
