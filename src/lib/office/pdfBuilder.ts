/**
 * Writes the PDF for the Office converters.
 *
 * The converters work out where everything goes (lines of text, boxes, images) and this module writes it: page content
 * with coordinates measured from the top-left corner, fonts that hold only the glyphs actually used, and links.
 * pdf-lib supplies the file structure; the content streams and fonts are written here so that nothing depends on
 * fontkit's subsetter.
 */
import { PDFDocument, PDFHexString, PDFName, PDFString, type PDFImage, type PDFRef } from "@cantoo/pdf-lib";
import { AppError } from "../errors";
import { type TtfFont, deflate, parseTtf } from "./ttf";

/** A number for a PDF content stream: at most three decimals, no trailing zeros, never exponent notation. */
export function n(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/** "#rrggbb" or "rrggbb" to PDF colour components. Anything unreadable is black. */
export function rgb(color: string): [number, number, number] {
  const hex = color.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return [0, 0, 0];
  return [Number.parseInt(hex.slice(0, 2), 16) / 255, Number.parseInt(hex.slice(2, 4), 16) / 255, Number.parseInt(hex.slice(4, 6), 16) / 255];
}

const fillOp = (color: string): string => `${rgb(color).map(n).join(" ")} rg`;
const strokeOp = (color: string): string => `${rgb(color).map(n).join(" ")} RG`;

/** One TrueType font in the output file. Remembers which glyphs are used so that only those are written. */
export class EmbeddedFont {
  readonly ttf: TtfFont;
  private readonly used = new Map<number, number>(); // glyph -> the character it was first used for
  private ref: PDFRef | null = null;

  constructor(
    readonly label: string,
    private readonly source: Uint8Array,
  ) {
    this.ttf = parseTtf(source);
  }

  has(codePoint: number): boolean {
    return this.ttf.has(codePoint);
  }

  /** Width of `text` at `size` points. Characters the font lacks count as the font's missing-glyph width. */
  width(text: string, size: number): number {
    let units = 0;
    for (const char of text) units += this.ttf.advance(this.ttf.glyphFor(char.codePointAt(0) as number));
    return (units * size) / this.ttf.unitsPerEm;
  }

  /** The glyph numbers for `text` (recording them as used) as a PDF hex string body. */
  encode(text: string): string {
    let hex = "";
    for (const char of text) {
      const code = char.codePointAt(0) as number;
      const glyph = this.ttf.glyphFor(code);
      if (glyph !== 0 && !this.used.has(glyph)) this.used.set(glyph, code);
      hex += glyph.toString(16).padStart(4, "0");
    }
    return hex;
  }

  /** Writes the font objects (once) and returns the reference to use in page resources. */
  finish(doc: PDFDocument): PDFRef {
    if (this.ref) return this.ref;
    const { context } = doc;
    const ttf = this.ttf;
    const scale = 1000 / ttf.unitsPerEm;
    const glyphs = [...this.used.keys()].sort((a, b) => a - b);
    const subsetBytes = ttf.subset(glyphs);
    const program = deflate(subsetBytes);
    const tag = subsetTag(this.label);
    const baseFont = `${tag}+${this.label.replace(/[^A-Za-z0-9-]/g, "")}`;

    // Already deflated above, so it is registered as a raw stream with its filter named (no second compression).
    const fontFileRef = context.register(context.stream(program, { Filter: "FlateDecode", Length1: subsetBytes.length }));
    const descriptor = context.register(
      context.obj({
        Type: "FontDescriptor",
        FontName: baseFont,
        Flags: 4,
        FontBBox: ttf.bbox.map((value) => Math.round(value * scale)),
        ItalicAngle: ttf.italicAngle,
        Ascent: Math.round(ttf.ascent * scale),
        Descent: -Math.round(ttf.descent * scale),
        CapHeight: Math.round(ttf.capHeight * scale),
        StemV: 80,
        FontFile2: fontFileRef,
      }),
    );
    const widths: (number | number[])[] = [];
    for (const glyph of glyphs) widths.push(glyph, [Math.round(ttf.advance(glyph) * scale)]);
    const cidFont = context.register(
      context.obj({
        Type: "Font",
        Subtype: "CIDFontType2",
        BaseFont: baseFont,
        CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Identity"), Supplement: 0 },
        FontDescriptor: descriptor,
        W: widths,
        DW: Math.round(ttf.advance(0) * scale),
        CIDToGIDMap: "Identity",
      }),
    );
    const toUnicode = context.register(context.flateStream(this.toUnicodeCMap(glyphs)));
    this.ref = context.register(
      context.obj({
        Type: "Font",
        Subtype: "Type0",
        BaseFont: baseFont,
        Encoding: "Identity-H",
        DescendantFonts: [cidFont],
        ToUnicode: toUnicode,
      }),
    );
    return this.ref;
  }

  /** The map that lets viewers copy, search and read the text aloud. */
  private toUnicodeCMap(glyphs: number[]): string {
    const lines: string[] = [];
    for (let i = 0; i < glyphs.length; i += 100) {
      const block = glyphs.slice(i, i + 100);
      lines.push(`${block.length} beginbfchar`);
      for (const glyph of block) lines.push(`<${glyph.toString(16).padStart(4, "0")}> <${utf16Hex(this.used.get(glyph) as number)}>`);
      lines.push("endbfchar");
    }
    return [
      "/CIDInit /ProcSet findresource begin",
      "12 dict begin",
      "begincmap",
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
      "/CMapName /Adobe-Identity-UCS def",
      "/CMapType 2 def",
      "1 begincodespacerange",
      "<0000> <FFFF>",
      "endcodespacerange",
      ...lines,
      "endcmap",
      "CMapName currentdict /CMap defineresource pop",
      "end",
      "end",
    ].join("\n");
  }

  /** Not used by callers; kept so a font can be re-read if it has to be rebuilt. */
  get bytes(): Uint8Array {
    return this.source;
  }
}

function subsetTag(label: string): string {
  let hash = 0;
  for (const char of label) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  let tag = "";
  for (let i = 0; i < 6; i += 1) {
    tag += String.fromCharCode(65 + (hash % 26));
    hash = Math.floor(hash / 26) + i * 7;
  }
  return tag;
}

function utf16Hex(codePoint: number): string {
  if (codePoint < 0x10000) return codePoint.toString(16).padStart(4, "0");
  const value = codePoint - 0x10000;
  const high = 0xd800 + (value >> 10);
  const low = 0xdc00 + (value & 0x3ff);
  return high.toString(16) + low.toString(16);
}

export interface EmbeddedImage {
  ref: PDFRef;
  width: number;
  height: number;
}

export interface LinkTarget {
  uri?: string;
  /** Zero-based index of a page in this document. */
  page?: number;
}

export interface StrokeStyle {
  color: string;
  width: number;
  dash?: readonly number[];
  cap?: "butt" | "round" | "square";
}

/** One page being drawn. All coordinates are in points from the top-left corner. */
export class PageBuilder {
  readonly ops: string[] = [];
  readonly fontNames = new Map<EmbeddedFont, string>();
  readonly imageNames = new Map<PDFRef, string>();
  readonly stateNames = new Map<number, string>();
  readonly links: { x: number; y: number; width: number; height: number; target: LinkTarget }[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  private y(value: number): number {
    return this.height - value;
  }

  save(): void {
    this.ops.push("q");
  }

  restore(): void {
    this.ops.push("Q");
  }

  /** Everything drawn until the matching `restore()` is cut off outside this box. */
  clipRect(x: number, y: number, width: number, height: number): void {
    this.ops.push(`${n(x)} ${n(this.y(y + height))} ${n(width)} ${n(height)} re W n`);
  }

  private alpha(opacity: number): string | null {
    if (opacity >= 0.999) return null;
    const key = Math.round(opacity * 1000);
    let name = this.stateNames.get(key);
    if (!name) {
      name = `GS${this.stateNames.size + 1}`;
      this.stateNames.set(key, name);
    }
    return `/${name} gs`;
  }

  fillRect(x: number, y: number, width: number, height: number, color: string, opacity = 1): void {
    if (width <= 0 || height <= 0) return;
    const gs = this.alpha(opacity);
    this.ops.push(`q ${gs ?? ""} ${fillOp(color)} ${n(x)} ${n(this.y(y + height))} ${n(width)} ${n(height)} re f Q`);
  }

  strokeRect(x: number, y: number, width: number, height: number, style: StrokeStyle): void {
    this.ops.push(`q ${this.strokeState(style)} ${n(x)} ${n(this.y(y + height))} ${n(width)} ${n(height)} re S Q`);
  }

  line(x1: number, y1: number, x2: number, y2: number, style: StrokeStyle): void {
    this.ops.push(`q ${this.strokeState(style)} ${n(x1)} ${n(this.y(y1))} m ${n(x2)} ${n(this.y(y2))} l S Q`);
  }

  private strokeState(style: StrokeStyle): string {
    const cap = style.cap === "round" ? 1 : style.cap === "square" ? 2 : 0;
    const dash = style.dash && style.dash.length > 0 ? `[${style.dash.map(n).join(" ")}] 0 d` : "";
    return `${strokeOp(style.color)} ${n(Math.max(0.1, style.width))} w ${cap} J ${dash}`;
  }

  /** Raw path operators in this page's own coordinates (y measured down); see `pathOps` for building them. */
  path(commands: string, paint: { fill?: string; stroke?: StrokeStyle; opacity?: number; evenOdd?: boolean }): void {
    const gs = this.alpha(paint.opacity ?? 1);
    const operator = paint.fill && paint.stroke ? (paint.evenOdd ? "B*" : "B") : paint.fill ? (paint.evenOdd ? "f*" : "f") : paint.stroke ? "S" : "n";
    this.ops.push(`q ${gs ?? ""} ${paint.fill ? fillOp(paint.fill) : ""} ${paint.stroke ? this.strokeState(paint.stroke) : ""} ${commands} ${operator} Q`);
  }

  /** Moves/lines/curves with y measured down, for use with `path`. */
  pathOps = {
    move: (x: number, y: number) => `${n(x)} ${n(this.y(y))} m`,
    line: (x: number, y: number) => `${n(x)} ${n(this.y(y))} l`,
    curve: (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => `${n(x1)} ${n(this.y(y1))} ${n(x2)} ${n(this.y(y2))} ${n(x3)} ${n(this.y(y3))} c`,
    close: () => "h",
  };

  /**
   * Draws text with its baseline at `baseline`. `rise` lifts it (superscript) and `charSpacing` widens it.
   * Text is drawn as one run; justified lines are drawn word by word by the caller.
   */
  text(font: EmbeddedFont, size: number, x: number, baseline: number, text: string, color: string, extra: { charSpacing?: number; opacity?: number } = {}): void {
    if (text === "" || size <= 0) return;
    let name = this.fontNames.get(font);
    if (!name) {
      name = `F${this.fontNames.size + 1}`;
      this.fontNames.set(font, name);
    }
    const gs = this.alpha(extra.opacity ?? 1);
    const spacing = extra.charSpacing ? `${n(extra.charSpacing)} Tc ` : "";
    this.ops.push(`q ${gs ?? ""} ${fillOp(color)} BT /${name} ${n(size)} Tf ${spacing}1 0 0 1 ${n(x)} ${n(this.y(baseline))} Tm <${font.encode(text)}> Tj ET Q`);
  }

  /** Draws an embedded image into the box (x, y) - (x + width, y + height); a rotation turns it about the box centre. */
  image(image: EmbeddedImage, x: number, y: number, width: number, height: number, options: { rotate?: number; flipX?: boolean; flipY?: boolean; opacity?: number } = {}): void {
    let name = this.imageNames.get(image.ref);
    if (!name) {
      name = `Im${this.imageNames.size + 1}`;
      this.imageNames.set(image.ref, name);
    }
    const gs = this.alpha(options.opacity ?? 1);
    const cx = x + width / 2;
    const cy = this.y(y + height / 2);
    const angle = (-(options.rotate ?? 0) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const sx = options.flipX ? -1 : 1;
    const sy = options.flipY ? -1 : 1;
    // Unit square -> box, flipped and turned about the centre.
    const a = width * sx * cos;
    const b = width * sx * sin;
    const c = -height * sy * sin;
    const d = height * sy * cos;
    const e = cx - (a + c) / 2;
    const f = cy - (b + d) / 2;
    this.ops.push(`q ${gs ?? ""} ${n(a)} ${n(b)} ${n(c)} ${n(d)} ${n(e)} ${n(f)} cm /${name} Do Q`);
  }

  link(x: number, y: number, width: number, height: number, target: LinkTarget): void {
    this.links.push({ x, y, width, height, target });
  }
}

export interface DocumentInfo {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
}

export class PdfBuilder {
  private readonly fonts = new Set<EmbeddedFont>();
  readonly pages: PageBuilder[] = [];

  private constructor(readonly doc: PDFDocument) {}

  static async create(): Promise<PdfBuilder> {
    return new PdfBuilder(await PDFDocument.create({ updateMetadata: false }));
  }

  addPage(width: number, height: number): PageBuilder {
    const page = new PageBuilder(Math.max(1, width), Math.max(1, height));
    this.pages.push(page);
    return page;
  }

  /** Makes sure a font is written when the file is saved. */
  useFont(font: EmbeddedFont): void {
    this.fonts.add(font);
  }

  async embedImage(bytes: Uint8Array, format: "png" | "jpeg"): Promise<EmbeddedImage> {
    let image: PDFImage;
    try {
      image = format === "png" ? await this.doc.embedPng(bytes) : await this.doc.embedJpg(bytes);
    } catch (error) {
      throw new AppError("INVALID_FILE", "An image inside the document could not be read.", { details: error instanceof Error ? error.message : String(error), cause: error });
    }
    return { ref: image.ref, width: image.width, height: image.height };
  }

  async save(info: DocumentInfo): Promise<Uint8Array> {
    const { doc } = this;
    const { context } = doc;
    const pdfPages = this.pages.map((page) => doc.addPage([page.width, page.height]));
    this.pages.forEach((page, index) => {
      const pdfPage = pdfPages[index];
      if (!pdfPage) return;
      for (const font of page.fontNames.keys()) this.fonts.add(font);
      const fontDict = context.obj({});
      for (const [font, name] of page.fontNames) fontDict.set(PDFName.of(name), font.finish(doc));
      const xObjects = context.obj({});
      for (const [ref, name] of page.imageNames) xObjects.set(PDFName.of(name), ref);
      const states = context.obj({});
      for (const [key, name] of page.stateNames) states.set(PDFName.of(name), context.obj({ Type: "ExtGState", ca: key / 1000, CA: key / 1000 }));
      pdfPage.node.set(PDFName.of("Resources"), context.obj({ Font: fontDict, XObject: xObjects, ExtGState: states, ProcSet: ["PDF", "Text", "ImageB", "ImageC", "ImageI"] }));
      pdfPage.node.set(PDFName.of("Contents"), context.register(context.flateStream(new TextEncoder().encode(page.ops.join("\n")))));

      if (page.links.length > 0) {
        const annotations = page.links.map((link) => {
          const rect = [link.x, page.height - link.y - link.height, link.x + link.width, page.height - link.y];
          const target = link.target;
          const destination = target.page !== undefined ? pdfPages[target.page] : undefined;
          if (!target.uri && !destination) return null;
          const action = target.uri ? context.obj({ S: "URI", URI: PDFString.of(target.uri) }) : context.obj({ S: "GoTo", D: [destination?.ref as PDFRef, "Fit"] });
          return context.register(context.obj({ Type: "Annot", Subtype: "Link", Rect: rect, Border: [0, 0, 0], A: action }));
        });
        const refs = annotations.filter((ref): ref is PDFRef => ref !== null);
        if (refs.length > 0) pdfPage.node.set(PDFName.of("Annots"), context.obj(refs));
      }
    });
    if (info.title) doc.setTitle(info.title, { showInWindowTitleBar: true });
    if (info.author) doc.setAuthor(info.author);
    if (info.subject) doc.setSubject(info.subject);
    if (info.keywords) doc.setKeywords(info.keywords.split(/[;,]\s*/));
    doc.setCreator(info.creator ?? "LanternPDF");
    doc.setProducer(info.producer ?? "LanternPDF");
    doc.setCreationDate(new Date());
    doc.setModificationDate(new Date());
    return doc.save({ useObjectStreams: true });
  }
}

export { PDFHexString };
