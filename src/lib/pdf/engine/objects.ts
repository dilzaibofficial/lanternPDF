import { PDFArray, PDFDict, type PDFDocument, PDFHexString, PDFName, PDFNumber, type PDFPage, PDFRef, PDFString } from "@cantoo/pdf-lib";
import type { PageFrame } from "../draw";
import type { FormUse, ImageUse, Interpretation, PathUse, Subpath } from "./interpret";
import { type Matrix, type Rect, invert, multiply } from "./matrix";
import type { Splice } from "./splice";
import { type DisplayBox, type OrientedBox, boundsOfOriented, boxToDisplay, boxTransform, orientedBoxOf, toUserTransform, userRectOf, userToDisplay } from "./space";
import { type ContentSource, parseSource } from "./streams";
import { formatNumber } from "./tokenizer";

/**
 * The things a page draws that are not text: images, painted shapes and annotations. They can be listed (for the editor
 * to select), moved, resized, turned, removed and put above or below each other.
 *
 * Moving something does not touch what it draws. The operators that draw it are wrapped in `q <matrix> cm … Q`, where the
 * matrix is the move expressed in the coordinate system the operators were written in. Removing it deletes those
 * operators (and the picture itself when nothing else uses it). Changing its place in the stacking order moves the
 * operators to the new place together with the graphics state they were drawn in.
 */

export type ObjectKind = "image" | "shape" | "annotation";

export interface OutlineRun {
  points: [number, number][];
  closed: boolean;
}

export interface AnalyzedObject {
  /** Stable for a page: the id of the operator that draws it (images, shapes) or `annot:<index>`. */
  id: string;
  kind: ObjectKind;
  /** What to call it: "Image", "Triangle", "Highlight"… */
  label: string;
  /** Where it is, in display space. */
  box: OrientedBox;
  /** Axis-aligned bounds of `box`. */
  bounds: DisplayBox;
  /** Position in the stacking order of the page: later is on top. */
  order: number;
  /** The real outline of a shape, when simple enough to keep, in display space. */
  outline: OutlineRun[] | null;
  fill: boolean;
  stroke: boolean;
  pixelWidth: number | null;
  pixelHeight: number | null;
  /** Annotation type, such as "Highlight" or "FreeText". */
  subtype: string | null;
  contents: string | null;
  canMove: boolean;
  canResize: boolean;
  canRotate: boolean;
  /** Whether its place in the stacking order can be changed. */
  canReorder: boolean;
  /** Why it cannot be changed, when it cannot. */
  reason: string | null;
  /** A fill that covers (nearly) the whole page: the page's own background, which is not something to pick up with a click. */
  background: boolean;
}

export type OrderTarget = "front" | "back" | { after: string } | { before: string };

/** What to do with one object. Lines of text use `move` (a shift in display space); the rest use `target` (where the box should end up). */
export interface ObjectEdit {
  id: string;
  delete?: boolean;
  target?: OrientedBox;
  move?: { dx: number; dy: number };
  order?: OrderTarget;
}

export interface ObjectOutcome {
  id: string;
  status: "applied" | "unchanged" | "refused";
  reason?: string;
}

const ANNOTATION_LABELS: Record<string, string> = {
  Text: "Note",
  FreeText: "Text box",
  Square: "Rectangle",
  Circle: "Ellipse",
  Line: "Line",
  Polygon: "Polygon",
  PolyLine: "Polyline",
  Ink: "Drawing",
  Highlight: "Highlight",
  Underline: "Underline",
  StrikeOut: "Strikeout",
  Squiggly: "Squiggly underline",
  Stamp: "Stamp",
  Caret: "Caret",
  FileAttachment: "Attachment",
  Redact: "Redaction mark",
};

/** Annotation types that are not objects on the page: links and form fields have their own places in the editor. */
const NOT_OBJECTS = new Set(["Link", "Widget", "Popup", "Movie", "Sound", "Screen", "3D", "RichMedia", "TrapNet", "PrinterMark"]);

/** Annotation types whose whole geometry is the Rect and the arrays below, so moving them is safe. */
const MOVABLE_ANNOTATIONS = new Set(["Text", "FreeText", "Square", "Circle", "Line", "Polygon", "PolyLine", "Ink", "Highlight", "Underline", "StrikeOut", "Squiggly", "Stamp", "Caret", "FileAttachment"]);
/** Annotation types that can also change size (their appearance scales with the Rect). */
const RESIZABLE_ANNOTATIONS = new Set(["FreeText", "Square", "Circle", "Stamp"]);
const POINT_ARRAYS = ["QuadPoints", "Vertices", "L", "CL", "InkList"] as const;

const N = {
  Annots: PDFName.of("Annots"),
  Subtype: PDFName.of("Subtype"),
  Rect: PDFName.of("Rect"),
  Parent: PDFName.of("Parent"),
  Popup: PDFName.of("Popup"),
  Contents: PDFName.of("Contents"),
  XObject: PDFName.of("XObject"),
  Resources: PDFName.of("Resources"),
};

const MAX_IMAGES = 200;
const MAX_SHAPES = 400;
const MAX_ANNOTATIONS = 2000;
/** Items painted after everything the page draws itself. */
const ANNOTATION_ORDER = 1_000_000;

// ---- listing -----------------------------------------------------------------------------------------------------------

function usesOfForms(forms: readonly FormUse[]): Map<string, number> {
  const uses = new Map<string, number>();
  for (const form of forms) if (form.ref) uses.set(form.ref.toString(), (uses.get(form.ref.toString()) ?? 0) + 1);
  return uses;
}

/** Why an item drawn by `source` cannot be changed, or null. */
function whyLocked(source: ContentSource, depth: number, uses: ReadonlyMap<string, number>, allowRepeatedForms: boolean): string | null {
  if (source.unreadable > 0 || source.tooLarge) return "Its content could not be read completely.";
  if (source.kind === "page") return null;
  if (depth > 1) return "This item is inside blocks nested several levels deep, which the editor does not rewrite.";
  const count = uses.get(source.parts[0]?.ref?.toString() ?? "") ?? 1;
  if (count > 1 && !allowRepeatedForms) return `This item belongs to a reusable block that the page draws ${count} times. Changing it would change all of them.`;
  return null;
}

/** "Triangle", "Rectangle", "Line"… from the operators a path was built with and its outline. */
export function classifyPath(built: string, outline: readonly Subpath[] | null): string {
  const parts = built.split(" ").filter(Boolean);
  const curves = parts.filter((p) => p === "c").length;
  const lines = parts.filter((p) => p === "l").length;
  // A lone moveto (some producers write one twice) is not a shape of its own.
  const runs = (outline ?? []).filter((run) => run.points.length >= 2);
  if (!outline) {
    if (parts.length === 1 && parts[0] === "re") return "Rectangle";
    return "Shape";
  }
  if (runs.length !== 1) return "Shape";
  const run = runs[0] as Subpath;
  // Closing a path by repeating its first point does not add a corner.
  const first = run.points[0] as [number, number];
  const lastPoint = run.points[run.points.length - 1] as [number, number];
  const repeated = run.closed && run.points.length > 1 && Math.hypot(first[0] - lastPoint[0], first[1] - lastPoint[1]) < 1e-6;
  const corners = run.points.length - (repeated ? 1 : 0);
  if (curves === 0) {
    if (!run.closed) return corners === 2 ? "Line" : "Polyline";
    if (corners === 3) return "Triangle";
    if (corners === 4) return isAxisAlignedRectangle(run.points.slice(0, 4)) ? "Rectangle" : "Quadrilateral";
    return "Polygon";
  }
  if (curves >= 4 && run.closed && lines === 0) return "Ellipse";
  return run.closed ? "Shape" : "Curve";
}

function isAxisAlignedRectangle(points: readonly [number, number][] | undefined): boolean {
  if (!points || points.length !== 4) return false;
  const [a, b, c, d] = points as [[number, number], [number, number], [number, number], [number, number]];
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-6 * (1 + Math.abs(x));
  return (near(a[0], b[0]) && near(b[1], c[1]) && near(c[0], d[0]) && near(d[1], a[1])) || (near(a[1], b[1]) && near(b[0], c[0]) && near(c[1], d[1]) && near(d[0], a[0]));
}

function outlineToDisplay(frame: PageFrame, outline: readonly Subpath[] | null): OutlineRun[] | null {
  const runs = (outline ?? []).filter((run) => run.points.length >= 2);
  if (runs.length === 0) return null;
  const map = userToDisplay(frame);
  return runs.map((run) => ({ points: run.points.map(([x, y]) => map(x, y)), closed: run.closed }));
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const roundBox = (box: OrientedBox): OrientedBox => ({ x: round3(box.x), y: round3(box.y), width: round3(box.width), height: round3(box.height), rotation: round3(box.rotation) });
const roundBounds = (box: DisplayBox): DisplayBox => ({ x: round3(box.x), y: round3(box.y), width: round3(box.width), height: round3(box.height) });

function numberAt(array: PDFArray, index: number): number {
  const value = array.lookup(index);
  return value instanceof PDFNumber ? value.asNumber() : Number.NaN;
}

function rectOf(annotation: PDFDict): Rect | null {
  const rect = annotation.lookupMaybe(N.Rect, PDFArray);
  if (!rect || rect.size() < 4) return null;
  const [x1, y1, x2, y2] = [0, 1, 2, 3].map((i) => numberAt(rect, i)) as [number, number, number, number];
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

const textOf = (value: unknown): string | null => (value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : null);

/** The page's annotations that count as objects, with their index in `/Annots`. */
export function annotationObjects(page: PDFPage): { index: number; dict: PDFDict; subtype: string }[] {
  const list = page.node.lookupMaybe(N.Annots, PDFArray);
  const out: { index: number; dict: PDFDict; subtype: string }[] = [];
  if (!list) return out;
  for (let i = 0; i < Math.min(list.size(), MAX_ANNOTATIONS); i += 1) {
    const dict = list.lookupMaybe(i, PDFDict);
    if (!dict) continue;
    const subtype = (dict.lookup(N.Subtype) as PDFName | undefined)?.decodeText() ?? "Unknown";
    if (NOT_OBJECTS.has(subtype)) continue;
    out.push({ index: i, dict, subtype });
  }
  return out;
}

export interface ListOptions {
  /** Edit things inside a block the page draws more than once. */
  allowRepeatedForms?: boolean;
}

/** Everything on the page that is an object in the editor's sense: images, painted shapes and annotations. */
export function listObjects(page: PDFPage, frame: PageFrame, interpretation: Interpretation, options: ListOptions = {}): AnalyzedObject[] {
  const uses = usesOfForms(interpretation.forms);
  const pageArea = frame.displayWidth * frame.displayHeight;
  const out: AnalyzedObject[] = [];

  for (const image of interpretation.images.slice(0, MAX_IMAGES)) {
    const box = orientedBoxOf(frame, image.matrix);
    if (box.width < 0.01 || box.height < 0.01) continue;
    const reason = whyLocked(image.source, image.depth, uses, options.allowRepeatedForms ?? false);
    out.push({
      id: image.id,
      kind: "image",
      label: "Image",
      box: roundBox(box),
      bounds: roundBounds(boundsOfOriented(box)),
      order: image.seq,
      outline: null,
      fill: false,
      stroke: false,
      pixelWidth: image.pixelWidth,
      pixelHeight: image.pixelHeight,
      subtype: null,
      contents: null,
      canMove: reason === null,
      canResize: reason === null,
      canRotate: reason === null,
      canReorder: reason === null && !insideLayer(image.source, image.opIndex),
      reason,
      background: false,
    });
  }

  const shapes: { path: PathUse; box: DisplayBox; area: number }[] = [];
  for (const path of interpretation.paths) {
    if (path.clipped) continue;
    const box = boxToDisplay(frame, path.box);
    if (box.width < 0.05 && box.height < 0.05) continue;
    const area = box.width * box.height;
    shapes.push({ path, box, area });
  }
  // When there are more shapes than can be kept, the largest are kept.
  const kept = shapes.length > MAX_SHAPES ? [...shapes].sort((a, b) => b.area - a.area).slice(0, MAX_SHAPES) : shapes;
  for (const { path, box } of kept) {
    const reason = whyLocked(path.source, path.depth, uses, options.allowRepeatedForms ?? false);
    const background = path.fill && box.width * box.height >= pageArea * 0.9;
    const label = background ? "Page background" : classifyPath(path.built, path.outline);
    const oriented: OrientedBox = { ...box, rotation: 0 };
    out.push({
      id: path.id,
      kind: "shape",
      label,
      box: roundBox(oriented),
      bounds: roundBounds(box),
      order: path.seq,
      outline: outlineToDisplay(frame, path.outline)?.map((run) => ({ points: run.points.map(([x, y]) => [round3(x), round3(y)] as [number, number]), closed: run.closed })) ?? null,
      fill: path.fill,
      stroke: path.stroke,
      pixelWidth: null,
      pixelHeight: null,
      subtype: null,
      contents: null,
      canMove: reason === null,
      canResize: reason === null,
      canRotate: reason === null,
      canReorder: reason === null && !insideLayer(path.source, path.startOp),
      reason,
      background,
    });
  }

  for (const { index, dict, subtype } of annotationObjects(page)) {
    const rect = rectOf(dict);
    if (!rect) continue;
    const box = boxToDisplay(frame, rect);
    const movable = MOVABLE_ANNOTATIONS.has(subtype);
    out.push({
      id: `annot:${index}`,
      kind: "annotation",
      label: ANNOTATION_LABELS[subtype] ?? "Annotation",
      box: roundBox({ ...box, rotation: 0 }),
      bounds: roundBounds(box),
      order: ANNOTATION_ORDER + index,
      outline: null,
      fill: false,
      stroke: false,
      pixelWidth: null,
      pixelHeight: null,
      subtype,
      contents: textOf(dict.lookup(N.Contents)),
      canMove: movable,
      canResize: RESIZABLE_ANNOTATIONS.has(subtype),
      canRotate: false,
      canReorder: false,
      reason: movable ? null : "This kind of annotation can be removed but not moved.",
      background: false,
    });
  }
  return out;
}

// ---- the graphics state an object was drawn in -------------------------------------------------------------------------------

const STATE_OPS = new Set(["cm", "w", "J", "j", "M", "d", "ri", "i", "gs", "g", "G", "rg", "RG", "k", "K", "cs", "CS", "sc", "scn", "SC", "SCN"]);
const PATH_OPS = new Set(["m", "l", "c", "v", "y", "h", "re"]);
const PAINT_OPS = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*"]);

export const latin1 = (data: Uint8Array, start: number, end: number): string => {
  let text = "";
  for (let i = start; i < end; i += 1) text += String.fromCharCode(data[i] as number);
  return text;
};

export interface ReplayedState {
  /** The state operators in force at the outermost level of the stream (they stay in force for the rest of the stream). */
  base: string[];
  /** The state operators of the `q` levels that are open there, outermost first. */
  nested: string[];
  /** How many `q` levels are open. */
  depth: number;
}

/**
 * The operators that set up the graphics state before operator `opIndex`: every colour, line style, transformation and
 * clip still in force there, as text that can be written in front of the operators to draw them somewhere else in the
 * stream. Null when the place is inside an optional-content layer (which would be lost by moving things out of it).
 */
export function replayContext(source: ContentSource, opIndex: number): ReplayedState | null {
  const ops = parseSource(source).ops;
  const stack: string[][] = [[]];
  let path: string[] = [];
  let clip = false;
  const layers: boolean[] = [];
  for (let i = 0; i < Math.min(opIndex, ops.length); i += 1) {
    const op = ops[i] as (typeof ops)[number];
    const text = latin1(source.data, op.start, op.end);
    if (op.op === "q") stack.push([]);
    else if (op.op === "Q") {
      if (stack.length > 1) stack.pop();
    } else if (STATE_OPS.has(op.op)) (stack[stack.length - 1] as string[]).push(text);
    else if (PATH_OPS.has(op.op)) path.push(text);
    else if (op.op === "W" || op.op === "W*") {
      clip = true;
      path.push(text);
    } else if (op.op === "n" || PAINT_OPS.has(op.op)) {
      // A clip lives on after the path is painted or dropped; replay it without painting anything.
      if (clip) (stack[stack.length - 1] as string[]).push(`${path.join(" ")} n`);
      path = [];
      clip = false;
    } else if (op.op === "BDC" || op.op === "BMC") {
      const tag = op.args[0];
      layers.push(op.op === "BDC" && tag?.t === "name" && tag.v === "OC");
    } else if (op.op === "EMC") layers.pop();
  }
  if (layers.some(Boolean)) return null;
  return { base: stack[0] as string[], nested: stack.slice(1).flat(), depth: stack.length - 1 };
}

/** How many `q` levels are open before each operator (and after the last one). */
const depthCache = new WeakMap<ContentSource, number[]>();
function depthsOf(source: ContentSource): number[] {
  const cached = depthCache.get(source);
  if (cached) return cached;
  const ops = parseSource(source).ops;
  const depths: number[] = [];
  let depth = 0;
  for (const op of ops) {
    depths.push(depth);
    if (op.op === "q") depth += 1;
    else if (op.op === "Q" && depth > 0) depth -= 1;
  }
  depths.push(depth);
  depthCache.set(source, depths);
  return depths;
}

const layerCache = new WeakMap<ContentSource, [number, number][]>();

/** The operator ranges of the stream that are optional-content layers (`/OC … BDC` to its `EMC`). */
function layerRanges(source: ContentSource): [number, number][] {
  const cached = layerCache.get(source);
  if (cached) return cached;
  const ranges: [number, number][] = [];
  const open: { start: number; layer: boolean }[] = [];
  const ops = parseSource(source).ops;
  ops.forEach((op, index) => {
    if (op.op === "BDC" || op.op === "BMC") {
      const tag = op.args[0];
      open.push({ start: index, layer: op.op === "BDC" && tag?.t === "name" && tag.v === "OC" });
    } else if (op.op === "EMC") {
      const done = open.pop();
      if (done?.layer) ranges.push([done.start, index]);
    }
  });
  for (const left of open) if (left.layer) ranges.push([left.start, ops.length]);
  layerCache.set(source, ranges);
  return ranges;
}

const insideLayer = (source: ContentSource, opIndex: number): boolean => layerRanges(source).some(([start, end]) => opIndex > start && opIndex < end);

// ---- planning -----------------------------------------------------------------------------------------------------------------

export interface PlanObjectsInput {
  page: PDFPage;
  frame: PageFrame;
  interpretation: Interpretation;
  edits: readonly ObjectEdit[];
  allowRepeatedForms: boolean;
}

export interface PlanObjectsResult {
  /** Replacements to make, by the stream they are in. */
  splices: Map<ContentSource, Splice[]>;
  outcomes: ObjectOutcome[];
  /** Pictures whose drawing operators were removed, by stream (name → the edit that removed it): their resource entries go when nothing else draws them. */
  removedImages: Map<ContentSource, Map<string, string>>;
  /** Changes to annotations, to be made on the page. */
  annotations: AnnotationChange[];
}

export interface AnnotationChange {
  index: number;
  delete?: boolean;
  /** New rectangle in user space. */
  rect?: Rect;
}

const sameBox = (a: OrientedBox, b: OrientedBox) => Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3 && Math.abs(a.width - b.width) < 1e-3 && Math.abs(a.height - b.height) < 1e-3 && Math.abs(a.rotation - b.rotation) < 1e-3;

const matrixText = (m: Matrix): string => m.map((v) => formatNumber(Math.round(v * 1e6) / 1e6)).join(" ");

/** The local matrix `L` with `L × C = C × A`: drawing under `L cm` puts everything where it would be if `A` were applied to the page afterwards. */
function localMove(ctm: Matrix, userTransform: Matrix): Matrix | null {
  const inverse = invert(ctm);
  if (!inverse) return null;
  return multiply(multiply(ctm, userTransform), inverse);
}

interface Placed {
  id: string;
  kind: "image" | "shape";
  source: ContentSource;
  startOp: number;
  endOp: number;
  ctm: Matrix;
  depth: number;
  box: OrientedBox;
  seq: number;
  imageName: string | null;
}

function placedItems(frame: PageFrame, interpretation: Interpretation): Map<string, Placed> {
  const out = new Map<string, Placed>();
  for (const image of interpretation.images as readonly ImageUse[]) {
    out.set(image.id, { id: image.id, kind: "image", source: image.source, startOp: image.opIndex, endOp: image.opIndex, ctm: image.matrix, depth: image.depth, box: orientedBoxOf(frame, image.matrix), seq: image.seq, imageName: image.inline ? null : image.name });
  }
  for (const path of interpretation.paths) {
    if (path.clipped) continue;
    out.set(path.id, { id: path.id, kind: "shape", source: path.source, startOp: path.startOp, endOp: path.endOp, ctm: path.ctm, depth: path.depth, box: { ...boxToDisplay(frame, path.box), rotation: 0 }, seq: path.seq, imageName: null });
  }
  return out;
}

/**
 * Plans the edits of images, shapes and annotations. Edits that cannot be made come back as refused, with the reason,
 * and change nothing.
 */
export function planObjectEdits(input: PlanObjectsInput): PlanObjectsResult {
  const { page, frame, interpretation, edits } = input;
  const result: PlanObjectsResult = { splices: new Map(), outcomes: [], removedImages: new Map(), annotations: [] };
  const uses = usesOfForms(interpretation.forms);
  const items = placedItems(frame, interpretation);
  const annotations = new Map(annotationObjects(page).map((a) => [`annot:${a.index}`, a]));
  const add = (source: ContentSource, splice: Splice, owner: string) => {
    const list = result.splices.get(source) ?? [];
    list.push({ ...splice, owner });
    result.splices.set(source, list);
  };
  const outcome = (id: string, status: ObjectOutcome["status"], reason?: string) => result.outcomes.push({ id, status, reason });

  // The first and last thing each stream paints (text included), to know whether an item is already at the back or front.
  const extent = new Map<ContentSource, { first: number; last: number }>();
  const note = (source: ContentSource, seq: number) => {
    const known = extent.get(source);
    if (!known) extent.set(source, { first: seq, last: seq });
    else {
      known.first = Math.min(known.first, seq);
      known.last = Math.max(known.last, seq);
    }
  };
  for (const run of interpretation.runs) note(run.source, run.seq);
  for (const item of items.values()) note(item.source, item.seq);

  // Items are handled in paint order, so several sent to the back or front keep their order among themselves.
  const ordered = [...edits].sort((a, b) => (items.get(a.id)?.seq ?? Number.MAX_SAFE_INTEGER) - (items.get(b.id)?.seq ?? Number.MAX_SAFE_INTEGER));

  for (const edit of ordered) {
    const annotation = annotations.get(edit.id);
    if (annotation) {
      planAnnotation(frame, annotation, edit, result, outcome);
      continue;
    }
    const item = items.get(edit.id);
    if (!item) {
      outcome(edit.id, "refused", "That item is no longer on the page.");
      continue;
    }
    const locked = whyLocked(item.source, item.depth, uses, input.allowRepeatedForms);
    if (locked) {
      outcome(edit.id, "refused", locked);
      continue;
    }
    const ops = parseSource(item.source).ops;
    const first = ops[item.startOp];
    const last = ops[item.endOp];
    if (!first || !last) {
      outcome(edit.id, "refused", "Its drawing operators could not be found.");
      continue;
    }
    const data = item.source.data;
    const objectText = latin1(data, first.start, last.end);

    if (edit.delete) {
      add(item.source, { start: first.start, end: last.end, text: " " }, edit.id);
      if (item.imageName) {
        const names = result.removedImages.get(item.source) ?? new Map<string, string>();
        names.set(item.imageName, edit.id);
        result.removedImages.set(item.source, names);
      }
      outcome(edit.id, "applied");
      continue;
    }

    let wrapped = objectText;
    let transformed = false;
    if (edit.target && !sameBox(edit.target, item.box)) {
      const displayTransform = boxTransform(item.box, edit.target);
      const userTransform = displayTransform ? toUserTransform(frame, displayTransform) : null;
      const local = userTransform ? localMove(item.ctm, userTransform) : null;
      if (!local || !local.every(Number.isFinite)) {
        outcome(edit.id, "refused", "This item cannot be moved or resized (its placement has no size).");
        continue;
      }
      wrapped = `q ${matrixText(local)} cm ${objectText} Q`;
      transformed = true;
    }

    if (edit.order) {
      const destination = destinationOf(edit.order, item, items, extent.get(item.source));
      if (destination === "refused") {
        outcome(edit.id, "refused", "Its place in the stacking order cannot be changed here.");
        continue;
      }
      const context = replayContext(item.source, item.startOp);
      if (context === null) {
        outcome(edit.id, "refused", "It belongs to an optional-content layer, so it cannot be moved out of it.");
        continue;
      }
      if (destination) {
        // What is in force at the new place is part of the stream's own outermost state; only what differs is written out.
        const there = replayContext(item.source, destination.boundary);
        const common = there ? there.base.length : 0;
        if (!there || there.base.some((text, i) => text !== context.base[i])) {
          outcome(edit.id, "refused", "The page changes its coordinate system or colours partway through, so this item cannot be moved in the stacking order.");
          continue;
        }
        const block = `q\n${[...context.base.slice(common), ...context.nested].join("\n")}\n${wrapped}\nQ\n`;
        add(item.source, { start: first.start, end: last.end, text: " " }, edit.id);
        add(item.source, { start: destination.at, end: destination.at, text: `\n${destination.closeLevels > 0 ? "Q\n".repeat(destination.closeLevels) : ""}${block}` }, edit.id);
        outcome(edit.id, "applied");
        continue;
      }
    }

    if (transformed) {
      add(item.source, { start: first.start, end: last.end, text: ` ${wrapped} ` }, edit.id);
      outcome(edit.id, "applied");
    } else {
      outcome(edit.id, "unchanged");
    }
  }
  return result;
}

interface Destination {
  /** Byte offset in the stream. */
  at: number;
  /** The place as an operator boundary: the state there is what `replayContext` gives for this index. */
  boundary: number;
  /** `Q` operators to write first, for a stream that leaves levels open at its end. */
  closeLevels: number;
}

/**
 * Where in the stream the operators go for an order target; null when they are already there. Places are always at the
 * outermost level of the stream, where the state is known.
 */
function destinationOf(target: OrderTarget, item: Placed, items: ReadonlyMap<string, Placed>, extent: { first: number; last: number } | undefined): Destination | null | "refused" {
  const ops = parseSource(item.source).ops;
  const depths = depthsOf(item.source);
  if (target === "back") return extent && item.seq <= extent.first ? null : { at: 0, boundary: 0, closeLevels: 0 };
  if (target === "front") return extent && item.seq >= extent.last ? null : { at: item.source.data.length, boundary: ops.length, closeLevels: depths[ops.length] ?? 0 };
  const other = items.get("after" in target ? target.after : target.before);
  if (!other || other.source !== item.source || other.id === item.id) return "refused";
  if ("after" in target) {
    // After the whole outermost block that holds the other object.
    let k = other.endOp;
    while (k < ops.length - 1 && (depths[k + 1] ?? 0) > 0) k += 1;
    return { at: (ops[k] as { end: number }).end, boundary: k + 1, closeLevels: 0 };
  }
  let k = other.startOp;
  while (k > 0 && (depths[k] ?? 0) > 0) k -= 1;
  return { at: (ops[k] as { start: number }).start, boundary: k, closeLevels: 0 };
}

// ---- annotations -------------------------------------------------------------------------------------------------------------------

function planAnnotation(frame: PageFrame, annotation: { index: number; dict: PDFDict; subtype: string }, edit: ObjectEdit, result: PlanObjectsResult, outcome: (id: string, status: ObjectOutcome["status"], reason?: string) => void): void {
  if (edit.delete) {
    result.annotations.push({ index: annotation.index, delete: true });
    outcome(edit.id, "applied");
    return;
  }
  if (!edit.target) {
    outcome(edit.id, "unchanged");
    return;
  }
  if (!MOVABLE_ANNOTATIONS.has(annotation.subtype)) {
    outcome(edit.id, "refused", "This kind of annotation can be removed but not moved.");
    return;
  }
  const current = rectOf(annotation.dict);
  if (!current) {
    outcome(edit.id, "refused", "The annotation has no position to change.");
    return;
  }
  const bounds = boundsOfOriented({ ...edit.target, rotation: 0 });
  let rect = userRectOf(frame, bounds);
  const original = boxToDisplay(frame, current);
  const resized = Math.abs(bounds.width - original.width) > 1e-3 || Math.abs(bounds.height - original.height) > 1e-3;
  if (resized && !RESIZABLE_ANNOTATIONS.has(annotation.subtype)) {
    // Keep the size: only the position changes.
    const centreX = bounds.x + bounds.width / 2;
    const centreY = bounds.y + bounds.height / 2;
    rect = userRectOf(frame, { x: centreX - original.width / 2, y: centreY - original.height / 2, width: original.width, height: original.height });
  }
  result.annotations.push({ index: annotation.index, rect });
  outcome(edit.id, "applied");
}

function translateNumbers(array: PDFArray, dx: number, dy: number): void {
  for (let i = 0; i < array.size(); i += 1) {
    const item = array.lookup(i);
    if (item instanceof PDFArray) {
      translateNumbers(item, dx, dy);
    } else if (item instanceof PDFNumber) {
      array.set(i, PDFNumber.of(item.asNumber() + (i % 2 === 0 ? dx : dy)));
    }
  }
}

/** Makes the planned changes to the page's annotations. */
export function applyAnnotationChanges(doc: PDFDocument, page: PDFPage, changes: readonly AnnotationChange[]): void {
  if (changes.length === 0) return;
  const list = page.node.lookupMaybe(N.Annots, PDFArray);
  if (!list) return;
  const removed = new Set<number>();
  const parents = new Set<string>();
  for (const change of changes) {
    const entry = list.get(change.index);
    const dict = list.lookupMaybe(change.index, PDFDict);
    if (!dict) continue;
    if (change.delete) {
      removed.add(change.index);
      if (entry instanceof PDFRef) parents.add(entry.toString());
      continue;
    }
    if (!change.rect) continue;
    const old = rectOf(dict);
    if (!old) continue;
    const dx = change.rect.x - old.x;
    const dy = change.rect.y - old.y;
    dict.set(N.Rect, doc.context.obj([change.rect.x, change.rect.y, change.rect.x + change.rect.width, change.rect.y + change.rect.height]));
    const resized = Math.abs(change.rect.width - old.width) > 1e-6 || Math.abs(change.rect.height - old.height) > 1e-6;
    if (!resized && (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9)) {
      for (const key of POINT_ARRAYS) {
        const array = dict.lookupMaybe(PDFName.of(key), PDFArray);
        if (array) translateNumbers(array, dx, dy);
      }
    }
  }
  // A removed annotation takes its pop-up window with it.
  for (let i = 0; i < list.size(); i += 1) {
    const dict = list.lookupMaybe(i, PDFDict);
    if (!dict || dict.lookup(N.Subtype) !== PDFName.of("Popup")) continue;
    const parent = dict.get(N.Parent);
    if (parent instanceof PDFRef && parents.has(parent.toString())) removed.add(i);
  }
  for (const index of [...removed].sort((a, b) => b - a)) list.remove(index);
}

// ---- pictures nothing draws any more ---------------------------------------------------------------------------------------

/** A copy of `resources` without the named XObjects (the original is shared with other pages and is left alone). */
export function withoutXObjects(doc: PDFDocument, resources: PDFDict | undefined, names: ReadonlySet<string>): PDFDict | undefined {
  if (!resources || names.size === 0) return resources;
  const xobjects = resources.lookupMaybe(N.XObject, PDFDict);
  if (!xobjects) return resources;
  const copy = doc.context.obj({}) as PDFDict;
  for (const [key, value] of resources.entries()) copy.set(key, value);
  const trimmed = doc.context.obj({}) as PDFDict;
  for (const [key, value] of xobjects.entries()) if (!names.has(key.decodeText())) trimmed.set(key, value);
  copy.set(N.XObject, trimmed);
  return copy;
}

