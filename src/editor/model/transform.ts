import { boundsOf, boxFromCorners, boxesOverlap, frameOf, isBoxObject, rotatePoint, unionBoxes } from "./geometry";
import { type Measure, layoutTextBox } from "./textLayout";
import type { Box, EditorObject, Id, Pt } from "./types";

/**
 * Pure helpers for what a drag does to an object. They sit between the pointer (which knows points) and the model
 * (which knows objects), and are tested without a screen.
 */

/** Gives a box object a new frame. Text boxes whose height follows their text recompute it; drawings are scaled. */
export function applyBox(object: EditorObject, box: Box, measure?: Measure): EditorObject {
  switch (object.kind) {
    case "draw": {
      const old = frameOf(object);
      const pad = object.strokeWidth / 2;
      const inner = { x: old.x + pad, y: old.y + pad, width: Math.max(1e-6, old.width - object.strokeWidth), height: Math.max(1e-6, old.height - object.strokeWidth) };
      const target = { x: box.x + pad, y: box.y + pad, width: Math.max(1e-6, box.width - object.strokeWidth), height: Math.max(1e-6, box.height - object.strokeWidth) };
      return { ...object, points: object.points.map(([x, y]) => [target.x + ((x - inner.x) / inner.width) * target.width, target.y + ((y - inner.y) / inner.height) * target.height] as [number, number]) };
    }
    case "text": {
      const next = { ...object, x: box.x, y: box.y, width: box.width, height: box.height };
      if (next.autoHeight && measure) next.height = Math.max(next.height, layoutTextBox(next, measure).contentHeight);
      return next;
    }
    case "line":
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly":
    case "comment":
      return object;
    default:
      return { ...object, x: box.x, y: box.y, width: box.width, height: box.height };
  }
}

/** Snaps the end of a line to the nearest multiple of `step` degrees around its start. */
export function constrainAngle(from: Pt, to: Pt, step = 45): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return to;
  const snapped = (Math.round(Math.atan2(dy, dx) / ((step * Math.PI) / 180)) * step * Math.PI) / 180;
  return { x: from.x + length * Math.cos(snapped), y: from.y + length * Math.sin(snapped) };
}

/** A line of text on a page, as far as selecting text with the pointer is concerned. */
export interface SelectableLine {
  box: Box;
  angle: number;
}

/**
 * The rectangles that cover the text between two points, the way dragging over text selects it: the first line from
 * where the drag began, the last line up to where it ended, and every line between in full. Falls back to the plain
 * rectangle when the drag is not over any text.
 */
export function selectionQuads(start: Pt, end: Pt, lines: readonly SelectableLine[]): Box[] {
  const horizontal = lines.filter((l) => Math.abs(l.angle) < 1);
  const first = start.y < end.y || (start.y === end.y && start.x <= end.x) ? start : end;
  const last = first === start ? end : start;
  const covered = horizontal
    .filter((l) => l.box.y + l.box.height > Math.min(start.y, end.y) && l.box.y < Math.max(start.y, end.y))
    .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  if (covered.length === 0) return [boxFromCorners(start, end)];
  const rows = new Map<number, SelectableLine[]>();
  for (const line of covered) {
    const key = Math.round(line.box.y / Math.max(2, line.box.height * 0.5));
    rows.set(key, [...(rows.get(key) ?? []), line]);
  }
  const ordered = [...rows.values()];
  return ordered.flatMap((row, rowIndex) => {
    const rowTop = Math.min(...row.map((l) => l.box.y));
    const rowBottom = Math.max(...row.map((l) => l.box.y + l.box.height));
    const left = Math.min(...row.map((l) => l.box.x));
    const right = Math.max(...row.map((l) => l.box.x + l.box.width));
    const from = rowIndex === 0 && ordered.length > 1 ? Math.max(left, first.x) : ordered.length === 1 ? Math.max(left, Math.min(start.x, end.x)) : left;
    const to = rowIndex === ordered.length - 1 && ordered.length > 1 ? Math.min(right, last.x) : ordered.length === 1 ? Math.min(right, Math.max(start.x, end.x)) : right;
    return to - from > 0.5 ? [{ x: from, y: rowTop, width: to - from, height: rowBottom - rowTop }] : [];
  });
}

const containsBox = (outer: Box, inner: Box): boolean => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

/**
 * The objects a rubber-band rectangle selects: added ones it touches, and things the page already draws only when it
 * holds them whole (a page is full of them, and touching one should not pick up the frame around it).
 */
export function marqueeSelect(objects: readonly EditorObject[], rect: Box): Id[] {
  return objects.filter((o) => (o.kind === "existing" ? !o.locked && containsBox(rect, boundsOf(o)) : boxesOverlap(boundsOf(o), rect))).map((o) => o.id);
}

/** The box that holds all the given objects (their turned bounds). */
export function selectionBounds(objects: readonly EditorObject[]): Box | null {
  return unionBoxes(objects.map(boundsOf));
}

/** Turns a box about a pivot (not its own centre), returning the new box and rotation: used when several objects turn together. */
export function rotateAbout(object: EditorObject, pivot: Pt, degrees: number): EditorObject {
  if (!isBoxObject(object)) return object;
  const frame = frameOf(object);
  const centre = rotatePoint({ x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 }, pivot, degrees);
  return { ...object, x: centre.x - frame.width / 2, y: centre.y - frame.height / 2, rotation: (((object.rotation + degrees) % 360) + 360) % 360 };
}
