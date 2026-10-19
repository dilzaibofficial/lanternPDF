import type { TextRun } from "./interpret";
import { type Matrix, type Rect, apply, applyVector, unionRects } from "./matrix";
import { parseSource } from "./streams";

/**
 * Groups text runs into the units a person edits.
 *
 * Producers write text in very different ways. A word processor may put a sentence in one `TJ`; Chromium's PDF
 * printer draws every glyph with its own `Tj` and a `Td` between them; some tools position each word with `Tm`.
 * Editing has to treat all of these as "a line of text", so grouping is done by geometry and shared state, not by
 * how the operators happen to be arranged:
 *
 *  - A **segment** is a chain of runs with identical text state (font, size, spacing, colour…) that sit on one
 *    baseline, each starting about where the previous one ended, with only positioning operators between them.
 *    A segment is rewritten as one piece, laid out again glyph by glyph from the original positions.
 *  - A **line** is one or more segments where each continues exactly where the previous stopped (no positioning
 *    operator in between): a sentence with a bold word in the middle. Changing the width of one segment then moves
 *    the rest of the line naturally.
 *
 * Segments that are merely near each other, each placed on its own, stay separate lines. Joining them would
 * require rewriting the positioning operators in front of them.
 */

export interface SegGlyph {
  /** Index into `segment.runs`. */
  run: number;
  /** Index into that run's `elements`, and into the string element's glyphs. */
  element: number;
  glyph: number;
  code: number;
  length: number;
  text: string;
  /** Pen advance in text space, including character/word spacing and horizontal scaling. */
  advance: number;
  /** Offset of the glyph's origin from the start of the segment, in text space. */
  x: number;
}

export interface Segment {
  runs: TextRun[];
  glyphs: SegGlyph[];
  /** Byte range in the stream: from the first run's operation to the end of the last. */
  spanStart: number;
  spanEnd: number;
  /** True when positioning operators sit between the runs, so the line matrix at the end of the span differs. */
  interior: boolean;
  /** Where the pen stands after the last run, in text space from the segment's start (includes trailing spacing). */
  endX: number;
  /**
   * The `Tm` operator that sets the segment's absolute position, when it has one directly in front of it. Such a
   * segment can be moved by rewriting that operator without disturbing anything else.
   */
  positioner: { opIndex: number; matrix: Matrix } | null;
  /** The operator that follows the span, which decides whether the line matrix at its end has to be restored. */
  nextOp: string | null;
  /** Positions of the first and last run in the interpretation's run list. */
  firstIndex: number;
  lastIndex: number;
}

export interface LineChar {
  /** The character(s) this glyph stands for; a ligature glyph is one entry with several code points. */
  text: string;
  /** Index into `line.segments`. */
  segment: number;
  /** Index into `segment.glyphs`; -1 for a word gap that exists only as spacing. */
  glyph: number;
  /** For a gap, the index of the glyph before it. */
  after: number;
  /** Offset from the start of the line, in text space. */
  x: number;
  advance: number;
  gap: boolean;
}

/** How a segment connects to the one before it in a line. */
export type Join = "flow" | "positioned" | null;

export interface TextLine {
  /** Id of the first run: stable for a given content stream. */
  id: string;
  segments: Segment[];
  /** For each segment, how it connects to the previous one: continuing its pen ("flow"), placed after it by its own `Tm` ("positioned"), or null for the first. */
  joins: Join[];
  /** Every run of the line, in order. */
  runs: TextRun[];
  chars: LineChar[];
  text: string;
  /** Distance from the start of the line to the end of its last glyph, in text space. */
  advance: number;
  /** Bounding box in the space the stream draws in. */
  box: Rect;
  /** Where the line's text starts, and the unit direction of its baseline, in that space. */
  origin: [number, number];
  direction: [number, number];
  /** Length of one text-space unit in the stream's drawing space. */
  scale: number;
  /** Angle of the baseline in degrees, counter-clockwise, 0 = left to right. */
  rotation: number;
  /** Effective font size in the drawing space. */
  size: number;
}

const POSITIONING = new Set(["Td", "TD", "Tm", "T*"]);
const SIZE_TOLERANCE = 1e-6;

const close = (a: number, b: number, tolerance = 1e-4) => Math.abs(a - b) <= tolerance;

function sameLinearPart(a: Matrix, b: Matrix): boolean {
  return close(a[0], b[0]) && close(a[1], b[1]) && close(a[2], b[2]) && close(a[3], b[3]);
}

function effectiveSize(run: TextRun): number {
  const [vx, vy] = applyVector(run.matrix, 0, 1);
  return run.fontSize * Math.hypot(vx, vy);
}

/** Identical text state, so the runs can be rewritten as one. */
function sameState(a: TextRun, b: TextRun): boolean {
  return (
    a.font === b.font &&
    a.fontName === b.fontName &&
    close(a.fontSize, b.fontSize, SIZE_TOLERANCE) &&
    a.charSpacing === b.charSpacing &&
    a.wordSpacing === b.wordSpacing &&
    a.hScale === b.hScale &&
    a.rise === b.rise &&
    a.renderMode === b.renderMode &&
    a.fill === b.fill &&
    a.actualText === b.actualText &&
    a.depth === b.depth &&
    a.source === b.source &&
    a.textObject === b.textObject &&
    sameLinearPart(a.matrix, b.matrix)
  );
}

const originOf = (run: TextRun): [number, number] => apply(run.matrix, 0, 0);

function drawsNothing(run: TextRun): boolean {
  return run.text === "" && run.elements.every((e) => e.kind === "adj" || e.glyphs.length === 0);
}

/**
 * Can `next` join the segment ending in `last`? Same state, same baseline, starting about where `last` ended, and
 * nothing between them in the stream but positioning operators.
 */
function joinsSegment(runs: readonly TextRun[], lastIndex: number, nextIndex: number): { join: boolean; interior: boolean } {
  const last = runs[lastIndex] as TextRun;
  const next = runs[nextIndex] as TextRun;
  if (!sameState(last, next) || next.newline) return { join: false, interior: false };
  const ops = parseSource(last.source).ops;
  let interior = false;
  for (let i = last.opIndex + 1; i < next.opIndex; i += 1) {
    const name = (ops[i] as { op: string }).op;
    if (!POSITIONING.has(name)) return { join: false, interior: false };
    interior = true;
  }
  const [lx, ly] = originOf(last);
  const [nx, ny] = originOf(next);
  const [dx, dy] = applyVector(last.matrix, 1, 0);
  const scale = Math.hypot(dx, dy) || 1;
  const ux = dx / scale;
  const uy = dy / scale;
  const along = ((nx - lx) * ux + (ny - ly) * uy) / scale;
  const across = (-(nx - lx) * uy + (ny - ly) * ux) / scale;
  const em = last.fontSize * last.hScale;
  const gap = along - last.advance;
  if (Math.abs(across) > 0.12 * last.fontSize) return { join: false, interior: false };
  if (gap < -0.25 * em || gap > 1.5 * em) return { join: false, interior: false };
  return { join: true, interior };
}

const STATE_ONLY = new Set(["Tf", "Tc", "Tw", "Tz", "TL", "Ts", "Tr", "g", "G", "rg", "RG", "k", "K", "cs", "CS", "sc", "scn", "SC", "SCN", "gs", "w", "J", "j", "M", "d", "ri", "i"]);

/** The absolute `Tm` that places a segment, if it is the nearest positioning operator before it with only state changes in between. */
function findPositioner(first: TextRun): Segment["positioner"] {
  const ops = parseSource(first.source).ops;
  for (let i = first.opIndex - 1; i >= 0 && i >= first.opIndex - 24; i -= 1) {
    const op = ops[i] as { op: string; args: { t: string; v?: number }[] };
    if (op.op === "Tm") {
      const values = op.args.slice(-6).map((a) => (a.t === "num" ? (a.v as number) : Number.NaN));
      return values.length === 6 && values.every(Number.isFinite) ? { opIndex: i, matrix: values as unknown as Matrix } : null;
    }
    if (!STATE_ONLY.has(op.op)) return null;
  }
  return null;
}

function makeSegment(runs: readonly TextRun[], indexes: number[], interior: boolean): Segment {
  const members = indexes.map((i) => runs[i] as TextRun);
  const first = members[0] as TextRun;
  const last = members[members.length - 1] as TextRun;
  const [ox, oy] = originOf(first);
  const [dx, dy] = applyVector(first.matrix, 1, 0);
  const scale = Math.hypot(dx, dy) || 1;
  const glyphs: SegGlyph[] = [];
  members.forEach((run, runIndex) => {
    const [rx, ry] = originOf(run);
    const offset = ((rx - ox) * dx + (ry - oy) * dy) / (scale * scale);
    run.elements.forEach((element, elementIndex) => {
      if (element.kind !== "str") return;
      element.glyphs.forEach((glyph, glyphIndex) => {
        glyphs.push({ run: runIndex, element: elementIndex, glyph: glyphIndex, code: glyph.code, length: glyph.length, text: glyph.text, advance: glyph.advance, x: offset + glyph.x });
      });
    });
  });
  const ops = parseSource(first.source).ops;
  const [lx, ly] = originOf(last);
  const endX = ((lx - ox) * dx + (ly - oy) * dy) / (scale * scale) + last.advance;
  return {
    runs: members,
    glyphs,
    spanStart: first.op.start,
    spanEnd: last.op.end,
    interior,
    endX,
    positioner: findPositioner(first),
    nextOp: (ops[last.opIndex + 1] as { op: string } | undefined)?.op ?? null,
    firstIndex: indexes[0] as number,
    lastIndex: indexes[indexes.length - 1] as number,
  };
}

export function buildSegments(runs: readonly TextRun[]): Segment[] {
  const segments: Segment[] = [];
  let current: { indexes: number[]; interior: boolean } | null = null;
  runs.forEach((run, index) => {
    if (drawsNothing(run)) return;
    if (current) {
      const joined = joinsSegment(runs, current.indexes[current.indexes.length - 1] as number, index);
      if (joined.join) {
        current.indexes.push(index);
        current.interior = current.interior || joined.interior;
        return;
      }
      segments.push(makeSegment(runs, current.indexes, current.interior));
    }
    current = { indexes: [index], interior: false };
  });
  if (current) segments.push(makeSegment(runs, (current as { indexes: number[] }).indexes, (current as { interior: boolean }).interior));
  return segments;
}

/** Can `next` continue exactly where `previous` ended, with a different text state? */
function flowsFrom(runs: readonly TextRun[], previous: Segment, next: Segment): boolean {
  const first = runs[next.firstIndex] as TextRun;
  const last = runs[previous.lastIndex] as TextRun;
  return (
    first.flowFrom === previous.lastIndex &&
    first.source === last.source &&
    first.textObject === last.textObject &&
    !first.newline &&
    close(first.fontSize, last.fontSize, SIZE_TOLERANCE) &&
    first.rise === last.rise &&
    first.hScale === last.hScale &&
    first.renderMode === last.renderMode &&
    first.actualText === last.actualText &&
    first.depth === last.depth
  );
}

/** The widest gap, in em, that still counts as the next word on the same line when each piece is placed on its own. */
const POSITIONED_GAP_EM = 0.75;

/** Is `next` the continuation of the line ending in `previous`, placed after it by its own absolute position? */
function positionedAfter(runs: readonly TextRun[], previous: Segment, next: Segment): boolean {
  if (!next.positioner) return false;
  const last = runs[previous.lastIndex] as TextRun;
  const first = runs[next.firstIndex] as TextRun;
  if (first.source !== last.source || first.depth !== last.depth || first.renderMode !== last.renderMode || first.actualText !== last.actualText || first.newline) return false;
  if (!sameLinearPart(first.matrix, last.matrix) || first.hScale !== last.hScale || first.rise !== last.rise) return false;
  const [lx, ly] = originOf(runs[previous.firstIndex] as TextRun);
  const [nx, ny] = originOf(first);
  const [dx, dy] = applyVector(last.matrix, 1, 0);
  const scale = Math.hypot(dx, dy) || 1;
  const along = ((nx - lx) * dx + (ny - ly) * dy) / (scale * scale);
  const across = (-(nx - lx) * dy + (ny - ly) * dx) / (scale * scale);
  const em = Math.max(last.fontSize, first.fontSize) * last.hScale;
  if (Math.abs(across) > 0.12 * Math.max(last.fontSize, first.fontSize)) return false;
  const gap = along - previous.endX;
  return gap >= -0.1 * em && gap <= POSITIONED_GAP_EM * em;
}

export function buildLines(runs: readonly TextRun[]): TextLine[] {
  const segments = buildSegments(runs);
  const groups: { segments: Segment[]; joins: Join[] }[] = [];
  for (const segment of segments) {
    const group = groups[groups.length - 1];
    const previous = group?.segments[group.segments.length - 1];
    if (group && previous && flowsFrom(runs, previous, segment)) {
      group.segments.push(segment);
      group.joins.push("flow");
    } else if (group && previous && positionedAfter(runs, previous, segment)) {
      group.segments.push(segment);
      group.joins.push("positioned");
    } else {
      groups.push({ segments: [segment], joins: [null] });
    }
  }
  return groups.map((group) => makeLine(group.segments, group.joins));
}

function makeLine(segments: Segment[], joins: Join[]): TextLine {
  const allRuns = segments.flatMap((s) => s.runs);
  const first = allRuns[0] as TextRun;
  const [ox, oy] = originOf(first);
  const [dx, dy] = applyVector(first.matrix, 1, 0);
  const scale = Math.hypot(dx, dy) || 1;

  const chars: LineChar[] = [];
  let end = 0;
  const offsetOf = (segment: Segment): number => {
    const [sx, sy] = originOf(segment.runs[0] as TextRun);
    return ((sx - ox) * dx + (sy - oy) * dy) / (scale * scale);
  };
  segments.forEach((segment, segmentIndex) => {
    const segmentOffset = offsetOf(segment);
    const run = segment.runs[0] as TextRun;
    const em = run.fontSize * run.hScale;
    segment.glyphs.forEach((glyph, glyphIndex) => {
      const previous = segment.glyphs[glyphIndex - 1];
      if (previous) {
        const gap = glyph.x - (previous.x + previous.advance);
        const spaceAround = /\s$/.test(previous.text) || /^\s/.test(glyph.text);
        if (gap > 0.2 * em && !spaceAround) {
          chars.push({ text: " ", segment: segmentIndex, glyph: -1, after: glyphIndex - 1, x: segmentOffset + previous.x + previous.advance, advance: gap, gap: true });
        }
      }
      chars.push({ text: glyph.text, segment: segmentIndex, glyph: glyphIndex, after: glyphIndex, x: segmentOffset + glyph.x, advance: glyph.advance, gap: false });
      end = Math.max(end, segmentOffset + glyph.x + glyph.advance);
    });
    // Spacing at the end of a segment that more text follows on the same line is a word gap too.
    const lastGlyph = segment.glyphs[segment.glyphs.length - 1];
    const nextSegment = segments[segmentIndex + 1];
    if (lastGlyph && nextSegment) {
      const nextFirst = nextSegment.glyphs[0];
      const gap = offsetOf(nextSegment) + (nextFirst?.x ?? 0) - (segmentOffset + lastGlyph.x + lastGlyph.advance);
      const nextStartsWithSpace = /^s/.test(nextFirst?.text ?? "");
      if (gap > 0.2 * em && !/s$/.test(lastGlyph.text) && !nextStartsWithSpace) {
        chars.push({ text: " ", segment: segmentIndex, glyph: -1, after: segment.glyphs.length - 1, x: segmentOffset + lastGlyph.x + lastGlyph.advance, advance: gap, gap: true });
      }
    }
  });

  return {
    id: first.id,
    segments,
    joins,
    runs: allRuns,
    chars,
    text: chars.map((c) => c.text).join(""),
    advance: end,
    box: unionRects(allRuns.map((r) => r.box)) as Rect,
    origin: [ox, oy],
    direction: [dx / scale, dy / scale],
    scale,
    rotation: (Math.atan2(dy, dx) * 180) / Math.PI,
    size: effectiveSize(first),
  };
}

export interface FreeSpace {
  /** Room to the right of the line's end along its baseline, in the drawing space's units. */
  space: number;
  /** What ends it: other text on the same baseline, or the edge of the page. */
  limit: "text" | "page";
}

/**
 * How far a line could grow before it meets something: the next text on the same baseline, or the page edge
 * (less a small margin). Measured along the line's own direction so rotated lines work.
 */
export function freeSpaceRight(line: TextLine, lines: readonly TextLine[], bounds: Rect): FreeSpace {
  const [dx, dy] = line.direction;
  const perpendicular: [number, number] = [-dy, dx];
  const [ox, oy] = line.origin;
  const end = line.advance * line.scale;
  const local = (x: number, y: number): [number, number] => [(x - ox) * dx + (y - oy) * dy, (x - ox) * perpendicular[0] + (y - oy) * perpendicular[1]];
  const bandLow = -line.size * 0.3;
  const bandHigh = line.size * 0.95;

  let nearest = Number.POSITIVE_INFINITY;
  for (const other of lines) {
    if (other === line) continue;
    const corners: [number, number][] = [
      local(other.box.x, other.box.y),
      local(other.box.x + other.box.width, other.box.y),
      local(other.box.x, other.box.y + other.box.height),
      local(other.box.x + other.box.width, other.box.y + other.box.height),
    ];
    const us = corners.map((c) => c[0]);
    const vs = corners.map((c) => c[1]);
    const uMin = Math.min(...us);
    if (Math.max(...vs) <= bandLow + line.size * 0.15 || Math.min(...vs) >= bandHigh - line.size * 0.15) continue; // a different line of text
    if (uMin >= end - 0.5) nearest = Math.min(nearest, uMin);
  }
  if (Number.isFinite(nearest)) return { space: Math.max(0, nearest - end), limit: "text" };

  const endX = ox + dx * end;
  const endY = oy + dy * end;
  const margin = 8;
  const toEdge = (position: number, direction: number, low: number, high: number): number => {
    if (direction > 1e-9) return (high - margin - position) / direction;
    if (direction < -1e-9) return (low + margin - position) / direction;
    return Number.POSITIVE_INFINITY;
  };
  const room = Math.min(toEdge(endX, dx, bounds.x, bounds.x + bounds.width), toEdge(endY, dy, bounds.y, bounds.y + bounds.height));
  return { space: Math.max(0, room), limit: "page" };
}

/** Code points of a string (so astral characters count as one). */
export const codePoints = (text: string): string[] => Array.from(text);

/**
 * Where each character of the line begins in the line's text, counted in code points, plus the total. A ligature
 * glyph covers several code points; a glyph with no character covers none.
 */
export function glyphBoundaries(line: TextLine): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const char of line.chars) {
    starts.push(at);
    at += codePoints(char.text).length;
  }
  starts.push(at);
  return starts;
}
