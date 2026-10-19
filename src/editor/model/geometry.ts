import type { Box, EditorObject, Pt, Rotation } from "./types";

/**
 * Geometry for the editor. Three coordinate spaces are in play, and mixing them up is the classic source of editor
 * bugs, so each has a name here:
 *
 *  - **base**: the model's space. Points, origin top-left of the page as first displayed, y down.
 *  - **slot**: CSS pixels inside the page's slot on the screen, after the editor's quarter-turn rotation and the zoom.
 *  - **user**: the PDF's own space (bottom-left origin); converted in the export, not here.
 *
 * Everything below is pure and tested.
 */

export const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
export const normalizeDegrees = (degrees: number): number => ((degrees % 360) + 360) % 360;
export const round = (value: number, digits = 3): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function rotatePoint(point: Pt, centre: Pt, degrees: number): Pt {
  if (degrees === 0) return { x: point.x, y: point.y };
  const radians = toRadians(degrees);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - centre.x;
  const dy = point.y - centre.y;
  return { x: centre.x + dx * cos - dy * sin, y: centre.y + dx * sin + dy * cos };
}

export const centreOf = (box: Box): Pt => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/** The four corners of a box turned by `rotation` about its centre: top-left, top-right, bottom-right, bottom-left. */
export function corners(box: Box, rotation: number): [Pt, Pt, Pt, Pt] {
  const c = centreOf(box);
  return [
    rotatePoint({ x: box.x, y: box.y }, c, rotation),
    rotatePoint({ x: box.x + box.width, y: box.y }, c, rotation),
    rotatePoint({ x: box.x + box.width, y: box.y + box.height }, c, rotation),
    rotatePoint({ x: box.x, y: box.y + box.height }, c, rotation),
  ];
}

export function boundsOfPoints(points: readonly Pt[]): Box {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function unionBoxes(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  return boundsOfPoints(boxes.flatMap((b) => [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y + b.height }]));
}

export const boxesOverlap = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export const boxContains = (box: Box, point: Pt): boolean => point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;

export function boxFromCorners(a: Pt, b: Pt): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

// ---- objects ------------------------------------------------------------------------------------------------------------

/** Objects that are described by a box and a rotation (the rest are described by points). */
export type BoxObject = Extract<EditorObject, Box & { rotation: number }>;

export function isBoxObject(object: EditorObject): object is BoxObject {
  return "width" in object && "height" in object && "x" in object && !("quads" in object);
}

/** The frame of an object before rotation: a box for box objects, the bounds of the points for the others. */
export function frameOf(object: EditorObject): Box {
  switch (object.kind) {
    case "line": {
      const pad = object.strokeWidth / 2;
      return { x: Math.min(object.x1, object.x2) - pad, y: Math.min(object.y1, object.y2) - pad, width: Math.abs(object.x1 - object.x2) + object.strokeWidth, height: Math.abs(object.y1 - object.y2) + object.strokeWidth };
    }
    case "draw": {
      const b = boundsOfPoints(object.points.map(([x, y]) => ({ x, y })));
      const pad = object.strokeWidth / 2;
      return { x: b.x - pad, y: b.y - pad, width: b.width + object.strokeWidth, height: b.height + object.strokeWidth };
    }
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly":
      return unionBoxes(object.quads) ?? { x: 0, y: 0, width: 0, height: 0 };
    case "comment":
      return { x: object.x, y: object.y, width: 22, height: 22 };
    default:
      return { x: object.x, y: object.y, width: object.width, height: object.height };
  }
}

/** The smallest upright rectangle that contains the object, rotation included. */
export function boundsOf(object: EditorObject): Box {
  const frame = frameOf(object);
  const rotation = isBoxObject(object) ? object.rotation : 0;
  return rotation === 0 ? frame : boundsOfPoints(corners(frame, rotation));
}

function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function insidePolygon(point: Pt, polygon: readonly [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i] as [number, number];
    const b = polygon[j] as [number, number];
    if (a[1] > point.y !== b[1] > point.y && point.x < ((b[0] - a[0]) * (point.y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/**
 * Where a point of an existing object's original outline is now that the object has been moved, resized or turned: the
 * original box is carried onto the current one.
 */
export function carryPoint(object: Extract<EditorObject, { kind: "existing" }>, point: [number, number]): Pt {
  const from = object.origin;
  if (!object.edited) return { x: point[0], y: point[1] };
  const fromCentre = centreOf(from);
  const upright = rotatePoint({ x: point[0], y: point[1] }, fromCentre, -from.rotation);
  const scaled = {
    x: fromCentre.x + ((upright.x - fromCentre.x) * object.width) / Math.max(from.width, 1e-9),
    y: fromCentre.y + ((upright.y - fromCentre.y) * object.height) / Math.max(from.height, 1e-9),
  };
  const toCentre = centreOf(object);
  const moved = { x: scaled.x - fromCentre.x + toCentre.x, y: scaled.y - fromCentre.y + toCentre.y };
  return rotatePoint(moved, toCentre, object.rotation);
}

/** Is `point` on something the page already draws? Shapes are tested against their real outline, text against its lines. */
function hitsExisting(object: Extract<EditorObject, { kind: "existing" }>, point: Pt, tolerance: number): boolean {
  const pad = (box: Box, by: number): Box => ({ x: box.x - by, y: box.y - by, width: box.width + 2 * by, height: box.height + 2 * by });
  if (object.what === "text" && object.lines) return object.lines.some((line) => boxContains(pad(line.box, tolerance * 0.5), point));
  if (object.what === "shape" && object.outline && object.outline.length > 0) {
    for (const run of object.outline) {
      const points = run.points.map((p) => carryPoint(object, p));
      if (object.filled && (run.closed || points.length > 2) && insidePolygon(point, points.map((p) => [p.x, p.y] as [number, number]))) return true;
      const count = points.length;
      for (let i = 0; i < (run.closed ? count : count - 1); i += 1) {
        const from = points[i] as Pt;
        const to = points[(i + 1) % count] as Pt;
        if (distanceToSegment(point, from, to) <= tolerance) return true;
      }
    }
    return false;
  }
  const local = rotatePoint(point, centreOf(object), -object.rotation);
  if (object.what === "shape" && !object.filled && object.stroked && Math.min(object.width, object.height) > tolerance * 4) {
    // A frame with nothing inside (a box drawn as an outline) is picked up by its edge, not by its inside.
    return boxContains(pad(object, tolerance), local) && !boxContains(pad(object, -tolerance), local);
  }
  return boxContains(pad(object, tolerance), local);
}

/**
 * Is `point` on the object? `tolerance` is in base points (callers pass a few screen pixels divided by the zoom).
 * Unfilled shapes are hit on their outline only, so the page behind them can still be clicked.
 */
export function hits(object: EditorObject, point: Pt, tolerance: number): boolean {
  switch (object.kind) {
    case "existing":
      return hitsExisting(object, point, tolerance);
    case "line":
      return distanceToSegment(point, { x: object.x1, y: object.y1 }, { x: object.x2, y: object.y2 }) <= Math.max(tolerance, object.strokeWidth / 2 + tolerance / 2);
    case "draw": {
      const reach = Math.max(tolerance, object.strokeWidth / 2 + tolerance / 2);
      for (let i = 0; i < object.points.length; i += 1) {
        const a = object.points[i] as [number, number];
        const b = (object.points[i + 1] ?? a) as [number, number];
        if (distanceToSegment(point, { x: a[0], y: a[1] }, { x: b[0], y: b[1] }) <= reach) return true;
      }
      return false;
    }
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly":
      return object.quads.some((q) => boxContains({ x: q.x - tolerance, y: q.y - tolerance, width: q.width + 2 * tolerance, height: q.height + 2 * tolerance }, point));
    case "comment":
      return boxContains({ x: object.x - tolerance, y: object.y - tolerance, width: 22 + 2 * tolerance, height: 22 + 2 * tolerance }, point);
    case "rect":
    case "ellipse": {
      const local = rotatePoint(point, centreOf(object), -object.rotation);
      const outer = { x: object.x - tolerance, y: object.y - tolerance, width: object.width + 2 * tolerance, height: object.height + 2 * tolerance };
      if (!boxContains(outer, local)) return false;
      if (object.fill !== null) {
        if (object.kind === "rect") return true;
        const cx = object.x + object.width / 2;
        const cy = object.y + object.height / 2;
        const rx = object.width / 2 + tolerance;
        const ry = object.height / 2 + tolerance;
        return ((local.x - cx) / rx) ** 2 + ((local.y - cy) / ry) ** 2 <= 1;
      }
      // outline only
      const reach = Math.max(tolerance, object.strokeWidth / 2 + tolerance / 2);
      if (object.kind === "rect") {
        const inner = { x: object.x + reach, y: object.y + reach, width: object.width - 2 * reach, height: object.height - 2 * reach };
        return inner.width <= 0 || inner.height <= 0 || !boxContains(inner, local);
      }
      const cx = object.x + object.width / 2;
      const cy = object.y + object.height / 2;
      const rx = Math.max(1e-6, object.width / 2);
      const ry = Math.max(1e-6, object.height / 2);
      const radial = Math.hypot((local.x - cx) / rx, (local.y - cy) / ry);
      return Math.abs(radial - 1) * Math.min(rx, ry) <= reach;
    }
    default: {
      const rotation = isBoxObject(object) ? object.rotation : 0;
      const local = rotatePoint(point, centreOf(frameOf(object)), -rotation);
      const f = frameOf(object);
      return boxContains({ x: f.x - tolerance, y: f.y - tolerance, width: f.width + 2 * tolerance, height: f.height + 2 * tolerance }, local);
    }
  }
}

/** A copy of the object moved by (dx, dy). */
export function translate<T extends EditorObject>(object: T, dx: number, dy: number): T {
  switch (object.kind) {
    case "line":
      return { ...object, x1: object.x1 + dx, y1: object.y1 + dy, x2: object.x2 + dx, y2: object.y2 + dy };
    case "draw":
      return { ...object, points: object.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly":
      return { ...object, quads: object.quads.map((q) => ({ ...q, x: q.x + dx, y: q.y + dy })) };
    default:
      return { ...object, x: (object as Box).x + dx, y: (object as Box).y + dy };
  }
}

// ---- resizing -----------------------------------------------------------------------------------------------------------

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
export const CORNER_HANDLES: readonly Handle[] = ["nw", "ne", "se", "sw"];

/** Position of a handle on the (possibly rotated) box, in base points. */
export function handlePoint(box: Box, rotation: number, handle: Handle): Pt {
  const x = handle.includes("w") ? box.x : handle.includes("e") ? box.x + box.width : box.x + box.width / 2;
  const y = handle.includes("n") ? box.y : handle.includes("s") ? box.y + box.height : box.y + box.height / 2;
  return rotatePoint({ x, y }, centreOf(box), rotation);
}

const OPPOSITE: Record<Handle, Handle> = { nw: "se", n: "s", ne: "sw", e: "w", se: "nw", s: "n", sw: "ne", w: "e" };

export interface ResizeOptions {
  /** Keep the proportions (corner handles only). */
  keepAspect?: boolean;
  /** Grow from the centre instead of from the opposite side. */
  fromCentre?: boolean;
  minSize?: number;
}

/**
 * The box after dragging `handle` to `pointer`. The opposite corner or edge stays where it is on the page even when
 * the box is rotated, which is what makes dragging a handle of a turned box feel right.
 */
export function resizeFromHandle(box: Box, rotation: number, handle: Handle, pointer: Pt, options: ResizeOptions = {}): Box {
  const minSize = options.minSize ?? 4;
  const c = centreOf(box);
  const local = rotatePoint(pointer, c, -rotation); // the pointer in the box's own upright frame
  const horizontal = handle.includes("w") || handle.includes("e");
  const vertical = handle.includes("n") || handle.includes("s");
  const anchorHandle = OPPOSITE[handle];
  const anchor = options.fromCentre ? c : { x: anchorHandle.includes("w") ? box.x : anchorHandle.includes("e") ? box.x + box.width : c.x, y: anchorHandle.includes("n") ? box.y : anchorHandle.includes("s") ? box.y + box.height : c.y };

  let width = box.width;
  let height = box.height;
  if (horizontal) width = Math.max(minSize, options.fromCentre ? 2 * Math.abs(local.x - c.x) : Math.abs(local.x - anchor.x));
  if (vertical) height = Math.max(minSize, options.fromCentre ? 2 * Math.abs(local.y - c.y) : Math.abs(local.y - anchor.y));
  if (options.keepAspect && horizontal && vertical) {
    const aspect = box.width / Math.max(box.height, 1e-9);
    if (width / aspect > height) height = width / aspect;
    else width = height * aspect;
  }

  // Which side of the anchor the box extends to: wherever the pointer is, so dragging past the anchor flips the box over.
  const sx = horizontal ? (local.x >= anchor.x ? 1 : -1) : 0;
  const sy = vertical ? (local.y >= anchor.y ? 1 : -1) : 0;
  let left: number;
  let top: number;
  if (options.fromCentre) {
    left = anchor.x - width / 2;
    top = anchor.y - height / 2;
  } else {
    left = horizontal ? (sx > 0 ? anchor.x : anchor.x - width) : box.x;
    top = vertical ? (sy > 0 ? anchor.y : anchor.y - height) : box.y;
    if (!horizontal) width = box.width;
    if (!vertical) height = box.height;
  }
  // The new box is expressed in the old upright frame; turn its centre back into page space.
  const newCentreLocal = { x: left + width / 2, y: top + height / 2 };
  const newCentre = rotatePoint(newCentreLocal, c, rotation);
  return { x: newCentre.x - width / 2, y: newCentre.y - height / 2, width, height };
}

/** Rotation angle (degrees, clockwise) that points the top of a box at `pointer`, optionally snapped to steps. */
export function rotationToward(centre: Pt, pointer: Pt, step = 0): number {
  const degrees = (Math.atan2(pointer.y - centre.y, pointer.x - centre.x) * 180) / Math.PI + 90;
  const normal = normalizeDegrees(degrees);
  return step > 0 ? normalizeDegrees(Math.round(normal / step) * step) : normal;
}

// ---- snapping -----------------------------------------------------------------------------------------------------------

export interface Guide {
  axis: "x" | "y";
  /** Where the guide is, in base points. */
  position: number;
  from: number;
  to: number;
}

export interface Snap {
  dx: number;
  dy: number;
  guides: Guide[];
}

/**
 * Moves a box (by the offset the pointer asked for) onto nearby alignment lines: the page's edges and centre and the
 * edges and centres of other objects. Returns the correction to apply and the guides to show.
 */
export function snapBox(moving: Box, others: readonly Box[], page: { width: number; height: number }, threshold: number): Snap {
  const xs = [moving.x, moving.x + moving.width / 2, moving.x + moving.width];
  const ys = [moving.y, moving.y + moving.height / 2, moving.y + moving.height];
  const targetsX: { at: number; box: Box | null }[] = [{ at: 0, box: null }, { at: page.width / 2, box: null }, { at: page.width, box: null }];
  const targetsY: { at: number; box: Box | null }[] = [{ at: 0, box: null }, { at: page.height / 2, box: null }, { at: page.height, box: null }];
  for (const other of others) {
    for (const at of [other.x, other.x + other.width / 2, other.x + other.width]) targetsX.push({ at, box: other });
    for (const at of [other.y, other.y + other.height / 2, other.y + other.height]) targetsY.push({ at, box: other });
  }
  let bestX: { delta: number; target: { at: number; box: Box | null } } | null = null;
  for (const x of xs) for (const target of targetsX) {
    const delta = target.at - x;
    if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) bestX = { delta, target };
  }
  let bestY: { delta: number; target: { at: number; box: Box | null } } | null = null;
  for (const y of ys) for (const target of targetsY) {
    const delta = target.at - y;
    if (Math.abs(delta) <= threshold && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) bestY = { delta, target };
  }
  const dx = bestX?.delta ?? 0;
  const dy = bestY?.delta ?? 0;
  const snapped: Box = { ...moving, x: moving.x + dx, y: moving.y + dy };
  const guides: Guide[] = [];
  if (bestX) {
    const other = bestX.target.box;
    guides.push({ axis: "x", position: bestX.target.at, from: Math.min(snapped.y, other?.y ?? 0), to: Math.max(snapped.y + snapped.height, other ? other.y + other.height : page.height) });
  }
  if (bestY) {
    const other = bestY.target.box;
    guides.push({ axis: "y", position: bestY.target.at, from: Math.min(snapped.x, other?.x ?? 0), to: Math.max(snapped.x + snapped.width, other ? other.x + other.width : page.width) });
  }
  return { dx, dy, guides };
}

// ---- alignment ------------------------------------------------------------------------------------------------------

export type Alignment = "left" | "centre" | "right" | "top" | "middle" | "bottom";

/** The shift each box needs to line up with `frame` (the page, or the box that holds the selection). */
export function alignWithin(boxes: readonly Box[], how: Alignment, frame: Box): { dx: number; dy: number }[] {
  return boxes.map((b) => {
    switch (how) {
      case "left":
        return { dx: frame.x - b.x, dy: 0 };
      case "right":
        return { dx: frame.x + frame.width - (b.x + b.width), dy: 0 };
      case "centre":
        return { dx: frame.x + frame.width / 2 - (b.x + b.width / 2), dy: 0 };
      case "top":
        return { dx: 0, dy: frame.y - b.y };
      case "bottom":
        return { dx: 0, dy: frame.y + frame.height - (b.y + b.height) };
      case "middle":
        return { dx: 0, dy: frame.y + frame.height / 2 - (b.y + b.height / 2) };
    }
  });
}

/** The shift each object needs to line up with the others (or with the page when only one is given). */
export function alignmentShifts(boxes: readonly Box[], how: Alignment, page?: { width: number; height: number }): { dx: number; dy: number }[] {
  const frame = boxes.length > 1 || !page ? (unionBoxes(boxes) as Box) : { x: 0, y: 0, width: page.width, height: page.height };
  return boxes.map((b) => {
    switch (how) {
      case "left":
        return { dx: frame.x - b.x, dy: 0 };
      case "right":
        return { dx: frame.x + frame.width - (b.x + b.width), dy: 0 };
      case "centre":
        return { dx: frame.x + frame.width / 2 - (b.x + b.width / 2), dy: 0 };
      case "top":
        return { dx: 0, dy: frame.y - b.y };
      case "bottom":
        return { dx: 0, dy: frame.y + frame.height - (b.y + b.height) };
      case "middle":
        return { dx: 0, dy: frame.y + frame.height / 2 - (b.y + b.height / 2) };
    }
  });
}

/** Spreads three or more boxes so the gaps between them are equal along one axis. Returns shifts in input order. */
export function distributeShifts(boxes: readonly Box[], axis: "x" | "y"): { dx: number; dy: number }[] {
  const order = boxes.map((b, i) => ({ b, i })).sort((p, q) => (axis === "x" ? p.b.x - q.b.x : p.b.y - q.b.y));
  const out = boxes.map(() => ({ dx: 0, dy: 0 }));
  if (boxes.length < 3) return out;
  const first = order[0] as { b: Box; i: number };
  const last = order[order.length - 1] as { b: Box; i: number };
  const size = (b: Box) => (axis === "x" ? b.width : b.height);
  const start = (b: Box) => (axis === "x" ? b.x : b.y);
  const total = start(last.b) + size(last.b) - start(first.b);
  const gap = (total - order.reduce((sum, e) => sum + size(e.b), 0)) / (order.length - 1);
  let at = start(first.b) + size(first.b) + gap;
  for (let k = 1; k < order.length - 1; k += 1) {
    const entry = order[k] as { b: Box; i: number };
    const shift = at - start(entry.b);
    out[entry.i] = axis === "x" ? { dx: shift, dy: 0 } : { dx: 0, dy: shift };
    at += size(entry.b) + gap;
  }
  return out;
}

// ---- the page on the screen -----------------------------------------------------------------------------------------

/** Size of a page's slot on the screen, in CSS pixels, for a base size, a zoom and the editor's rotation. */
export function slotSize(width: number, height: number, zoom: number, rotation: Rotation): { width: number; height: number } {
  const swapped = rotation === 90 || rotation === 270;
  return { width: (swapped ? height : width) * zoom, height: (swapped ? width : height) * zoom };
}

/** The CSS transform that turns the upright stage into its rotated place inside the slot. */
export function stageTransform(width: number, height: number, zoom: number, rotation: Rotation): string {
  switch (rotation) {
    case 90:
      return `translate(${height * zoom}px, 0) rotate(90deg)`;
    case 180:
      return `translate(${width * zoom}px, ${height * zoom}px) rotate(180deg)`;
    case 270:
      return `translate(0, ${width * zoom}px) rotate(270deg)`;
    default:
      return "none";
  }
}

/** A point inside the slot (CSS pixels from its top-left) as a point on the upright page (base points). */
export function slotToBase(point: Pt, width: number, height: number, zoom: number, rotation: Rotation): Pt {
  const x = point.x / zoom;
  const y = point.y / zoom;
  switch (rotation) {
    case 90:
      return { x: y, y: height - x };
    case 180:
      return { x: width - x, y: height - y };
    case 270:
      return { x: width - y, y: x };
    default:
      return { x, y };
  }
}

/** The reverse of `slotToBase`. */
export function baseToSlot(point: Pt, width: number, height: number, zoom: number, rotation: Rotation): Pt {
  switch (rotation) {
    case 90:
      return { x: (height - point.y) * zoom, y: point.x * zoom };
    case 180:
      return { x: (width - point.x) * zoom, y: (height - point.y) * zoom };
    case 270:
      return { x: point.y * zoom, y: (width - point.x) * zoom };
    default:
      return { x: point.x * zoom, y: point.y * zoom };
  }
}

/** Zoom that fits a page of a given size into an area, leaving `margin` pixels around it. */
export function fitZoom(area: { width: number; height: number }, page: { width: number; height: number }, mode: "page" | "width", margin = 24): number {
  const w = Math.max(1, area.width - margin * 2) / page.width;
  const h = Math.max(1, area.height - margin * 2) / page.height;
  return clamp(mode === "width" ? w : Math.min(w, h), MIN_ZOOM, MAX_ZOOM);
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
export const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8] as const;

/** The next preset zoom above or below `zoom`. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((s) => s > zoom + 1e-6) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((s) => s < zoom - 1e-6) ?? MIN_ZOOM;
}
