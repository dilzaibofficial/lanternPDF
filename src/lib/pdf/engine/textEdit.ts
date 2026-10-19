import { PDFDict, type PDFDocument, PDFName, type PDFFont, PDFRef, type PDFStream } from "@cantoo/pdf-lib";
import { AppError } from "../../errors";
import { frameOf } from "../draw";
import { type FontChoice, resolveFont } from "../fonts";
import { engineContext, ensureScanned } from "./context";
import { diffLine } from "./diff";
import type { GlyphCode } from "./fonts/fontModel";
import { type TextRun, interpret } from "./interpret";
import { type LineChar, type Segment, type TextLine, buildLines, freeSpaceRight } from "./lines";
import { planLineDelete, planLineMove } from "./lineObjects";
import { IDENTITY, type Matrix, type Rect, applyVector, multiply, translation } from "./matrix";
import { type ObjectEdit, type ObjectOutcome, applyAnnotationChanges, planObjectEdits, withoutXObjects } from "./objects";
import { type Splice, applySplices, dropConflicts } from "./splice";
import { displayToUserMatrix } from "./space";
import { pageResources, parseSource, readPageContent, writeFormCopy, writePageContent } from "./streams";
import type { ContentSource } from "./streams";
import { formatName, formatNumber, parseContentStream } from "./tokenizer";

/**
 * Edits existing text by rewriting the text-showing operators that drew it.
 *
 * What happens to a request, in order:
 *  1. The page is read with the interpreter and grouped into lines (see `lines.ts`).
 *  2. The new text is compared with the old; only the glyphs that differ are replaced.
 *  3. Each new character is encoded with the line's own font when that font really contains it ("A": the
 *     font's codes are written, so the text mapping stays intact). Characters the font cannot draw are drawn in a
 *     fallback font in the same place ("B").
 *  4. Every segment that changed is laid out again glyph by glyph: kept glyphs return to their original
 *     positions (so kerning and justification survive), and what follows an edit moves with it, as typing does.
 *  5. The content stream is written back, the page is read again, and each edit is checked to say what was asked.
 *
 * The old glyph codes are gone from the stream, not covered. Nothing else on the page is touched.
 */

export interface LineStyle {
  family?: FontChoice["family"];
  bold?: boolean;
  italic?: boolean;
  /** Font size in text-space units (the size used by `Tf`). */
  size?: number;
  /** Which part of the line stays where it is when the width changes. */
  align?: "left" | "center" | "right";
}

export type FitMode = "none" | "condense" | "shrink";

export interface LineEditRequest {
  lineId: string;
  text: string;
  style?: LineStyle;
  /** What to do when the new text is wider than the old: nothing (it grows), squeeze it with horizontal scaling, or shrink the type. */
  fit?: FitMode;
}

export interface EditOptions {
  /** Edit text inside a form XObject that the page draws more than once (it is copied for this page, so every use here changes). */
  allowRepeatedForms?: boolean;
  /** Moves, removals and reordering of lines of text, images, shapes and annotations, planned from the same reading of the page. */
  objects?: readonly ObjectEdit[];
}

export type EditStatus = "applied" | "unchanged" | "refused";

export interface EditOutcome {
  lineId: string;
  status: EditStatus;
  /** A: written with the line's own font. B: partly or wholly written with another font. */
  mode?: "A" | "B";
  /** Why a request was refused. */
  reason?: string;
  notes: string[];
  warnings: string[];
  /** Characters drawn with another font. */
  fallbackChars: string;
  fallbackFont?: string;
  /** Width of the line in the drawing space, before and after. */
  widthBefore: number;
  widthAfter: number;
  /** The line's new bounding box in the space its stream draws in. */
  box?: Rect;
  /** The page was read again after the edit and the line says what was asked. */
  verified: boolean;
}

export interface EditReport {
  outcomes: EditOutcome[];
  /** What became of each object edit. */
  objects: ObjectOutcome[];
  /** True when at least one edit changed the page. */
  changed: boolean;
}

interface FallbackFont {
  name: string;
  label: string;
  font: PDFFont;
  singleByte: boolean;
}

/** One thing to show, in order: font codes, a pen movement (TJ units), or text in another font. */
type Item = { t: "codes"; codes: GlyphCode[] } | { t: "adj"; value: number } | { t: "fallback"; text: string; fallback: FallbackFont };

const refuse = (lineId: string, reason: string, line?: TextLine): EditOutcome => ({
  lineId,
  status: "refused",
  reason,
  notes: [],
  warnings: [],
  fallbackChars: "",
  widthBefore: line ? line.advance * line.scale : 0,
  widthAfter: line ? line.advance * line.scale : 0,
  verified: false,
});

// ---- reasons a line cannot be edited --------------------------------------------------------------------------

/** Why this line cannot be edited, or `null` when it can. Used by the analysis too. */
export function whyNotEditable(line: TextLine): string | null {
  for (const run of line.runs) {
    if (run.font.readOnlyReason) return run.font.readOnlyReason;
    if (run.renderMode === 3) return "This text is invisible (a hidden text layer, as scanned pages carry after OCR), so changing it would not change what the page shows.";
    if (run.renderMode >= 4) return "This text is used as a clipping shape, not as visible letters.";
    if (run.font.vertical) return "Vertical text is not supported.";
    if (run.actualText !== null) return "This text carries a replacement text for accessibility (ActualText) that an edit would leave out of date.";
    if (run.elements.some((e) => e.kind === "str" && e.glyphs.some((g) => g.text === ""))) return "Some of its letters have no text mapping in the font, so the editor cannot tell what they say.";
    if (run.source.unreadable > 0 || run.source.tooLarge) return "Its content could not be read completely.";
  }
  return null;
}

// ---- fallback fonts -------------------------------------------------------------------------------------------

function fontNameIn(resources: PDFDict, ref: PDFRef): string {
  let fonts = resources.lookupMaybe(PDFName.of("Font"), PDFDict);
  if (!fonts) {
    fonts = resources.context.obj({});
    resources.set(PDFName.of("Font"), fonts);
  }
  for (const [name, value] of fonts.entries()) if (value instanceof PDFRef && value.toString() === ref.toString()) return name.decodeText();
  let index = 1;
  while (fonts.has(PDFName.of(`LanternF${index}`))) index += 1;
  const name = `LanternF${index}`;
  fonts.set(PDFName.of(name), ref);
  return name;
}

async function fallbackFor(doc: PDFDocument, source: ContentSource, run: TextRun, text: string, style: LineStyle | undefined): Promise<FallbackFont> {
  const family = style?.family ?? (run.font.family === "symbol" ? "sans" : run.font.family);
  const choice: FontChoice = { family, bold: style?.bold ?? run.font.bold, italic: style?.italic ?? run.font.italic };
  const font = await resolveFont(doc, choice, text);
  const resources = source.resources;
  if (!resources) throw new AppError("ENGINE_FAILED", "The page has no resources to add a font to.");
  const name = fontNameIn(resources, font.ref);
  const isStandard = font.name.startsWith("Helvetica") || font.name.startsWith("Times") || font.name.startsWith("Courier");
  return { name, label: font.name.replace(/^[A-Z]{6}\+/, ""), font, singleByte: isStandard };
}

// ---- measuring ------------------------------------------------------------------------------------------------

function advanceOfCode(run: TextRun, code: GlyphCode): number {
  return ((run.font.widthOf(code.code) / 1000) * run.fontSize + run.charSpacing + (run.font.isWordSpace(code) ? run.wordSpacing : 0)) * run.hScale;
}

/** How far the pen moves for an item, in text space. */
function itemAdvance(run: TextRun, item: Item): number {
  switch (item.t) {
    case "codes":
      return item.codes.reduce((sum, code) => sum + advanceOfCode(run, code), 0);
    case "adj":
      return (-item.value / 1000) * run.fontSize * run.hScale;
    case "fallback": {
      let total = 0;
      for (const ch of item.text) {
        const width = item.fallback.font.widthOfTextAtSize(ch, run.fontSize);
        total += (width + run.charSpacing + (item.fallback.singleByte && ch === " " ? run.wordSpacing : 0)) * run.hScale;
      }
      return total;
    }
  }
}

/** Width of a space, in em, for a font that has no space glyph to measure. */
const SPACE_EM: Record<string, number> = { sans: 0.278, serif: 0.25, mono: 0.6, symbol: 0.25 };

interface Encoded {
  items: Item[];
  fallbackChars: string[];
  fallbackLabel?: string;
}

/** Encodes the new characters: with the run's font where it can draw them, in a fallback font otherwise. */
async function encodeInsertion(doc: PDFDocument, run: TextRun, insert: readonly string[], style: LineStyle | undefined, forceFallback: boolean): Promise<Encoded> {
  const items: Item[] = [];
  const fallbackChars: string[] = [];
  let fallbackLabel: string | undefined;
  for (const ch of insert) {
    const code = forceFallback ? null : run.font.encodeChar(ch);
    if (code) {
      items.push({ t: "codes", codes: [code] });
      continue;
    }
    const isSpace = ch === " " || ch === " ";
    if (isSpace && !forceFallback) {
      // A space the font has no glyph for is only a gap: move the pen instead of drawing anything.
      items.push({ t: "adj", value: -(SPACE_EM[run.font.family] ?? 0.27) * 1000 });
      continue;
    }
    const fallback = await fallbackFor(doc, run.source, run, ch, style);
    fallbackLabel = fallback.label;
    if (!isSpace) fallbackChars.push(ch);
    items.push({ t: "fallback", text: ch, fallback });
  }
  return { items, fallbackChars, fallbackLabel };
}

// ---- laying a segment out again -----------------------------------------------------------------------------------

interface Layout {
  items: Item[];
  /** Where the pen ends, in text space from the segment's start. */
  penEnd: number;
}

/** The pen position at the end of the segment as it is now; spacing after the last glyph counts only if more text follows. */
const originalPenEnd = (segment: Segment, hasSuccessor: boolean): number => (hasSuccessor ? segment.endX : segment.glyphs.reduce((end, g) => Math.max(end, g.x + g.advance), 0));

/**
 * Lays out the segment with some glyphs removed and `insertion` put before glyph `insertBefore`. Kept glyphs go
 * back to where they were (so kerning and justification survive); the first kept glyph after removed or inserted
 * material continues from the pen instead, so what follows an edit moves with it.
 */
function layoutSegment(
  line: TextLine,
  segmentIndex: number,
  removed: (charIndex: number) => boolean,
  insertion: readonly Item[] | null,
  insertBefore: number,
  insertAfterGap: boolean,
  charOfGlyph: readonly number[],
  gapAfter: ReadonlyMap<number, number>,
  hasSuccessor: boolean,
): Layout {
  const segment = line.segments[segmentIndex] as Segment;
  const run = segment.runs[0] as TextRun;
  const tolerance = 0.002 * run.fontSize * run.hScale;
  const toTj = (adjust: number) => (-adjust * 1000) / (run.fontSize * run.hScale);

  const items: Item[] = [];
  let pen = 0;
  let offset = 0;
  let dirty = false;
  const pushCodes = (code: GlyphCode) => {
    const last = items[items.length - 1];
    if (last?.t === "codes") last.codes.push(code);
    else items.push({ t: "codes", codes: [code] });
  };
  const emitInsertion = () => {
    if (!insertion) return;
    for (const item of insertion) {
      if (item.t === "codes") for (const code of item.codes) pushCodes(code);
      else items.push(item);
      pen += itemAdvance(run, item);
    }
    dirty = true;
  };

  segment.glyphs.forEach((glyph, glyphIndex) => {
    const previous = segment.glyphs[glyphIndex - 1];
    const gapChar = previous ? gapAfter.get(glyphIndex - 1) : undefined;
    const gapKept = gapChar !== undefined && !removed(gapChar);
    const originalGap = gapKept && previous ? glyph.x - (previous.x + previous.advance) : 0;
    let gapSpent = false;

    if (insertion && insertBefore === glyphIndex) {
      if (insertAfterGap && gapKept) {
        // The cursor was after the word gap: the gap stays in front of the new text.
        items.push({ t: "adj", value: toTj(originalGap) });
        pen += originalGap;
        gapSpent = true;
      }
      emitInsertion();
    }
    if (gapChar !== undefined && removed(gapChar)) dirty = true;
    if (removed(charOfGlyph[glyphIndex] as number)) {
      dirty = true;
      return;
    }
    if (dirty) {
      // After removed or new material, carry on from the pen (keeping a word gap that was left in place).
      offset = pen + (gapKept && !gapSpent ? originalGap : 0) - glyph.x;
      dirty = false;
    }
    const target = glyph.x + offset;
    const adjust = target - pen;
    if (Math.abs(adjust) > tolerance) {
      items.push({ t: "adj", value: toTj(adjust) });
      pen = target;
    }
    pushCodes({ code: glyph.code, length: glyph.length });
    pen += glyph.advance;
  });
  if (insertion && insertBefore >= segment.glyphs.length) emitInsertion();
  // Spacing after the last glyph is kept when more text follows on the line (unless that gap was deleted).
  const lastGlyph = segment.glyphs[segment.glyphs.length - 1];
  if (hasSuccessor && lastGlyph) {
    const tail = segment.endX - (lastGlyph.x + lastGlyph.advance);
    const gapChar = gapAfter.get(segment.glyphs.length - 1);
    if (tail > tolerance && !(gapChar !== undefined && removed(gapChar))) {
      items.push({ t: "adj", value: toTj(tail) });
      pen += tail;
    }
  }
  return { items, penEnd: pen };
}

// ---- writing operators ------------------------------------------------------------------------------------------

const hex = (bytes: Uint8Array) => `<${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}>`;
const precise = (value: number) => formatNumber(Math.round(value * 1e6) / 1e6).replace(/^-0$/, "0");

interface RenderOptions {
  /** A leading movement of the pen (TJ units), for alignment. */
  shift: number;
  /** Size to draw at, when it differs from the run's. */
  size?: number;
  /** The line matrix to put back after the text, when the segment moved it. */
  restore: Matrix | null;
}

function renderSegment(first: TextRun, items: readonly Item[], options: RenderOptions): string {
  const parts: string[] = [];
  if (first.operator === "'") parts.push("T*");
  if (first.operator === '"') parts.push(`${formatNumber(first.wordSpacing)} Tw ${formatNumber(first.charSpacing)} Tc T*`);
  const size = options.size ?? first.fontSize;
  const resized = options.size !== undefined && Math.abs(options.size - first.fontSize) > 1e-6;
  if (resized) parts.push(`${formatName(first.fontName)} ${formatNumber(size)} Tf`);
  if (options.shift !== 0) parts.push(`[${formatNumber(options.shift)}] TJ`);

  let pieces: string[] = [];
  let codes: GlyphCode[] = [];
  let hasNumber = false;
  const flushCodes = () => {
    if (codes.length > 0) pieces.push(hex(first.font.toBytes(codes)));
    codes = [];
  };
  const flushArray = () => {
    flushCodes();
    if (pieces.length === 0) return;
    parts.push(hasNumber ? `[${pieces.join(" ")}] TJ` : `${pieces.join("")} Tj`);
    pieces = [];
    hasNumber = false;
  };
  for (const item of items) {
    if (item.t === "codes") {
      codes.push(...item.codes);
    } else if (item.t === "adj") {
      flushCodes();
      pieces.push(formatNumber(item.value));
      hasNumber = true;
    } else {
      flushArray();
      parts.push(`${formatName(item.fallback.name)} ${formatNumber(size)} Tf ${item.fallback.font.encodeText(item.text).toString()} Tj ${formatName(first.fontName)} ${formatNumber(size)} Tf`);
    }
  }
  flushArray();
  if (resized) parts.push(`${formatName(first.fontName)} ${formatNumber(first.fontSize)} Tf`);
  if (options.restore) parts.push(`${options.restore.map(precise).join(" ")} Tm`);
  return parts.join(" ");
}

/** Operators that move the text position or draw text, so what follows a `Tm` may depend on it. */
const DEPENDS_ON_TM = new Set(["Td", "TD", "T*", "'", '"', "Tj", "TJ"]);

/**
 * True when rewriting the `Tm` in front of a piece moves that piece (and what flows from it) and nothing else:
 * after the line's last operation, the text object ends or is repositioned before anything else is drawn.
 */
function tmIsPrivate(line: TextLine, lineEnd: TextRun): boolean {
  const ops = parseSource(lineEnd.source).ops;
  const ownOps = new Set(line.runs.map((r) => r.opIndex));
  for (let i = lineEnd.opIndex + 1; i < ops.length; i += 1) {
    const name = (ops[i] as { op: string }).op;
    if (name === "ET" || name === "Tm" || name === "BT") return true;
    if (DEPENDS_ON_TM.has(name) && !ownOps.has(i)) return false;
  }
  return true;
}

interface Moves {
  moves: Splice[];
  /** True when a later piece of the line could not be moved. */
  unmovable: boolean;
}

/** New `Tm` operators for the pieces of a line that are placed on their own, so they follow the edited text. */
function positionedMoves(line: TextLine, deltas: readonly number[], removed: (index: number) => boolean, alignShift: number): Moves {
  const out: Moves = { moves: [], unmovable: false };
  const lineEnd = line.runs[line.runs.length - 1] as TextRun;
  let running = alignShift;
  line.segments.forEach((segment, s) => {
    if (s > 0 && line.joins[s] === "positioned") {
      // A word gap that was deleted closes up.
      const gapIndex = line.chars.findIndex((c) => c.gap && c.segment === s - 1 && c.after === (line.segments[s - 1] as Segment).glyphs.length - 1);
      if (gapIndex >= 0 && removed(gapIndex)) running -= (line.chars[gapIndex] as LineChar).advance;
      if (Math.abs(running) > 1e-6) {
        if (segment.positioner && tmIsPrivate(line, lineEnd)) {
          const source = (segment.runs[0] as TextRun).source;
          const op = parseSource(source).ops[segment.positioner.opIndex] as { start: number; end: number };
          const moved = multiply(translation(running, 0), segment.positioner.matrix);
          out.moves.push({ start: op.start, end: op.end, text: `${moved.map(precise).join(" ")} Tm` });
        } else {
          out.unmovable = true;
        }
      }
    }
    running += deltas[s] as number;
  });
  return out;
}

// ---- planning one line -----------------------------------------------------------------------------------------

interface Planned {
  splices: Splice[];
  outcome: EditOutcome;
  /** How far the start of the line moves along its baseline, in text space (alignment). */
  startShift: number;
}

/** What the planner needs to know about the page beyond the line itself. */
interface PageFacts {
  lines: readonly TextLine[];
  /** The page's visible box in the space the content draws in. */
  bounds: Rect;
}

const originalText = (source: ContentSource, start: number, end: number): string => new TextDecoder("latin1").decode(source.data.slice(start, end));

/** Operators after which the line matrix does not matter any more. */
const RESETS_LINE_MATRIX = new Set(["ET", "Tm", "BT"]);

async function planLine(doc: PDFDocument, line: TextLine, request: LineEditRequest, page: PageFacts): Promise<Planned | EditOutcome> {
  const lineId = request.lineId;
  const blocked = whyNotEditable(line);
  if (blocked) return refuse(lineId, blocked, line);

  const style = request.style;
  const styleChange = style !== undefined && (style.family !== undefined || style.bold !== undefined || style.italic !== undefined);
  const first = line.runs[0] as TextRun;
  const widthBefore = line.advance * line.scale;
  const notes: string[] = [];
  const warnings: string[] = [];

  const diff = styleChange ? { from: 0, to: line.chars.length, insert: Array.from(request.text), same: false } : diffLine(line, request.text);
  const wantsSize = style?.size !== undefined && Math.abs(style.size - first.fontSize) > 1e-6;
  const fitting = request.fit === "condense" || request.fit === "shrink";
  if (diff.same && !wantsSize && !fitting) return { ...refuse(lineId, "", line), status: "unchanged", reason: undefined, verified: true };

  // Which segment receives the new characters, and where in it.
  const replacing = diff.to > diff.from;
  let anchorSegment = 0;
  let insertBefore = 0;
  let insertAfterGap = false;
  if (line.chars.length > 0) {
    if (replacing) {
      const c = line.chars[diff.from] as LineChar;
      anchorSegment = c.segment;
      insertBefore = c.glyph >= 0 ? c.glyph : c.after + 1;
    } else if (diff.from > 0) {
      const c = line.chars[diff.from - 1] as LineChar;
      anchorSegment = c.segment;
      insertBefore = (c.glyph >= 0 ? c.glyph : c.after) + 1;
      insertAfterGap = c.gap;
    }
  }
  const anchor = line.segments[anchorSegment] as Segment;
  const anchorRun = anchor.runs[0] as TextRun;

  let encoded: Encoded;
  try {
    encoded = await encodeInsertion(doc, anchorRun, diff.insert, style, styleChange);
  } catch (error) {
    if (error instanceof AppError) return refuse(lineId, error.message, line);
    throw error;
  }

  // Which segments change, and how each one comes out.
  const removed = (index: number) => index >= diff.from && index < diff.to;
  const lastSegment = line.segments.length - 1;
  const layouts: (Layout | null)[] = [];
  const deltas: number[] = new Array<number>(line.segments.length).fill(0);
  let delta = 0;
  for (let s = 0; s < line.segments.length; s += 1) {
    const segment = line.segments[s] as Segment;
    const charOfGlyph: number[] = new Array<number>(segment.glyphs.length).fill(-1);
    const gapAfter = new Map<number, number>();
    line.chars.forEach((c, i) => {
      if (c.segment !== s) return;
      if (c.glyph >= 0) charOfGlyph[c.glyph] = i;
      else gapAfter.set(c.after, i);
    });
    const loses = charOfGlyph.some((c) => removed(c)) || [...gapAfter.values()].some((c) => removed(c));
    if (s !== anchorSegment && !loses) {
      layouts.push(null);
      continue;
    }
    const hasFlowSuccessor = line.joins[s + 1] === "flow";
    if (segment.interior && hasFlowSuccessor) {
      return refuse(lineId, "This line is built from separately positioned pieces followed by more text that continues from them, which the editor cannot move safely.", line);
    }
    const layout = layoutSegment(line, s, removed, s === anchorSegment ? encoded.items : null, insertBefore, insertAfterGap, charOfGlyph, gapAfter, hasFlowSuccessor);
    layouts.push(layout);
    deltas[s] = layout.penEnd - originalPenEnd(segment, hasFlowSuccessor);
    delta += deltas[s] as number;
  }
  const oldAdvance = line.advance;
  const newAdvance = oldAdvance + delta;

  // Alignment: keep the right edge or the centre where it was.
  const align = style?.align ?? "left";
  const shiftText = align === "right" ? -delta : align === "center" ? -delta / 2 : 0;
  const shiftTj = Math.abs(shiftText) < 1e-6 ? 0 : (-shiftText * 1000) / (first.fontSize * first.hScale);

  // Fit to the original width, when asked.
  const fit = request.fit ?? "none";
  let tzScale = 1;
  let sizeScale = 1;
  if (fitting && newAdvance > oldAdvance + 1e-6) {
    const factor = oldAdvance / newAdvance;
    const sameFont = line.runs.every((r) => r.fontName === first.fontName);
    if (fit === "shrink" && sameFont && line.segments.length === 1) {
      sizeScale = factor;
      notes.push(`Type reduced to ${Math.round(factor * 100)}% to keep the original width.`);
    } else {
      tzScale = factor;
      notes.push(`Letters condensed to ${Math.round(factor * 100)}% to keep the original width.`);
    }
    if (factor < 0.6) warnings.push("The new text is much longer than the original; at this size it will be hard to read.");
  }
  const appliedFactor = tzScale * sizeScale;
  const widthAfter = newAdvance * line.scale * appliedFactor;

  // Will the longer line still have room?
  if (delta > 1e-6 && appliedFactor === 1) {
    const room = freeSpaceRight(line, page.lines, page.bounds);
    if (delta * line.scale > room.space + 0.01) {
      warnings.push(
        room.limit === "page"
          ? "The new text runs past the edge of the page. Shorten it or use “Fit to the original width”."
          : "The new text is wider than the space before the next text on this line, so they will overlap. Shorten it or use “Fit to the original width”.",
      );
    }
  }

  // Pieces placed on their own after the edit move by everything that changed before them.
  const moves = positionedMoves(line, deltas, removed, shiftText);
  if (moves.unmovable && Math.abs(delta) > 1e-6) {
    warnings.push("Text further along this line is placed separately and stays where it was, so the spacing after the edit differs.");
  }

  // Build the replacements.
  const splices: Splice[] = [];
  for (const move of moves.moves) splices.push(move);
  const tzOpen = tzScale < 1 ? `${formatNumber(first.hScale * 100 * tzScale)} Tz ` : "";
  const tzClose = tzScale < 1 ? ` ${formatNumber(first.hScale * 100)} Tz` : "";
  line.segments.forEach((segment, s) => {
    const layout = layouts[s] ?? null;
    const wrapsOpen = s === 0 && tzOpen !== "";
    const wrapsClose = s === lastSegment && tzClose !== "";
    const shifted = s === 0 && shiftTj !== 0;
    if (!layout && !wrapsOpen && !wrapsClose && !shifted) return;
    const head = segment.runs[0] as TextRun;
    const tail = segment.runs[segment.runs.length - 1] as TextRun;
    let text: string;
    if (layout) {
      const needsRestore = segment.interior && !RESETS_LINE_MATRIX.has(segment.nextOp ?? "");
      text = renderSegment(head, layout.items, { shift: shifted ? shiftTj : 0, size: sizeScale < 1 ? first.fontSize * sizeScale : undefined, restore: needsRestore ? tail.lineMatrix : null });
    } else {
      text = (shifted ? `[${formatNumber(shiftTj)}] TJ ` : "") + originalText(head.source, segment.spanStart, segment.spanEnd);
    }
    if (wrapsOpen) text = tzOpen + text;
    if (wrapsClose) text += tzClose;
    splices.push({ start: segment.spanStart, end: segment.spanEnd, text });
  });

  const distinct = [...new Set(encoded.fallbackChars)].join("");
  const outcome: EditOutcome = {
    lineId,
    status: "applied",
    mode: encoded.fallbackChars.length > 0 || styleChange ? "B" : "A",
    notes,
    warnings,
    fallbackChars: distinct,
    fallbackFont: encoded.fallbackLabel,
    widthBefore,
    widthAfter,
    verified: false,
  };
  if (outcome.mode === "B" && encoded.fallbackLabel) {
    const many = Array.from(distinct).length > 1;
    notes.push(styleChange ? `The line was rebuilt in ${encoded.fallbackLabel}.` : `${Array.from(distinct).join(" ")} ${many ? "are" : "is"} not in this document's font, so ${many ? "they are" : "it is"} drawn in ${encoded.fallbackLabel}.`);
  }
  return { splices, outcome, startShift: shiftText };
}

// ---- applying -----------------------------------------------------------------------------------------------------

type PageHandle = ReturnType<PDFDocument["getPage"]>;

function pageBounds(page: PageHandle): Rect {
  const box = page.getCropBox();
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

/** Gives `page` its own copy of the form XObject drawn under `name`, whose content is `data`. */
function replaceFormForPage(doc: PDFDocument, page: PageHandle, name: string, form: PDFStream, data: Uint8Array, unusedImages: ReadonlySet<string>): void {
  const copy = writeFormCopy(doc, form, data);
  if (unusedImages.size > 0) {
    const own = withoutXObjects(doc, form.dict.lookupMaybe(PDFName.of("Resources"), PDFDict), unusedImages);
    const target = doc.context.lookup(copy);
    if (own && target && "dict" in target) (target as PDFStream).dict.set(PDFName.of("Resources"), own);
  }
  const existing = pageResources(page);
  const resources = doc.context.obj({}) as PDFDict;
  if (existing) for (const [key, value] of existing.entries()) resources.set(key, value);
  const xobjects = doc.context.obj({}) as PDFDict;
  const originalXObjects = existing?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  if (originalXObjects) for (const [key, value] of originalXObjects.entries()) xobjects.set(key, value);
  xobjects.set(PDFName.of(name), copy);
  resources.set(PDFName.of("XObject"), xobjects);
  page.node.set(PDFName.of("Resources"), resources);
}

/** Pictures named in `names` that the content no longer draws with `Do`. */
function unusedPictures(data: Uint8Array, names: ReadonlySet<string>): Set<string> {
  const stillUsed = new Set<string>();
  for (const op of parseContentStream(data).ops) {
    if (op.op !== "Do") continue;
    const operand = op.args[op.args.length - 1];
    if (operand?.t === "name") stillUsed.add(operand.v);
  }
  return new Set([...names].filter((name) => !stillUsed.has(name)));
}

/**
 * Applies the edits to one page: changes to the text of lines, and (through `options.objects`) moving, removing and
 * reordering lines, images, shapes and annotations. Everything is planned from one reading of the page and written back
 * in one pass. Edits that cannot be made are reported as refused, with the reason, and leave the page untouched. The
 * page is read back afterwards and every applied text edit is checked.
 */
export async function applyTextEdits(doc: PDFDocument, pageIndex: number, requests: readonly LineEditRequest[], options: EditOptions = {}): Promise<EditReport> {
  const page = doc.getPage(pageIndex);
  const context = engineContext(doc);
  ensureScanned(context);

  const source = readPageContent(doc, page);
  const before = interpret(doc, source, IDENTITY, context.fonts, {}, { formSources: context.formSources, seedUsed: context.seedUsed });
  const lines = buildLines(before.runs);
  const facts: PageFacts = { lines, bounds: pageBounds(page) };
  const frame = frameOf(page);
  const toUserVector = displayToUserMatrix(frame);

  /** Whether the stream a line is in can be rewritten for this page, or why not. */
  const blockedSource = (line: TextLine): string | null => {
    const head = line.runs[0] as TextRun;
    const lineSource = head.source;
    if (lineSource.kind !== "form") return null;
    if (head.depth > 1) return "This text is inside forms nested several levels deep, which the editor does not rewrite.";
    const uses = before.forms.filter((form) => lineSource.id === `form:${form.ref?.toString()}`).length;
    if (uses > 1 && !options.allowRepeatedForms) return `This text belongs to a reusable block that the page draws ${uses} times. Editing it would change all of them.`;
    return null;
  };

  // ---- objects: lines moved or removed, images, shapes, annotations ----------------------------------------------------
  // When an object is listed twice the last change is the one that counts.
  const objectEdits = [...new Map((options.objects ?? []).map((edit) => [edit.id, edit])).values()];
  const lineById = new Map(lines.map((line) => [line.id, line]));
  const objectOutcomes: ObjectOutcome[] = [];
  const objectSplices = new Map<ContentSource, Splice[]>();
  const owners = new Map<string, ContentSource[]>();
  const addObjectSplices = (owner: string, lineSource: ContentSource, splices: readonly Splice[]) => {
    const list = objectSplices.get(lineSource) ?? [];
    for (const splice of splices) list.push({ ...splice, owner });
    objectSplices.set(lineSource, list);
    owners.set(owner, [...(owners.get(owner) ?? []), lineSource]);
  };
  const removedLines = new Set<string>();
  const movedLines = new Map<string, { dx: number; dy: number }>();
  const nonLine: ObjectEdit[] = [];
  for (const edit of objectEdits) {
    const line = lineById.get(edit.id);
    if (!line) {
      nonLine.push(edit);
      continue;
    }
    const blocked = blockedSource(line);
    if (blocked) {
      objectOutcomes.push({ id: edit.id, status: "refused", reason: blocked });
      continue;
    }
    const lineSource = (line.runs[0] as TextRun).source;
    if (edit.delete) {
      const change = planLineDelete(line);
      if (change.refusal) objectOutcomes.push({ id: edit.id, status: "refused", reason: change.refusal });
      else {
        addObjectSplices(edit.id, lineSource, change.splices);
        removedLines.add(line.id);
        objectOutcomes.push({ id: edit.id, status: "applied" });
      }
      continue;
    }
    if (edit.move && (Math.abs(edit.move.dx) > 1e-6 || Math.abs(edit.move.dy) > 1e-6)) {
      const [dx, dy] = applyVector(toUserVector, edit.move.dx, edit.move.dy);
      const change = planLineMove(line, dx, dy);
      if (change.refusal) objectOutcomes.push({ id: edit.id, status: "refused", reason: change.refusal });
      else {
        addObjectSplices(edit.id, lineSource, change.splices);
        movedLines.set(line.id, { dx, dy });
        objectOutcomes.push({ id: edit.id, status: "applied" });
      }
      continue;
    }
    objectOutcomes.push({ id: edit.id, status: "unchanged" });
  }
  const shapes = nonLine.length > 0 ? planObjectEdits({ page, frame, interpretation: before, edits: nonLine, allowRepeatedForms: options.allowRepeatedForms ?? false }) : null;
  if (shapes) {
    for (const [lineSource, splices] of shapes.splices) for (const splice of splices) addObjectSplices(splice.owner ?? "", lineSource, [splice]);
    objectOutcomes.push(...shapes.outcomes);
  }

  // ---- text edits ----------------------------------------------------------------------------------------------------------
  const outcomes: EditOutcome[] = [];
  const slots = new Map<LineEditRequest, EditOutcome>();
  const bySource = new Map<ContentSource, Splice[]>();
  const planned: { request: LineEditRequest; line: TextLine; plan: Planned }[] = [];

  for (const request of requests) {
    const line = lineById.get(request.lineId);
    if (!line) {
      slots.set(request, refuse(request.lineId, "That line is no longer on the page."));
      continue;
    }
    if (removedLines.has(line.id)) {
      slots.set(request, { ...refuse(request.lineId, "", line), status: "unchanged", reason: undefined, notes: ["The line was removed."], verified: true });
      continue;
    }
    const blocked = blockedSource(line);
    if (blocked) {
      slots.set(request, refuse(request.lineId, blocked, line));
      continue;
    }
    const lineSource = (line.runs[0] as TextRun).source;
    const result = await planLine(doc, line, request, facts);
    if ("status" in result) {
      slots.set(request, result);
      continue;
    }
    planned.push({ request, line, plan: result });
    const list = bySource.get(lineSource) ?? [];
    list.push(...result.splices);
    bySource.set(lineSource, list);
  }

  // ---- write everything back, once per stream ------------------------------------------------------------------------------
  let changed = false;
  const sources = new Set<ContentSource>([...bySource.keys(), ...objectSplices.keys()]);
  const dropped = new Set<string>();
  for (const lineSource of sources) {
    const textSplices = bySource.get(lineSource) ?? [];
    const own = objectSplices.get(lineSource) ?? [];
    // An object change that collides with a text edit (or another change) is left out, and says so.
    const resolved = dropConflicts([...textSplices, ...own]);
    for (const owner of resolved.dropped) dropped.add(owner);
    if (resolved.kept.length === 0) continue;
    const data = applySplices(lineSource.data, resolved.kept);

    const removedHere = shapes?.removedImages.get(lineSource);
    const names = removedHere ? new Set([...removedHere].filter(([, owner]) => !dropped.has(owner)).map(([name]) => name)) : new Set<string>();
    const unused = names.size > 0 ? unusedPictures(data, names) : new Set<string>();

    if (lineSource.kind === "page") {
      writePageContent(doc, page, data);
      if (unused.size > 0) {
        const trimmed = withoutXObjects(doc, pageResources(page), unused);
        if (trimmed) page.node.set(PDFName.of("Resources"), trimmed);
      }
      changed = true;
    } else {
      const form = lineSource.parts[0]?.stream;
      const use = before.forms.find((f) => lineSource.id === `form:${f.ref?.toString()}`);
      if (form && use) {
        replaceFormForPage(doc, page, use.name, form, data, unused);
        changed = true;
      }
    }
  }
  if (shapes && shapes.annotations.length > 0) {
    applyAnnotationChanges(doc, page, shapes.annotations);
    changed = true;
  }
  // Report what could not be combined.
  for (const outcome of objectOutcomes) {
    if (outcome.status === "applied" && dropped.has(outcome.id)) {
      outcome.status = "refused";
      outcome.reason = "This change overlaps another change to the same text, so it was left out.";
    }
  }

  // Fonts embedded for the edit are only written into the document when it is flushed; read them back after that.
  await doc.flush();

  // Check every applied edit against a fresh reading of the page.
  const afterSource = readPageContent(doc, page);
  const after = interpret(doc, afterSource, IDENTITY, new Map(), {}, { formSources: new Map() });
  const afterLines = buildLines(after.runs);
  for (const { request, line, plan } of planned) {
    const first = line.runs[0] as TextRun;
    const expected = request.text.replace(/\s+/g, " ").trim();
    const tolerance = Math.abs(plan.startShift) * line.scale + 0.75;
    const moved = dropped.has(request.lineId) ? undefined : movedLines.get(line.id);
    const found = afterLines.find((candidate) => {
      const head = candidate.runs[0] as TextRun;
      return Math.hypot(head.matrix[4] - (first.matrix[4] + (moved?.dx ?? 0)), head.matrix[5] - (first.matrix[5] + (moved?.dy ?? 0))) < tolerance && candidate.text.replace(/\s+/g, " ").trim() === expected;
    });
    slots.set(request, {
      ...plan.outcome,
      verified: Boolean(found),
      widthAfter: found ? found.advance * found.scale : plan.outcome.widthAfter,
      box: found?.box ?? line.box,
      warnings: found ? plan.outcome.warnings : [...plan.outcome.warnings, "After the edit the page was read again and the line did not read as requested."],
    });
  }
  // Answers come back in the order the requests were made.
  for (const request of requests) {
    const outcome = slots.get(request);
    if (outcome) outcomes.push(outcome);
  }
  return { outcomes, objects: objectOutcomes, changed };
}
