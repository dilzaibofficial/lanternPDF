import { type PDFDocument, type PDFFont, StandardFonts } from "@cantoo/pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { AppError } from "../errors";

export type FontFamily = "sans" | "serif" | "mono";

export interface FontChoice {
  family: FontFamily;
  bold: boolean;
  italic: boolean;
}

const STANDARD: Record<FontFamily, { regular: StandardFonts; bold: StandardFonts; italic: StandardFonts; boldItalic: StandardFonts }> = {
  sans: { regular: StandardFonts.Helvetica, bold: StandardFonts.HelveticaBold, italic: StandardFonts.HelveticaOblique, boldItalic: StandardFonts.HelveticaBoldOblique },
  serif: { regular: StandardFonts.TimesRoman, bold: StandardFonts.TimesRomanBold, italic: StandardFonts.TimesRomanItalic, boldItalic: StandardFonts.TimesRomanBoldItalic },
  mono: { regular: StandardFonts.Courier, bold: StandardFonts.CourierBold, italic: StandardFonts.CourierOblique, boldItalic: StandardFonts.CourierBoldOblique },
};

/**
 * Files of the bundled Unicode fallback (DejaVu Sans). The standard PDF fonts only cover Latin-1, so
 * text in Cyrillic, Greek and many symbols is drawn with this instead. It is loaded on demand.
 */
export type UnicodeFontFile = "DejaVuSans.ttf" | "DejaVuSans-Bold.ttf" | "DejaVuSans-Oblique.ttf" | "DejaVuSans-BoldOblique.ttf";

let loadUnicodeFile: ((file: UnicodeFontFile) => Promise<Uint8Array>) | null = null;

/** The host (worker entry or test setup) tells us how to fetch the bundled font files. */
export function setUnicodeFontLoader(loader: (file: UnicodeFontFile) => Promise<Uint8Array>): void {
  loadUnicodeFile = loader;
}

function unicodeFileFor(choice: FontChoice): UnicodeFontFile {
  if (choice.bold && choice.italic) return "DejaVuSans-BoldOblique.ttf";
  if (choice.bold) return "DejaVuSans-Bold.ttf";
  if (choice.italic) return "DejaVuSans-Oblique.ttf";
  return "DejaVuSans.ttf";
}

const cache = new WeakMap<PDFDocument, Map<string, Promise<PDFFont>>>();

function cached(doc: PDFDocument, key: string, create: () => Promise<PDFFont>): Promise<PDFFont> {
  let perDoc = cache.get(doc);
  if (!perDoc) {
    perDoc = new Map();
    cache.set(doc, perDoc);
  }
  let font = perDoc.get(key);
  if (!font) {
    font = create();
    perDoc.set(key, font);
  }
  return font;
}

const glyphSets = new WeakMap<PDFFont, Set<number>>();

/**
 * True when the font really has a glyph for every character of `text` (line breaks are not characters).
 * `encodeText` alone is not enough: for embedded fonts a missing glyph maps silently to an empty box.
 */
export function canEncode(font: PDFFont, text: string): boolean {
  let set = glyphSets.get(font);
  if (!set) {
    set = new Set(font.getCharacterSet());
    glyphSets.set(font, set);
  }
  for (const char of text.replace(/\r\n|\r|\n/g, "")) {
    if (!set.has(char.codePointAt(0) as number)) return false;
  }
  return true;
}

function standardName(choice: FontChoice): StandardFonts {
  const set = STANDARD[choice.family];
  if (choice.bold && choice.italic) return set.boldItalic;
  if (choice.bold) return set.bold;
  if (choice.italic) return set.italic;
  return set.regular;
}

async function embedBytes(doc: PDFDocument, bytes: Uint8Array, label: string): Promise<PDFFont> {
  doc.registerFontkit(fontkit);
  try {
    // Embedded in full, not subset: fontkit's TrueType subsetter fails on common fonts (it throws while
    // saving, or in some builds writes a font whose text cannot be extracted). The price is the font's
    // size in the output file, and it is only paid when non-Latin text is actually drawn.
    return await doc.embedFont(bytes, { subset: false });
  } catch (error) {
    throw new AppError("INVALID_FILE", `The ${label} could not be used as a font. Try a different TrueType or OpenType file.`, {
      details: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  }
}

/**
 * Picks a font that can draw `text`: the standard PDF font when it can (small files, always
 * available), otherwise the bundled Unicode font. A custom font from the user wins over both.
 */
export async function resolveFont(doc: PDFDocument, choice: FontChoice, text: string, custom?: Uint8Array): Promise<PDFFont> {
  if (custom) {
    const font = await cached(doc, "custom", () => embedBytes(doc, custom, "uploaded font"));
    if (!canEncode(font, text)) {
      throw new AppError("INVALID_INPUT", "The font you uploaded does not contain every character in your text. Choose a font that does, or change the text.");
    }
    return font;
  }

  const name = standardName(choice);
  const standard = await cached(doc, `standard:${name}`, () => doc.embedFont(name));
  if (canEncode(standard, text)) return standard;

  if (!loadUnicodeFile) {
    throw new AppError("UNSUPPORTED", "This text contains characters the standard fonts cannot draw, and the bundled Unicode font is not available.");
  }
  const file = unicodeFileFor(choice);
  const loader = loadUnicodeFile;
  const unicode = await cached(doc, `unicode:${file}`, async () => embedBytes(doc, await loader(file), "bundled Unicode font"));
  if (!canEncode(unicode, text)) {
    throw new AppError(
      "INVALID_INPUT",
      "Some characters in your text are not available in the built-in fonts (they cover Latin, Greek and Cyrillic). Upload a font that includes them, or change the text.",
    );
  }
  return unicode;
}
