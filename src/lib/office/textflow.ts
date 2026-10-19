/**
 * Lays out rich text: turns styled runs into lines and draws them.
 *
 * Shared by the Word, Excel and PowerPoint converters. A paragraph becomes a list of atoms (words, spaces, tabs, breaks,
 * images); atoms are broken into lines that fit a width (with tab stops, hanging indents and justification); and lines
 * are drawn with the exact positions that were measured, so what is measured is what is drawn.
 */
import { type FamilyId, type FontLibrary, type SymbolKind, cleanChar, symbolToUnicode } from "./fontLibrary";
import type { EmbeddedFont, EmbeddedImage, LinkTarget, PageBuilder } from "./pdfBuilder";

export type UnderlineStyle = "single" | "double" | "dotted" | "dash" | "wave" | "thick";

export interface TextStyle {
  family: FamilyId;
  bold: boolean;
  italic: boolean;
  /** Font size in points. */
  size: number;
  color: string;
  underline?: UnderlineStyle;
  underlineColor?: string;
  strike?: boolean;
  doubleStrike?: boolean;
  /** Colour painted behind the text (highlighter or shading). */
  background?: string;
  caps?: boolean;
  smallCaps?: boolean;
  script?: "super" | "sub";
  /** Extra space after every character, in points. */
  spacing?: number;
  /** Raise (positive) or lower (negative) the text by this many points. */
  rise?: number;
  link?: LinkRef;
  /** The text came from a symbol font (Symbol, Wingdings): its private-use characters are mapped to real symbols. */
  symbol?: boolean;
  symbolKind?: SymbolKind;
}

export interface LinkRef extends LinkTarget {
  /** A named place in the document (Word bookmark); turned into a page link once pages are known. */
  anchor?: string;
}

export interface Piece {
  font: EmbeddedFont;
  text: string;
  width: number;
  size: number;
  rise: number;
}

export interface FontMetrics {
  ascent: number;
  descent: number;
}

export interface WordAtom {
  kind: "word";
  pieces: Piece[];
  width: number;
  style: TextStyle;
  /** A line may break right after this atom (it ends in a hyphen). */
  breakAfter: boolean;
  ascent: number;
  descent: number;
}

export interface SpaceAtom {
  kind: "space";
  width: number;
  style: TextStyle;
  ascent: number;
  descent: number;
}

export interface TabAtom {
  kind: "tab";
  style: TextStyle;
  width: number;
  ascent: number;
  descent: number;
}

export interface BreakAtom {
  kind: "break";
  type: "line" | "page" | "column";
  style: TextStyle;
  ascent: number;
  descent: number;
  width: 0;
}

export interface ImageAtom {
  kind: "image";
  image: EmbeddedImage;
  width: number;
  height: number;
  /** Lifts the picture above the baseline. */
  rise: number;
  link?: LinkRef;
  style: TextStyle;
  ascent: number;
  descent: number;
  /** Cropping as fractions of the picture removed from each side. */
  crop?: { left: number; top: number; right: number; bottom: number };
}

/** A value that is only known after pages are laid out: a page number. */
export interface FieldAtom {
  kind: "field";
  field: "page" | "pages";
  style: TextStyle;
  /** Width reserved for the number (digits of the likely value). */
  width: number;
  ascent: number;
  descent: number;
}

export type Atom = WordAtom | SpaceAtom | TabAtom | BreakAtom | ImageAtom | FieldAtom;

export type InlineItem =
  | { kind: "text"; text: string; style: TextStyle }
  | { kind: "tab"; style: TextStyle }
  | { kind: "break"; type: "line" | "page" | "column"; style: TextStyle }
  | { kind: "image"; image: EmbeddedImage; width: number; height: number; rise?: number; link?: LinkRef; style: TextStyle; crop?: ImageAtom["crop"] }
  | { kind: "field"; field: "page" | "pages"; style: TextStyle };

export interface TabStop {
  /** Distance from the left edge of the text area, in points. */
  position: number;
  align: "left" | "center" | "right" | "decimal";
  leader?: "dot" | "hyphen" | "underscore" | "middleDot";
}

export type Align = "left" | "center" | "right" | "justify" | "distribute";

export interface PlacedAtom {
  atom: Atom;
  /** Distance from the paragraph's left edge. */
  x: number;
  width: number;
  /** For tabs: the leader character drawn across the gap. */
  leader?: TabStop["leader"];
}

export interface Line {
  atoms: PlacedAtom[];
  /** Height of the line box in points. */
  height: number;
  /** Distance from the top of the line box to the baseline. */
  baseline: number;
  /** Width of the content (without trailing spaces). */
  width: number;
  /** The line was ended by a break the author typed, not because it ran out of room. */
  hardEnd: boolean;
  /** Everything after this line goes on the next page (a page or column break). */
  pageBreakAfter: boolean;
}

export interface ParagraphShape {
  /** Width available for text, after the paragraph's own indents. */
  width: number;
  /** Where the first line starts, relative to the left edge; negative for a hanging indent. */
  firstLineOffset: number;
  /** Distance of the paragraph's left edge from the text area's left edge (tab positions are measured from the latter). */
  leftIndent: number;
  align: Align;
  tabs: readonly TabStop[];
  defaultTabStop: number;
  lineRule: "auto" | "exact" | "atLeast";
  /** A multiplier for "auto"; points for "exact" and "atLeast". */
  lineValue: number;
  /** Style whose height an empty line takes (the paragraph mark). */
  markStyle: TextStyle;
}

// ---- shaping -------------------------------------------------------------------------------------------

export class TextShaper {
  readonly warnings: { unsupported: Set<number> } = { unsupported: new Set() };
  /** While laying out a header or footer for one page: the numbers its fields will show, so their widths are exact. */
  fieldValues?: { page: number; pages: number };

  constructor(readonly fonts: FontLibrary) {}

  /** Ascent and descent of a style's font, in points. */
  metrics(style: TextStyle): FontMetrics {
    const font = this.fonts.base(style);
    const factor = this.effectiveSize(style) / font.ttf.unitsPerEm;
    return { ascent: font.ttf.ascent * factor, descent: font.ttf.descent * factor };
  }

  effectiveSize(style: TextStyle): number {
    return style.script ? style.size * 0.65 : style.size;
  }

  rise(style: TextStyle): number {
    if (style.script === "super") return style.size * 0.34 + (style.rise ?? 0);
    if (style.script === "sub") return -style.size * 0.12 + (style.rise ?? 0);
    return style.rise ?? 0;
  }

  /** The drawing pieces for `text`: consecutive characters drawn with the same font and size. */
  shape(text: string, style: TextStyle): Piece[] {
    const pieces: Piece[] = [];
    const baseSize = this.effectiveSize(style);
    const rise = this.rise(style);
    const spacing = style.spacing ?? 0;
    const push = (font: EmbeddedFont, char: string, size: number) => {
      const last = pieces[pieces.length - 1];
      const width = font.width(char, size) + spacing;
      if (last && last.font === font && last.size === size) {
        last.text += char;
        last.width += width;
      } else {
        pieces.push({ font, text: char, width, size, rise });
      }
    };
    const source = style.caps ? text.toUpperCase() : text;
    for (const original of source) {
      let code = original.codePointAt(0) as number;
      if (style.symbol) code = symbolToUnicode(code, style.symbolKind);
      const cleaned = cleanChar(code);
      if (cleaned === null) continue;
      let size = baseSize;
      let char = String.fromCodePoint(cleaned);
      if (style.smallCaps && !style.caps && char !== char.toUpperCase()) {
        char = char.toUpperCase();
        size = baseSize * 0.8;
      }
      const request = { family: style.family, bold: style.bold, italic: style.italic };
      const font = this.fonts.pick(request, char.codePointAt(0) as number);
      if (font) {
        push(font, char, size);
      } else {
        this.warnings.unsupported.add(char.codePointAt(0) as number);
        push(this.fonts.base(request), "?", size);
      }
    }
    return pieces;
  }

  width(text: string, style: TextStyle): number {
    let total = 0;
    for (const piece of this.shape(text, style)) total += piece.width;
    return total;
  }
}

// ---- atoms ---------------------------------------------------------------------------------------------

/** Words, spaces, tabs, breaks and images from the runs of a paragraph. */
export function buildAtoms(items: readonly InlineItem[], shaper: TextShaper): Atom[] {
  const atoms: Atom[] = [];
  let word: WordAtom | null = null;

  const flush = (breakAfter = false) => {
    if (word && word.pieces.length > 0) {
      word.breakAfter = breakAfter;
      atoms.push(word);
    }
    word = null;
  };

  const addToWord = (text: string, style: TextStyle) => {
    if (text === "") return;
    const pieces = shaper.shape(text, style);
    if (pieces.length === 0) return;
    const metrics = shaper.metrics(style);
    if (!word) word = { kind: "word", pieces: [], width: 0, style, breakAfter: false, ascent: metrics.ascent, descent: metrics.descent };
    for (const piece of pieces) {
      word.pieces.push(piece);
      word.width += piece.width;
    }
    word.ascent = Math.max(word.ascent, metrics.ascent);
    word.descent = Math.max(word.descent, metrics.descent);
  };

  for (const item of items) {
    if (item.kind === "text") {
      let run = "";
      const chars = [...item.text];
      for (let i = 0; i < chars.length; i += 1) {
        const char = chars[i] as string;
        if (char === " " || char === " " || char === " " || char === " " || char === " " || char === " " || char === " ") {
          addToWord(run, item.style);
          run = "";
          // A non-breaking space is part of the word it joins; an ordinary space is a break opportunity.
          if (char === " " || char === " " || char === " ") {
            flush();
            const metrics = shaper.metrics(item.style);
            const spaceWidth = shaper.width(" ", item.style) * (char === " " ? 1 : char === " " ? 1 : 2);
            const last = atoms[atoms.length - 1];
            if (last && last.kind === "space" && last.style === item.style) last.width += spaceWidth;
            else atoms.push({ kind: "space", width: spaceWidth, style: item.style, ascent: metrics.ascent, descent: metrics.descent });
          } else {
            addToWord(" ", item.style);
          }
        } else if (char === "-" && run !== "" && i + 1 < chars.length && !/\s/.test(chars[i + 1] as string)) {
          run += char;
          addToWord(run, item.style);
          run = "";
          flush(true);
        } else if (char === "–" || char === "—") {
          run += char;
          if (i + 1 < chars.length && !/\s/.test(chars[i + 1] as string)) {
            addToWord(run, item.style);
            run = "";
            flush(true);
          }
        } else {
          run += char;
        }
      }
      addToWord(run, item.style);
    } else if (item.kind === "tab") {
      flush();
      const metrics = shaper.metrics(item.style);
      atoms.push({ kind: "tab", style: item.style, width: 0, ascent: metrics.ascent, descent: metrics.descent });
    } else if (item.kind === "break") {
      flush();
      const metrics = shaper.metrics(item.style);
      atoms.push({ kind: "break", type: item.type, style: item.style, ascent: metrics.ascent, descent: metrics.descent, width: 0 });
    } else if (item.kind === "image") {
      flush();
      const metrics = shaper.metrics(item.style);
      const rise = item.rise ?? 0;
      atoms.push({
        kind: "image",
        image: item.image,
        width: item.width,
        height: item.height,
        rise,
        link: item.link,
        style: item.style,
        ascent: Math.max(item.height + rise, metrics.ascent),
        descent: metrics.descent,
        crop: item.crop,
      });
    } else {
      flush();
      const metrics = shaper.metrics(item.style);
      const shown = shaper.fieldValues ? String(item.field === "page" ? shaper.fieldValues.page : shaper.fieldValues.pages) : "00";
      atoms.push({ kind: "field", field: item.field, style: item.style, width: shaper.width(shown, item.style), ascent: metrics.ascent, descent: metrics.descent });
    }
  }
  flush();
  return atoms;
}

// ---- line breaking -------------------------------------------------------------------------------------

const EPSILON = 0.01;

interface OpenLine {
  atoms: PlacedAtom[];
  x: number;
  contentEnd: number;
  ascent: number;
  descent: number;
  first: boolean;
}

/** Splits a word that is wider than a whole line into pieces that fit. */
function splitWord(word: WordAtom, maxWidth: number, shaper: TextShaper): WordAtom[] {
  const parts: WordAtom[] = [];
  let current: WordAtom = { ...word, pieces: [], width: 0, breakAfter: true };
  for (const piece of word.pieces) {
    for (const char of piece.text) {
      const width = piece.font.width(char, piece.size) + (word.style.spacing ?? 0);
      if (current.width + width > maxWidth && current.pieces.length > 0) {
        parts.push(current);
        current = { ...word, pieces: [], width: 0, breakAfter: true };
      }
      const last = current.pieces[current.pieces.length - 1];
      if (last && last.font === piece.font && last.size === piece.size) {
        last.text += char;
        last.width += width;
      } else {
        current.pieces.push({ ...piece, text: char, width });
      }
      current.width += width;
    }
  }
  void shaper;
  current.breakAfter = word.breakAfter;
  parts.push(current);
  return parts;
}

/** Breaks atoms into lines for one paragraph. */
export function breakLines(atoms: readonly Atom[], shape: ParagraphShape, shaper: TextShaper): Line[] {
  const lines: Line[] = [];
  const markMetrics = shaper.metrics(shape.markStyle);
  let open: OpenLine = { atoms: [], x: shape.firstLineOffset, contentEnd: shape.firstLineOffset, ascent: 0, descent: 0, first: true };
  let pendingSpace: { atom: SpaceAtom; x: number }[] = [];
  const customStops = [...shape.tabs].sort((a, b) => a.position - b.position);

  const nextTabStop = (x: number): { stop: number; align: TabStop["align"]; leader?: TabStop["leader"] } => {
    const absolute = x + shape.leftIndent;
    for (const stop of customStops) if (stop.position > absolute + EPSILON) return { stop: stop.position - shape.leftIndent, align: stop.align, leader: stop.leader };
    // Word also stops at the hanging indent, so "1.<tab>Text" lines up with the text below it.
    if (open.first && shape.firstLineOffset < 0 && x < -EPSILON) return { stop: 0, align: "left" };
    const step = shape.defaultTabStop > 0 ? shape.defaultTabStop : 36;
    const lastCustom = customStops.length > 0 ? (customStops[customStops.length - 1] as TabStop).position : 0;
    let candidate = Math.floor(absolute / step + EPSILON) * step + step;
    if (candidate <= lastCustom) candidate = Math.floor(lastCustom / step + 1) * step;
    return { stop: candidate - shape.leftIndent, align: "left" };
  };

  const closeLine = (hardEnd: boolean, pageBreakAfter: boolean) => {
    // Trailing spaces hang in the margin and are not part of the line.
    pendingSpace = [];
    const finished = finishLine(open, shape, markMetrics, hardEnd, pageBreakAfter);
    lines.push(finished);
    open = { atoms: [], x: 0, contentEnd: 0, ascent: 0, descent: 0, first: false };
  };

  const place = (atom: Atom, width: number, leader?: TabStop["leader"]) => {
    open.atoms.push({ atom, x: open.x, width, leader });
    open.x += width;
    open.contentEnd = open.x;
    open.ascent = Math.max(open.ascent, atom.ascent);
    open.descent = Math.max(open.descent, atom.descent);
  };

  const limit = shape.width;
  for (const atom of atoms) {
    if (atom.kind === "break") {
      open.ascent = Math.max(open.ascent, atom.ascent);
      open.descent = Math.max(open.descent, atom.descent);
      closeLine(true, atom.type !== "line");
      continue;
    }
    if (atom.kind === "space") {
      pendingSpace.push({ atom, x: open.x });
      open.x += atom.width;
      continue;
    }
    if (atom.kind === "tab") {
      for (const held of pendingSpace) place(held.atom, held.atom.width);
      pendingSpace = [];
      const target = nextTabStop(open.x);
      // Only a left tab takes its whole gap now; for right, centre and decimal tabs the gap depends on the text after the tab,
      // which is worked out when the line is finished.
      const width = target.align === "left" ? Math.max(0, target.stop - open.x) : 0;
      if (open.x + width > limit + EPSILON && open.atoms.length > 0) {
        // The next stop is beyond the right edge: the tab wraps like a word would.
        closeLine(false, false);
        continue;
      }
      place(atom, width, target.leader);
      (open.atoms[open.atoms.length - 1] as PlacedAtom & { tabAlign?: TabStop["align"]; tabStop?: number }).tabAlign = target.align;
      (open.atoms[open.atoms.length - 1] as PlacedAtom & { tabAlign?: TabStop["align"]; tabStop?: number }).tabStop = target.stop;
      continue;
    }

    const width = atom.width;
    const spaceWidth = pendingSpace.reduce((sum, held) => sum + held.atom.width, 0);
    const fits = open.x + spaceWidth + width <= limit + EPSILON;
    if (!fits && open.atoms.length > 0) {
      // Does the previous atom allow a break right here (it ended with a hyphen) or do spaces separate them?
      closeLine(false, false);
      open.x = 0;
      open.contentEnd = 0;
    }
    if (open.atoms.length > 0 || open.first === false) {
      // Still on a line that has content: bring the held spaces in.
      for (const held of pendingSpace) place(held.atom, held.atom.width);
    } else {
      for (const held of pendingSpace) place(held.atom, held.atom.width);
    }
    pendingSpace = [];

    if (atom.kind === "word" && atom.width > limit - open.x + EPSILON && limit > 10) {
      const parts = splitWord(atom, Math.max(limit - open.x, limit), shaper);
      parts.forEach((part, index) => {
        if (index > 0) closeLine(false, false);
        if (part.width > limit - open.x + EPSILON && open.atoms.length > 0) closeLine(false, false);
        place(part, part.width);
      });
    } else {
      place(atom, width);
    }
  }
  // The last line of a paragraph is not stretched when the paragraph is justified.
  closeLine(true, false);
  void markMetrics;
  return lines;
}

/** Fixes tab gaps, aligns the line, spreads justified spaces and works out its height. */
function finishLine(open: OpenLine, shape: ParagraphShape, markMetrics: FontMetrics, hardEnd: boolean, pageBreakAfter: boolean): Line {
  let atoms = open.atoms;
  // An empty line is as tall as the paragraph mark.
  let ascent = open.ascent;
  let descent = open.descent;
  if (atoms.length === 0) {
    ascent = markMetrics.ascent;
    descent = markMetrics.descent;
  }

  // Right, centre and decimal tabs: the gap before the text depends on how wide the text after it is.
  const start = open.first ? shape.firstLineOffset : 0;
  let cursor = start;
  const placed: PlacedAtom[] = [];
  for (let index = 0; index < atoms.length; index += 1) {
    const item = atoms[index] as PlacedAtom & { tabAlign?: TabStop["align"]; tabStop?: number };
    if (item.atom.kind === "tab" && item.tabStop !== undefined) {
      let following = 0;
      for (let j = index + 1; j < atoms.length; j += 1) {
        const next = atoms[j] as PlacedAtom;
        if (next.atom.kind === "tab") break;
        following += next.width;
      }
      let gap = item.tabStop - cursor;
      if (item.tabAlign === "right") gap = item.tabStop - cursor - following;
      else if (item.tabAlign === "center") gap = item.tabStop - cursor - following / 2;
      else if (item.tabAlign === "decimal") gap = item.tabStop - cursor - following / 2;
      gap = Math.max(gap, 0);
      placed.push({ atom: item.atom, x: cursor, width: gap, leader: item.leader });
      cursor += gap;
    } else {
      placed.push({ atom: item.atom, x: cursor, width: item.width, leader: item.leader });
      cursor += item.width;
    }
  }
  atoms = placed;
  const contentWidth = cursor - start;

  // Alignment of the whole line inside the paragraph's width.
  let offset = 0;
  const free = shape.width - cursor;
  const align = shape.align;
  if (align === "center") offset = free / 2;
  else if (align === "right") offset = free;
  if (offset !== 0 && atoms.length > 0) atoms = atoms.map((item) => ({ ...item, x: item.x + offset }));

  const justify = (align === "justify" && !hardEnd) || align === "distribute";
  if (justify && atoms.length > 0) {
    const gaps = atoms.filter((item) => item.atom.kind === "space").length;
    const extra = shape.width - cursor;
    // Lines that are nearly full are spread; very short lines (the last line of a paragraph) are not stretched.
    const isLast = false;
    if (gaps > 0 && extra > 0 && !isLast) {
      const per = extra / gaps;
      let shift = 0;
      atoms = atoms.map((item) => {
        const moved = { ...item, x: item.x + shift };
        if (item.atom.kind === "space") {
          moved.width = item.width + per;
          shift += per;
        }
        return moved;
      });
    }
  }

  // Height of the line box under the paragraph's line-spacing rule. Extra room goes above the text, as Word does.
  const natural = ascent + descent;
  const height = shape.lineRule === "auto" ? natural * shape.lineValue : shape.lineRule === "exact" ? shape.lineValue : Math.max(natural, shape.lineValue);
  const squeeze = natural > 0 && height < natural ? height / natural : 1;
  const baseline = height - descent * squeeze;
  return { atoms, height, baseline, width: contentWidth, hardEnd, pageBreakAfter };
}

// ---- drawing -------------------------------------------------------------------------------------------

export interface DrawContext {
  page: PageBuilder;
  shaper: TextShaper;
  /** Page index of a named place in the document, for internal links. */
  resolveAnchor?: (name: string) => number | undefined;
  /** Page numbers for fields. */
  pageNumber: number;
  pageCount: number;
}

/** Draws one line with its top-left corner at (x, top). */
export function drawLine(ctx: DrawContext, line: Line, x: number, top: number): void {
  const { page, shaper } = ctx;
  const baseline = top + line.baseline;
  // Trailing white space never carries a visible background.
  const lastVisible = (() => {
    for (let i = line.atoms.length - 1; i >= 0; i -= 1) if ((line.atoms[i] as PlacedAtom).atom.kind !== "space") return i;
    return -1;
  })();
  line.atoms.forEach((placed, index) => {
    const { atom } = placed;
    const left = x + placed.x;
    if (atom.kind === "tab") {
      if (placed.leader && placed.width > 4) drawLeader(ctx, atom.style, left, baseline, placed.width, placed.leader);
      return;
    }
    if (atom.kind === "break") return;
    if (atom.kind === "image") {
      const bottom = baseline - atom.rise;
      drawPicture(page, atom.image, left, bottom - atom.height, atom.width, atom.height, atom.crop);
      const target = linkTarget(ctx, atom.link);
      if (target) page.link(left, bottom - atom.height, atom.width, atom.height, target);
      return;
    }
    const style = atom.style;
    const metrics = shaper.metrics(style);
    const rise = shaper.rise(style);
    if (style.background && (atom.kind !== "space" || index < lastVisible)) {
      page.fillRect(left, baseline - rise - metrics.ascent, placed.width, metrics.ascent + metrics.descent, style.background);
    }
    if (atom.kind === "space") {
      if (index < lastVisible) decorate(ctx, style, left, baseline - rise, placed.width);
      return;
    }
    if (atom.kind === "field") {
      const text = String(atom.field === "page" ? ctx.pageNumber : ctx.pageCount);
      const width = shaper.width(text, style);
      drawRun(ctx, style, left, baseline, text);
      decorate(ctx, style, left, baseline - rise, width);
      return;
    }
    let cursor = left;
    for (const piece of atom.pieces) {
      page.text(piece.font, piece.size, cursor, baseline - piece.rise, piece.text, style.color, { charSpacing: style.spacing });
      cursor += piece.width;
    }
    decorate(ctx, style, left, baseline - rise, atom.width);
    const target = linkTarget(ctx, style.link);
    if (target) page.link(left, baseline - rise - metrics.ascent, atom.width, metrics.ascent + metrics.descent, target);
  });
}

function linkTarget(ctx: DrawContext, link: LinkRef | undefined): LinkTarget | undefined {
  if (!link) return undefined;
  if (link.uri) return { uri: link.uri };
  if (link.anchor) {
    const page = ctx.resolveAnchor?.(link.anchor);
    return page === undefined ? undefined : { page };
  }
  return link.page === undefined ? undefined : { page: link.page };
}

/** An image in a box; when it is cropped, the whole picture is drawn larger and cut off at the box. */
export function drawPicture(page: PageBuilder, image: EmbeddedImage, x: number, y: number, width: number, height: number, crop?: { left: number; top: number; right: number; bottom: number }): void {
  if (!crop || (crop.left === 0 && crop.top === 0 && crop.right === 0 && crop.bottom === 0)) {
    page.image(image, x, y, width, height);
    return;
  }
  const visibleWidth = Math.max(0.05, 1 - crop.left - crop.right);
  const visibleHeight = Math.max(0.05, 1 - crop.top - crop.bottom);
  const fullWidth = width / visibleWidth;
  const fullHeight = height / visibleHeight;
  page.save();
  page.clipRect(x, y, width, height);
  page.image(image, x - crop.left * fullWidth, y - crop.top * fullHeight, fullWidth, fullHeight);
  page.restore();
}

function drawRun(ctx: DrawContext, style: TextStyle, x: number, baseline: number, text: string): void {
  let cursor = x;
  for (const piece of ctx.shaper.shape(text, style)) {
    ctx.page.text(piece.font, piece.size, cursor, baseline - piece.rise, piece.text, style.color, { charSpacing: style.spacing });
    cursor += piece.width;
  }
}

function drawLeader(ctx: DrawContext, style: TextStyle, x: number, baseline: number, width: number, leader: NonNullable<TabStop["leader"]>): void {
  const glyph = leader === "dot" ? "." : leader === "hyphen" ? "-" : leader === "underscore" ? "_" : "·";
  const unit = ctx.shaper.width(glyph, style);
  if (unit <= 0) return;
  const count = Math.floor((width - 2) / (unit * (leader === "dot" ? 1.6 : 1)));
  const step = count > 0 ? (width - 2) / count : unit;
  for (let i = 0; i < count; i += 1) drawRun(ctx, style, x + 1 + i * step + (step - unit) / 2, baseline, glyph);
}

/** Underline and strike-through for a stretch of text. */
function decorate(ctx: DrawContext, style: TextStyle, x: number, baseline: number, width: number): void {
  if (width <= 0) return;
  const size = style.script ? style.size * 0.65 : style.size;
  const thickness = Math.max(0.5, size * 0.055);
  const color = style.underlineColor ?? style.color;
  if (style.underline) {
    const y = baseline + size * 0.12;
    const stroke = { color, width: style.underline === "thick" ? thickness * 2 : thickness };
    if (style.underline === "double") {
      ctx.page.line(x, y, x + width, y, stroke);
      ctx.page.line(x, y + thickness * 2.2, x + width, y + thickness * 2.2, stroke);
    } else if (style.underline === "dotted") {
      ctx.page.line(x, y, x + width, y, { ...stroke, dash: [thickness, thickness * 1.5] });
    } else if (style.underline === "dash") {
      ctx.page.line(x, y, x + width, y, { ...stroke, dash: [thickness * 4, thickness * 2] });
    } else if (style.underline === "wave") {
      const amplitude = thickness * 1.2;
      const step = thickness * 3;
      let d = ctx.page.pathOps.move(x, y);
      for (let px = x; px < x + width; px += step * 2) d += ` ${ctx.page.pathOps.curve(px + step / 2, y - amplitude, px + step * 1.5, y + amplitude, Math.min(px + step * 2, x + width), y)}`;
      ctx.page.path(d, { stroke });
    } else {
      ctx.page.line(x, y, x + width, y, stroke);
    }
  }
  if (style.strike || style.doubleStrike) {
    const y = baseline - size * 0.28;
    ctx.page.line(x, y, x + width, y, { color: style.color, width: thickness });
    if (style.doubleStrike) ctx.page.line(x, y - thickness * 2, x + width, y - thickness * 2, { color: style.color, width: thickness });
  }
}

/** Total height of a paragraph's lines. */
export function linesHeight(lines: readonly Line[]): number {
  let total = 0;
  for (const line of lines) total += line.height;
  return total;
}
