/**
 * The fonts the Office converters draw with.
 *
 * Word, Excel and PowerPoint files name fonts we do not have (Calibri, Arial, Times New Roman...). Layout only comes
 * out like the original if the substitute has the same letter widths, so each name is mapped to an open font made to
 * match it: Carlito for Calibri, Arimo for Arial, Tinos for Times New Roman, Cousine for Courier New and Caladea for
 * Cambria. DejaVu Sans covers symbols and many alphabets those do not have.
 */
import { AppError } from "../errors";
import { EmbeddedFont } from "./pdfBuilder";

export type FamilyId = "carlito" | "arimo" | "tinos" | "cousine" | "caladea" | "dejavu";
export type Variant = "regular" | "bold" | "italic" | "boldItalic";

/** How a host (a worker, or a test) hands over a font file. */
export type FontFileLoader = (family: FamilyId, variant: Variant) => Promise<Uint8Array>;

let loadFontFile: FontFileLoader | null = null;

export function setOfficeFontLoader(loader: FontFileLoader): void {
  loadFontFile = loader;
}

const FAMILY_LABEL: Record<FamilyId, string> = { carlito: "Carlito", arimo: "Arimo", tinos: "Tinos", cousine: "Cousine", caladea: "Caladea", dejavu: "DejaVuSans" };

const NAME_TO_FAMILY: Record<string, FamilyId> = {};
const assign = (family: FamilyId, names: string[]) => {
  for (const name of names) NAME_TO_FAMILY[name] = family;
};
assign("carlito", ["calibri", "calibri light", "carlito", "aptos", "aptos display", "aptos narrow", "candara", "corbel", "segoe ui", "segoe ui light", "segoe ui semilight", "gill sans mt", "lato", "source sans pro", "open sans", "noto sans", "roboto", "tw cen mt", "franklin gothic book", "franklin gothic medium"]);
assign("arimo", ["arial", "arial narrow", "arial black", "arial unicode ms", "helvetica", "helvetica neue", "liberation sans", "arimo", "nimbus sans", "tahoma", "trebuchet ms", "century gothic", "microsoft sans serif", "myriad pro", "verdana pro", "ms sans serif", "ms gothic", "ms pgothic", "malgun gothic"]);
assign("tinos", ["times new roman", "times", "liberation serif", "tinos", "georgia", "garamond", "book antiqua", "palatino", "palatino linotype", "bookman old style", "century schoolbook", "century", "minion pro", "baskerville old face", "perpetua", "rockwell", "ms mincho", "ms serif", "nimbus roman", "cambria math"]);
assign("cousine", ["courier new", "courier", "liberation mono", "cousine", "consolas", "lucida console", "monaco", "menlo", "andale mono", "source code pro", "nimbus mono", "ms gothic mono", "terminal"]);
assign("caladea", ["cambria", "caladea", "constantia"]);
assign("dejavu", ["dejavu sans", "verdana", "lucida sans", "lucida sans unicode", "bitstream vera sans", "symbol", "wingdings", "wingdings 2", "wingdings 3", "webdings", "zapf dingbats", "segoe ui symbol", "segoe ui emoji"]);

export type FontClass = "roman" | "swiss" | "modern" | "script" | "decorative" | "auto";

/** The bundled family that stands in for a font name. Unknown names use the document's own hint, then a sans-serif. */
export function familyFor(name: string | undefined, hint: FontClass = "auto", fixedPitch = false): FamilyId {
  const key = (name ?? "").trim().toLowerCase();
  const known = NAME_TO_FAMILY[key];
  if (known) return known;
  if (fixedPitch || hint === "modern") return fixedPitch ? "cousine" : "arimo";
  if (hint === "roman") return "tinos";
  if (key.includes("mono") || key.includes("courier") || key.includes("consol")) return "cousine";
  if (key.includes("serif") && !key.includes("sans")) return "tinos";
  return "carlito";
}

const variantOf = (bold: boolean, italic: boolean): Variant => (bold && italic ? "boldItalic" : bold ? "bold" : italic ? "italic" : "regular");

export interface FontRequest {
  family: FamilyId;
  bold: boolean;
  italic: boolean;
}

/** Characters that are never drawn, and the ones that are drawn as something else. */
export function cleanChar(codePoint: number): number | null {
  if (codePoint === 0xad || codePoint === 0x200b || codePoint === 0x200c || codePoint === 0x200d || codePoint === 0xfeff || codePoint === 0x200e || codePoint === 0x200f) return null;
  if (codePoint === 0xa0 || codePoint === 0x2007 || codePoint === 0x202f || codePoint === 0x2009 || codePoint === 0x2002 || codePoint === 0x2003) return 0x20;
  if (codePoint < 0x20 && codePoint !== 0x09) return null;
  return codePoint;
}

/** Symbol and Wingdings put their pictures in the private-use area; these are the few Word uses for bullets and ticks. */
const SYMBOL_FONT_MAP: Record<number, number> = {
  0xf0b7: 0x2022, // Symbol: round bullet
  0xf0a7: 0x25aa, // Wingdings: small square
  0xf0d8: 0x27a2, // Wingdings: arrowhead
  0xf0fc: 0x2713, // Wingdings: check mark
  0xf076: 0x2756, // Wingdings: diamond cross
  0xf06c: 0x25cf, // Wingdings: black circle
  0xf06e: 0x25a0, // Wingdings: black square
  0xf071: 0x274f, // Wingdings: shadowed square
  0xf0a8: 0x25fb, // Wingdings: white square
  0xf0e0: 0x2794, // Wingdings: arrow
  0xf0ab: 0x2756,
  0xf09f: 0x2022,
  0xf0b2: 0x25a1,
  0xf0a1: 0x25cb,
  0xf06f: 0x25a1,
};

export function symbolToUnicode(codePoint: number): number {
  return SYMBOL_FONT_MAP[codePoint] ?? codePoint;
}

/** Fonts for one conversion. `prepare` loads what the document needs; after that, lookups are synchronous. */
export class FontLibrary {
  private readonly fonts = new Map<string, EmbeddedFont>();
  private readonly loading = new Map<string, Promise<EmbeddedFont>>();
  /** Characters that no bundled font can draw, so the result can say so. */
  readonly missing = new Set<number>();

  private key(family: FamilyId, variant: Variant): string {
    return `${family}:${variant}`;
  }

  async load(family: FamilyId, bold: boolean, italic: boolean): Promise<EmbeddedFont> {
    const variant = variantOf(bold, italic);
    const key = this.key(family, variant);
    const ready = this.fonts.get(key);
    if (ready) return ready;
    let pending = this.loading.get(key);
    if (!pending) {
      const loader = loadFontFile;
      if (!loader) throw new AppError("ENGINE_FAILED", "The built-in fonts are not available, so the document cannot be converted here.");
      pending = loader(family, variant).then(
        (bytes) => {
          const font = new EmbeddedFont(`${FAMILY_LABEL[family]}-${variant}`, bytes);
          this.fonts.set(key, font);
          return font;
        },
        (error: unknown) => {
          throw new AppError("ENGINE_FAILED", "A built-in font could not be loaded.", { details: error instanceof Error ? error.message : String(error), cause: error });
        },
      );
      this.loading.set(key, pending);
    }
    return pending;
  }

  /** Loads the faces a document uses; `text` per request lets us also load the fallback only when some character needs it. */
  async prepare(requests: { request: FontRequest; text: string }[]): Promise<void> {
    const wantsFallback = new Set<Variant>();
    for (const { request, text } of requests) {
      const primary = await this.load(request.family, request.bold, request.italic);
      for (const char of text) {
        const code = cleanChar(symbolToUnicode(char.codePointAt(0) as number));
        if (code === null || code === 0x20 || code === 0x09) continue;
        if (!primary.has(code)) wantsFallback.add(variantOf(request.bold, request.italic));
      }
    }
    for (const variant of wantsFallback) await this.load("dejavu", variant === "bold" || variant === "boldItalic", variant === "italic" || variant === "boldItalic");
  }

  /**
   * The font that draws `codePoint` for this request: the matching family if it has the glyph, else DejaVu Sans, else
   * nothing (the character is then recorded as missing and drawn as a question mark by the caller).
   */
  pick(request: FontRequest, codePoint: number): EmbeddedFont | null {
    const variant = variantOf(request.bold, request.italic);
    const primary = this.fonts.get(this.key(request.family, variant));
    if (primary?.has(codePoint)) return primary;
    const fallback = this.fonts.get(this.key("dejavu", variant));
    if (fallback?.has(codePoint)) return fallback;
    return null;
  }

  /** The family's own font for measuring and for vertical metrics, even before any text needs it. */
  base(request: FontRequest): EmbeddedFont {
    const font = this.fonts.get(this.key(request.family, variantOf(request.bold, request.italic)));
    if (!font) throw new AppError("ENGINE_FAILED", "A font was used before it was loaded.");
    return font;
  }

  all(): EmbeddedFont[] {
    return [...this.fonts.values()];
  }
}
