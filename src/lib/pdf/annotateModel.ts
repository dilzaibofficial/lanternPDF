import type { FontFamily } from "./fonts";

/**
 * What the editor places on a page. Everything is in the page's *display space*: points, origin at the
 * top-left corner of the page as the viewer shows it, y pointing down (like the editor's own canvas).
 * The export maps that onto whatever rotation and box the PDF page actually has.
 *
 * This file has no dependencies on the PDF library, so the editor can share it with the exporter.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Common {
  id: string;
  /** 1-based page number. */
  page: number;
}

export interface TextNote extends Common {
  kind: "text";
  /** Top-left corner of the text block. */
  x: number;
  y: number;
  /** Lines are separated by "\n". */
  text: string;
  fontSize: number;
  color: string;
  family: FontFamily;
  bold: boolean;
  italic: boolean;
}

export interface HighlightNote extends Common, Box {
  kind: "highlight";
  color: string;
  opacity: number;
}

/** An opaque box, to cover something. Covering hides it from view; the content stays in the file. */
export interface WhiteoutNote extends Common, Box {
  kind: "whiteout";
  color: string;
}

export interface ShapeNote extends Common, Box {
  kind: "rect" | "ellipse";
  stroke: string | null;
  fill: string | null;
  strokeWidth: number;
  opacity: number;
}

export interface LineNote extends Common {
  kind: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  strokeWidth: number;
  /** Draws an arrowhead at the second point. */
  arrow: boolean;
  opacity: number;
}

export interface DrawNote extends Common {
  kind: "draw";
  points: [number, number][];
  color: string;
  strokeWidth: number;
  opacity: number;
}

export interface ImageNote extends Common, Box {
  kind: "image";
  image: { name: string; bytes: Uint8Array };
  opacity: number;
}

export type Annotation = TextNote | HighlightNote | WhiteoutNote | ShapeNote | LineNote | DrawNote | ImageNote;
export type AnnotationKind = Annotation["kind"];

/** Spacing of lines of text, as a multiple of the font size. */
export const LINE_HEIGHT = 1.2;
/** Where the first baseline sits below the top of a text block, as a multiple of the font size. */
export const BASELINE = 0.9;

export const textLines = (text: string): string[] => text.split(/\r\n|\r|\n/);

/** Baseline of line `index` of a text note, in display space (y down). */
export const baselineOf = (note: Pick<TextNote, "y" | "fontSize">, index: number): number => note.y + note.fontSize * (BASELINE + index * LINE_HEIGHT);

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * A freehand stroke as an SVG path: a smooth curve through the middle of each pair of points, which is
 * what makes a hand-drawn line look natural rather than a polyline. The editor draws this very string
 * and the exporter hands it to the PDF library, so the two agree.
 */
export function strokePath(points: readonly (readonly [number, number])[]): string {
  const first = points[0];
  if (!first) return "";
  const last = points[points.length - 1] as readonly [number, number];
  if (points.length === 1) return `M ${round(first[0])} ${round(first[1])} L ${round(first[0] + 0.01)} ${round(first[1])}`;
  let path = `M ${round(first[0])} ${round(first[1])}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const p = points[i] as readonly [number, number];
    const next = points[i + 1] as readonly [number, number];
    path += ` Q ${round(p[0])} ${round(p[1])} ${round((p[0] + next[0]) / 2)} ${round((p[1] + next[1]) / 2)}`;
  }
  return `${path} L ${round(last[0])} ${round(last[1])}`;
}

/** Ramer-Douglas-Peucker: drops points that lie within `tolerance` of the line between their neighbours. */
export function simplifyPoints(points: readonly [number, number][], tolerance: number): [number, number][] {
  if (points.length < 3) return points.map((p) => [p[0], p[1]]);
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop() as [number, number];
    const a = points[start] as [number, number];
    const b = points[end] as [number, number];
    let worst = 0;
    let index = -1;
    for (let i = start + 1; i < end; i += 1) {
      const p = points[i] as [number, number];
      const distance = distanceToSegment(p, a, b);
      if (distance > worst) {
        worst = distance;
        index = i;
      }
    }
    if (index !== -1 && worst > tolerance) {
      keep[index] = true;
      stack.push([start, index], [index, end]);
    }
  }
  return points.filter((_, i) => keep[i]).map((p) => [p[0], p[1]]);
}

function distanceToSegment(p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** The two short strokes that make an arrowhead at (x2, y2) for a line from (x1, y1). */
export function arrowHead(x1: number, y1: number, x2: number, y2: number, strokeWidth: number): [[number, number], [number, number]] {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const length = Math.max(10, strokeWidth * 4.5);
  const spread = Math.PI / 7;
  return [
    [x2 - length * Math.cos(angle - spread), y2 - length * Math.sin(angle - spread)],
    [x2 - length * Math.cos(angle + spread), y2 - length * Math.sin(angle + spread)],
  ];
}

/** A rectangle given by two opposite corners (in any order) as a box with positive size. */
export function boxFromCorners(a: { x: number; y: number }, b: { x: number; y: number }): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/** The rectangle that encloses an annotation, for selection frames and hit areas. Text needs its measured width. */
export function boundsOf(note: Annotation, textWidth?: number): Box {
  switch (note.kind) {
    case "text":
      return { x: note.x, y: note.y, width: textWidth ?? note.fontSize * 0.6 * Math.max(1, ...textLines(note.text).map((line) => line.length)), height: textLines(note.text).length * note.fontSize * LINE_HEIGHT };
    case "line": {
      const pad = note.strokeWidth / 2;
      return { x: Math.min(note.x1, note.x2) - pad, y: Math.min(note.y1, note.y2) - pad, width: Math.abs(note.x1 - note.x2) + note.strokeWidth, height: Math.abs(note.y1 - note.y2) + note.strokeWidth };
    }
    case "draw": {
      const xs = note.points.map((p) => p[0]);
      const ys = note.points.map((p) => p[1]);
      const pad = note.strokeWidth / 2;
      const x = Math.min(...xs) - pad;
      const y = Math.min(...ys) - pad;
      return { x, y, width: Math.max(...xs) + pad - x, height: Math.max(...ys) + pad - y };
    }
    default:
      return { x: note.x, y: note.y, width: note.width, height: note.height };
  }
}

/** Moves an annotation by (dx, dy), returning a new one. */
export function moveAnnotation<T extends Annotation>(note: T, dx: number, dy: number): T {
  switch (note.kind) {
    case "line":
      return { ...note, x1: note.x1 + dx, y1: note.y1 + dy, x2: note.x2 + dx, y2: note.y2 + dy };
    case "draw":
      return { ...note, points: note.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
    default:
      return { ...note, x: (note as Box).x + dx, y: (note as Box).y + dy };
  }
}
