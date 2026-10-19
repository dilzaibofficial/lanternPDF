import { PDFArray, PDFDict, type PDFDocument, PDFName, type PDFPage, PDFRawStream, PDFRef, PDFStream } from "@cantoo/pdf-lib";
import { zlibSync } from "fflate";
import { getImageCodec } from "../codec";
import { type PageFrame, frameOf } from "../draw";
import { describeImage, readPixels } from "../compress";
import { packComponents, predictRows } from "../pixels";
import { engineContext, ensureScanned } from "./context";
import { type FormUse, type Interpretation, type RunGlyph, type TextRun, interpret } from "./interpret";
import { IDENTITY, type Matrix, apply, invert } from "./matrix";
import { type Point, type Polygon, area, contains, containsAll, overlapArea, rectangle } from "./polygon";
import { displayToUserMatrix } from "./space";
import { type Splice, applySplices } from "./splice";
import { type ContentSource, pageResources, readPageContent, writeFormCopy, writePageContent } from "./streams";
import { formatNumber } from "./tokenizer";

/**
 * Redaction: taking what lies under a box out of the file, not covering it.
 *
 *  - **Text**: every glyph whose box is mostly under a redaction area is deleted from the operator that draws it (every
 *    kind of text, including invisible text and text with replacement text), and the pen is moved by what the glyph
 *    took so that nothing else shifts.
 *  - **Pictures**: one entirely under an area is no longer drawn (and is dropped from the file when nothing else uses
 *    it); one partly under an area is replaced, for this page only, by a copy with those pixels blanked.
 *  - **Drawn shapes** lying wholly inside an area are removed. Shapes that only partly overlap stay, and the report says
 *    so, because cutting a shape in two is not something this editor does.
 *  - **Annotations** (notes, links, form fields…) that overlap an area are removed together with their pop-ups.
 *
 * Afterwards the page is read again and checked: no glyph and no original picture may be left under an area.
 */

export interface RedactionArea {
  /** In display space (points from the top-left of the page as shown). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees clockwise about the centre. */
  rotation: number;
  /** Colour blanked pixels are set to (#rrggbb). */
  color?: string;
}

export interface RedactionReport {
  page: number;
  glyphs: number;
  imagesBlanked: number;
  imagesRemoved: number;
  shapesRemoved: number;
  /** Drawn shapes that only partly overlap an area and were left. */
  shapesKept: number;
  annotationsRemoved: number;
  /** Reusable blocks that could not be edited for one place and were removed from the page. */
  blocksRemoved: number;
  warnings: string[];
  verified: boolean;
}

/** A glyph is removed when this much of it (or its centre) lies under an area. */
const GLYPH_SHARE = 0.25;
const RED_NAME = "LanternRedacted";

const hexOf = (bytes: ArrayLike<number>): string => `<${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}>`;
const num = (value: number) => formatNumber(Math.round(value * 1000) / 1000);

// ---- geometry ------------------------------------------------------------------------------------------------------------

/** The four corners of a redaction area in user space. */
function areaQuad(frame: PageFrame, a: RedactionArea): Polygon {
  const toUser = displayToUserMatrix(frame);
  const cx = a.x + a.width / 2;
  const cy = a.y + a.height / 2;
  const cos = Math.cos((a.rotation * Math.PI) / 180);
  const sin = Math.sin((a.rotation * Math.PI) / 180);
  const corners: Point[] = [
    [a.x, a.y],
    [a.x + a.width, a.y],
    [a.x + a.width, a.y + a.height],
    [a.x, a.y + a.height],
  ];
  return corners.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    return apply(toUser, cx + dx * cos - dy * sin, cy + dx * sin + dy * cos) as Point;
  });
}

function glyphQuad(run: TextRun, glyph: RunGlyph): Polygon {
  let ascent = (run.font.ascent / 1000) * run.fontSize;
  let descent = (run.font.descent / 1000) * run.fontSize;
  if (Math.abs(ascent - descent) < 0.2 * Math.abs(run.fontSize)) {
    ascent = 0.8 * run.fontSize;
    descent = -0.2 * run.fontSize;
  }
  const units = glyph.width > 0 ? glyph.width : 500;
  const width = (units / 1000) * run.fontSize * run.hScale;
  const y0 = run.rise + Math.min(ascent, descent);
  const y1 = run.rise + Math.max(ascent, descent);
  const corners: Point[] = [
    [glyph.x, y0],
    [glyph.x + width, y0],
    [glyph.x + width, y1],
    [glyph.x, y1],
  ];
  return corners.map(([x, y]) => apply(run.matrix, x, y) as Point);
}

const imageQuad = (matrix: Matrix): Polygon => [apply(matrix, 0, 0), apply(matrix, 1, 0), apply(matrix, 1, 1), apply(matrix, 0, 1)] as Point[];

function rectQuad(r: { x: number; y: number; width: number; height: number }): Polygon {
  return rectangle(r.x, r.y, r.width, r.height);
}

/** How much of a polygon lies under the areas (as a share of its own size), and whether its centre does. */
function coverage(shape: Polygon, areas: readonly Polygon[]): { share: number; centre: boolean } {
  const size = area(shape);
  if (size < 1e-12) {
    const [cx, cy] = centreOf(shape);
    return { share: 0, centre: areas.some((a) => insideAny(a, [cx, cy])) };
  }
  let covered = 0;
  for (const a of areas) covered += overlapArea(shape, a);
  const [cx, cy] = centreOf(shape);
  return { share: Math.min(1, covered / size), centre: areas.some((a) => insideAny(a, [cx, cy])) };
}

const centreOf = (shape: Polygon): Point => [shape.reduce((s, p) => s + p[0], 0) / shape.length, shape.reduce((s, p) => s + p[1], 0) / shape.length];
const insideAny = (polygon: Polygon, point: Point): boolean => contains(polygon, point);

// ---- text ------------------------------------------------------------------------------------------------------------------

/** The operator text of a run with some of its glyphs taken out and the pen moved by what they took. */
function rewriteRun(run: TextRun, removed: ReadonlySet<string>): string {
  const parts: string[] = [];
  if (run.operator === "'") parts.push("T*");
  if (run.operator === '"') parts.push(`${formatNumber(run.wordSpacing)} Tw ${formatNumber(run.charSpacing)} Tc T*`);
  const out: (string | number)[] = [];
  let kept: number[] = [];
  let move = 0;
  const flushBytes = () => {
    if (kept.length > 0) out.push(hexOf(kept));
    kept = [];
  };
  const flushMove = () => {
    if (Math.abs(move) > 1e-9) out.push(move);
    move = 0;
  };
  const unit = run.fontSize * run.hScale;
  run.elements.forEach((element, elementIndex) => {
    if (element.kind === "adj") {
      move += element.value;
      return;
    }
    let at = 0;
    element.glyphs.forEach((glyph, glyphIndex) => {
      const bytes = element.bytes.subarray(at, at + glyph.length);
      at += glyph.length;
      if (removed.has(`${elementIndex}:${glyphIndex}`)) {
        // The glyph is gone but the pen still moves by what it took, so the glyphs after it stay where they were.
        move += Math.abs(unit) > 1e-9 ? (-glyph.advance * 1000) / unit : 0;
        return;
      }
      if (Math.abs(move) > 1e-9) {
        flushBytes();
        flushMove();
      }
      kept.push(...bytes);
    });
  });
  flushBytes();
  flushMove();
  if (out.length > 0) parts.push(`[${out.map((item) => (typeof item === "string" ? item : num(item))).join(" ")}] TJ`);
  return ` ${parts.join(" ")} `;
}

// ---- pictures --------------------------------------------------------------------------------------------------------------

function parseColor(value: string | undefined): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(value ?? "#000000");
  const hex = match?.[1] ?? "000000";
  return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];
}

/** Fills the part of an RGBA picture that lies under the areas (given in user space) with `color`. Returns how many pixels were set. */
function blank(rgba: Uint8ClampedArray, width: number, height: number, placement: Matrix, quads: readonly Polygon[], color: [number, number, number]): number {
  const inverse = invert(placement);
  if (!inverse) return 0;
  let changed = 0;
  for (const quad of quads) {
    // The area in the picture's own pixels (row 0 is the top, which is v = 1 of the unit square).
    const pixels: Point[] = quad.map(([x, y]) => {
      const [u, v] = apply(inverse, x, y);
      return [u * width, (1 - v) * height] as Point;
    });
    const xs = pixels.map((p) => p[0]);
    const ys = pixels.map((p) => p[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 1);
    const x1 = Math.min(width - 1, Math.ceil(Math.max(...xs)) + 1);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 1);
    const y1 = Math.min(height - 1, Math.ceil(Math.max(...ys)) + 1);
    // Grown by a pixel each way so no halo of the covered picture is left at the edge.
    const grown = grow(pixels, 1);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        if (!insidePolygon(grown, x + 0.5, y + 0.5)) continue;
        const at = (y * width + x) * 4;
        rgba[at] = color[0];
        rgba[at + 1] = color[1];
        rgba[at + 2] = color[2];
        rgba[at + 3] = 255;
        changed += 1;
      }
    }
  }
  return changed;
}

function grow(polygon: readonly Point[], by: number): Point[] {
  const cx = polygon.reduce((s, p) => s + p[0], 0) / polygon.length;
  const cy = polygon.reduce((s, p) => s + p[1], 0) / polygon.length;
  return polygon.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const length = Math.hypot(dx, dy) || 1;
    return [x + (dx / length) * by, y + (dy / length) * by] as Point;
  });
}

function insidePolygon(polygon: readonly Point[], x: number, y: number): boolean {
  // A convex polygon: the point is on the same side of every edge.
  let sign = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const [ax, ay] = polygon[i] as Point;
    const [bx, by] = polygon[(i + 1) % polygon.length] as Point;
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (Math.abs(cross) < 1e-9) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** A copy of a picture with the pixels under the areas blanked, or null when it cannot be decoded safely. */
async function blankedCopy(doc: PDFDocument, original: PDFRawStream, placement: Matrix, quads: readonly Polygon[], color: [number, number, number]): Promise<PDFRef | "nothing" | null> {
  const info = describeImage(original);
  if (typeof info === "string") return null;
  const pixels = await readPixels(info, original);
  if (typeof pixels === "string") return null;
  const rgba = new Uint8ClampedArray(pixels);
  const changed = blank(rgba, info.width, info.height, placement, quads, color);
  if (changed === 0) return "nothing";
  const dict = doc.context.obj({}) as PDFDict;
  for (const [key, value] of original.dict.entries()) dict.set(key, value);
  dict.set(PDFName.of("Width"), doc.context.obj(info.width));
  dict.set(PDFName.of("Height"), doc.context.obj(info.height));
  dict.set(PDFName.of("BitsPerComponent"), doc.context.obj(8));
  dict.delete(PDFName.of("Decode"));
  dict.delete(PDFName.of("DecodeParms"));
  let bytes: Uint8Array;
  if (info.source === "dct") {
    bytes = await getImageCodec().encode({ width: info.width, height: info.height, rgba }, "jpeg", 0.92);
    dict.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
    dict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB")); // the encoder writes three components
  } else {
    const packed = packComponents(rgba, info.width * info.height, info.components);
    bytes = zlibSync(predictRows(packed, info.width * info.components, info.height, info.components), { level: 6 });
    dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
    dict.set(PDFName.of("DecodeParms"), doc.context.obj({ Predictor: 15, Colors: info.components, BitsPerComponent: 8, Columns: info.width }));
  }
  dict.delete(PDFName.of("Length"));
  return doc.context.register(PDFRawStream.of(dict, bytes));
}

// ---- resources of a stream we are rewriting ---------------------------------------------------------------------------

/** A private copy of a resource dictionary (with its XObject dictionary), so entries can be added without touching other pages. */
function privateResources(doc: PDFDocument, resources: PDFDict | undefined): { resources: PDFDict; xobjects: PDFDict } {
  const copy = doc.context.obj({}) as PDFDict;
  if (resources) for (const [key, value] of resources.entries()) copy.set(key, value);
  const xobjects = doc.context.obj({}) as PDFDict;
  const original = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  if (original) for (const [key, value] of original.entries()) xobjects.set(key, value);
  copy.set(PDFName.of("XObject"), xobjects);
  return { resources: copy, xobjects };
}

// ---- the page -----------------------------------------------------------------------------------------------------------------

/** The depth-1 use of a form an item's id belongs to (`page/Fm1@7#12` → `Fm1`, op 7), or null for the page's own content. */
function topUse(id: string): { name: string; opIndex: number } | null {
  const first = id.split("#")[0]?.split("/")[1];
  if (!first) return null;
  const at = first.lastIndexOf("@");
  return at > 0 ? { name: first.slice(0, at), opIndex: Number(first.slice(at + 1)) } : null;
}

/**
 * Redacts one page of `doc`. The page's content is re-read first (so edits already made to it count), then rewritten.
 * Returns what was removed, what could not be, and whether the page was checked afterwards.
 */
export async function redactPage(doc: PDFDocument, pageIndex: number, areas: readonly RedactionArea[]): Promise<RedactionReport> {
  const report: RedactionReport = { page: pageIndex + 1, glyphs: 0, imagesBlanked: 0, imagesRemoved: 0, shapesRemoved: 0, shapesKept: 0, annotationsRemoved: 0, blocksRemoved: 0, warnings: [], verified: false };
  if (areas.length === 0) {
    report.verified = true;
    return report;
  }
  const page = doc.getPage(pageIndex);
  const frame = frameOf(page);
  const quads = areas.map((a) => areaQuad(frame, a));
  const colors = areas.map((a) => parseColor(a.color));
  const context = engineContext(doc);
  ensureScanned(context);

  const source = readPageContent(doc, page);
  const before: Interpretation = interpret(doc, source, IDENTITY, context.fonts, {}, { formSources: context.formSources, seedUsed: context.seedUsed });
  if (before.truncated || source.unreadable > 0 || source.tooLarge) {
    report.warnings.push(`Page ${pageIndex + 1}: some of its content could not be read completely, so what is under the redaction boxes could not all be found. Nothing on this page was redacted.`);
    return report;
  }

  const splices = new Map<ContentSource, Splice[]>();
  const add = (target: ContentSource, splice: Splice) => {
    const list = splices.get(target) ?? [];
    list.push(splice);
    splices.set(target, list);
  };
  const opsOf = (target: ContentSource) => (target.parsed ?? { ops: [] }).ops;

  // ---- which forms may be edited for this page ------------------------------------------------------------------------
  const refUses = new Map<string, number>();
  for (const form of before.forms) if (form.ref) refUses.set(form.ref.toString(), (refUses.get(form.ref.toString()) ?? 0) + 1);
  const nested = new Set<ContentSource>();
  for (const form of before.forms) if (form.source.kind === "form") nested.add(form.source);
  const editable = (target: ContentSource): boolean => {
    if (target.kind === "page") return true;
    const ref = target.parts[0]?.ref?.toString();
    return Boolean(ref) && (refUses.get(ref as string) ?? 0) === 1 && !nested.has(target);
  };
  const removedUses = new Map<number, string>();
  const depthOneUses = new Map<string, FormUse>(before.forms.filter((f) => f.source.kind === "page").map((f) => [`${f.name}@${f.opIndex}`, f]));
  const dropWholeUse = (id: string) => {
    const use = topUse(id);
    if (!use) return;
    const found = depthOneUses.get(`${use.name}@${use.opIndex}`);
    if (found) removedUses.set(found.opIndex, found.name);
  };

  // ---- text -----------------------------------------------------------------------------------------------------------------
  const actualTexts = new Set<string>();
  for (const run of before.runs) {
    const removed = new Set<string>();
    let any = false;
    run.elements.forEach((element, elementIndex) => {
      if (element.kind !== "str") return;
      element.glyphs.forEach((glyph, glyphIndex) => {
        const c = coverage(glyphQuad(run, glyph), quads);
        if (c.share >= GLYPH_SHARE || c.centre) {
          removed.add(`${elementIndex}:${glyphIndex}`);
          any = true;
        }
      });
    });
    if (!any) continue;
    if (!editable(run.source)) {
      dropWholeUse(run.id);
      continue;
    }
    if (run.font.vertical) {
      // The pen moves downwards in vertical writing; remove the whole run instead of guessing.
      add(run.source, { start: run.op.start, end: run.op.end, text: " " });
      report.glyphs += removed.size;
      continue;
    }
    add(run.source, { start: run.op.start, end: run.op.end, text: rewriteRun(run, removed) });
    report.glyphs += removed.size;
    // Replacement text of marked content would still say what was removed.
    if (run.actualOp !== null) {
      const key = `${run.source.id}#${run.actualOp}`;
      if (!actualTexts.has(key)) {
        actualTexts.add(key);
        const op = opsOf(run.source)[run.actualOp];
        if (op) add(run.source, { start: op.start, end: op.end, text: " /Span BMC " });
      }
    }
  }

  // ---- pictures ---------------------------------------------------------------------------------------------------------------
  type PendingCopy = { source: ContentSource; name: string; ref: PDFRef };
  const copies: PendingCopy[] = [];
  let copyCounter = 0;
  const removedNames = new Map<ContentSource, Set<string>>();
  for (const image of before.images) {
    const shape = imageQuad(image.matrix);
    const covered = coverage(shape, quads);
    if (covered.share <= 1e-6) continue;
    if (!editable(image.source)) {
      dropWholeUse(image.id);
      continue;
    }
    const ops = opsOf(image.source);
    const op = ops[image.opIndex];
    if (!op) continue;
    const whole = quads.some((q) => containsAll(q, shape)) || covered.share >= 0.999;
    if (whole) {
      add(image.source, { start: op.start, end: op.end, text: " " });
      report.imagesRemoved += 1;
      if (image.name) {
        const names = removedNames.get(image.source) ?? new Set<string>();
        names.add(image.name);
        removedNames.set(image.source, names);
      }
      continue;
    }
    // Partly covered: a copy of the picture with those pixels blanked, drawn instead of the original (for this use only).
    let handled = false;
    if (!image.inline && image.ref) {
      const original = doc.context.lookup(image.ref);
      if (original instanceof PDFRawStream) {
        const color = colors[quads.findIndex((q) => overlapArea(shape, q) > 0)] ?? [0, 0, 0];
        const copyRef = await blankedCopy(doc, original, image.matrix, quads.filter((q) => overlapArea(shape, q) > 0), color);
        if (copyRef === "nothing") {
          handled = true; // the overlap is smaller than a pixel: nothing of the picture is under the box
        } else if (copyRef) {
          copyCounter += 1;
          const name = `${RED_NAME}${copyCounter}`;
          copies.push({ source: image.source, name, ref: copyRef });
          add(image.source, { start: op.start, end: op.end, text: ` /${name} Do ` });
          report.imagesBlanked += 1;
          handled = true;
          const names = removedNames.get(image.source) ?? new Set<string>();
          if (image.name) names.add(image.name);
          removedNames.set(image.source, names);
        }
      }
    }
    if (!handled) {
      // Not a picture whose pixels can be edited safely (masks, CMYK, scanner formats, inline images): take the whole picture out.
      add(image.source, { start: op.start, end: op.end, text: " " });
      report.imagesRemoved += 1;
      report.warnings.push(`Page ${pageIndex + 1}: a picture partly under a redaction box could not be edited pixel by pixel (its format is not supported for that), so the whole picture was removed.`);
      if (image.name) {
        const names = removedNames.get(image.source) ?? new Set<string>();
        names.add(image.name);
        removedNames.set(image.source, names);
      }
    }
  }

  // ---- drawn shapes ---------------------------------------------------------------------------------------------------------------
  for (const path of before.paths) {
    if (path.clipped) continue;
    const shape = rectQuad(path.box);
    const overlap = coverage(shape, quads);
    if (overlap.share <= 1e-6 && !overlap.centre) continue;
    const inside = quads.some((q) => containsAll(q, shape));
    if (!inside) {
      // A page-sized background partly under a box is expected; anything else is worth saying.
      if (area(shape) < 0.5 * frame.box.width * frame.box.height) report.shapesKept += 1;
      continue;
    }
    if (!editable(path.source)) {
      dropWholeUse(path.id);
      continue;
    }
    const ops = opsOf(path.source);
    const first = ops[path.startOp];
    const last = ops[path.endOp];
    if (!first || !last) continue;
    add(path.source, { start: first.start, end: last.end, text: " " });
    report.shapesRemoved += 1;
  }

  // ---- blocks that cannot be edited for one place only -----------------------------------------------------------------------
  for (const [opIndex, name] of removedUses) {
    const op = opsOf(source)[opIndex];
    if (!op) continue;
    add(source, { start: op.start, end: op.end, text: " " });
    report.blocksRemoved += 1;
    report.warnings.push(`Page ${pageIndex + 1}: something under a redaction box belongs to a reusable block (“${name}”) that the file uses in more than one place, so the whole block was removed from this page.`);
  }

  // ---- write the content back ---------------------------------------------------------------------------------------------------
  const usedForms = new Map<string, FormUse>();
  for (const form of before.forms) usedForms.set(form.content?.id ?? "", form);
  const sources = [...splices.keys()];
  for (const target of sources) {
    const data = applySplices(target.data, splices.get(target) as Splice[]);
    const mine = copies.filter((c) => c.source === target);
    if (target.kind === "page") {
      writePageContent(doc, page, data);
      if (mine.length > 0 || removedNames.has(target)) {
        const own = privateResources(doc, pageResources(page));
        for (const copy of mine) own.xobjects.set(PDFName.of(copy.name), copy.ref);
        pruneImageNames(own.xobjects, data, removedNames.get(target));
        page.node.set(PDFName.of("Resources"), own.resources);
      }
    } else {
      const stream = target.parts[0]?.stream;
      const use = usedForms.get(target.id);
      if (!stream || !use) continue;
      const copy = writeFormCopy(doc, stream, data);
      const copyStream = doc.context.lookup(copy);
      if (mine.length > 0 || removedNames.has(target)) {
        const own = privateResources(doc, stream.dict.lookupMaybe(PDFName.of("Resources"), PDFDict));
        for (const c of mine) own.xobjects.set(PDFName.of(c.name), c.ref);
        pruneImageNames(own.xobjects, data, removedNames.get(target));
        if (copyStream instanceof PDFStream) copyStream.dict.set(PDFName.of("Resources"), own.resources);
      }
      const outer = privateResources(doc, pageResources(page));
      outer.xobjects.set(PDFName.of(use.name), copy);
      page.node.set(PDFName.of("Resources"), outer.resources);
    }
  }

  // ---- annotations ---------------------------------------------------------------------------------------------------------------
  report.annotationsRemoved = removeAnnotations(doc, page, quads);

  // ---- check -----------------------------------------------------------------------------------------------------------------------
  await doc.flush();
  const after = interpret(doc, readPageContent(doc, page), IDENTITY, new Map(), {}, { formSources: new Map() });
  let leftover = 0;
  for (const run of after.runs) {
    run.elements.forEach((element) => {
      if (element.kind !== "str") return;
      for (const glyph of element.glyphs) {
        const c = coverage(glyphQuad(run, glyph), quads);
        if (c.share >= GLYPH_SHARE || c.centre) leftover += 1;
      }
    });
  }
  for (const image of after.images) {
    if (coverage(imageQuad(image.matrix), quads).share <= 1e-6) continue;
    // A picture still under an area must be one of our blanked copies.
    const name = image.name ?? "";
    if (!name.startsWith(RED_NAME)) leftover += 1;
  }
  report.verified = leftover === 0;
  if (!report.verified) report.warnings.push(`Page ${pageIndex + 1}: after redaction ${leftover} piece${leftover === 1 ? "" : "s"} of content under a redaction box could still be found, so this file should not be used as redacted.`);
  if (report.shapesKept > 0) report.warnings.push(`Page ${pageIndex + 1}: ${report.shapesKept} drawn shape${report.shapesKept === 1 ? " is" : "s are"} only partly under a redaction box and stayed in the file. Shapes hold no text or pictures, but a drawing (such as a signature drawn as lines) would still be there.`);
  return report;
}

/** Removes picture names from a resource dictionary when the content no longer draws them. */
function pruneImageNames(xobjects: PDFDict, data: Uint8Array, names: ReadonlySet<string> | undefined): void {
  if (!names) return;
  const text = new TextDecoder("latin1").decode(data);
  for (const name of names) {
    const used = new RegExp(`/${name.replace(/[^A-Za-z0-9_-]/g, (c) => `#${c.charCodeAt(0).toString(16)}`)}\\s+Do\\b`).test(text);
    if (!used) xobjects.delete(PDFName.of(name));
  }
}

/** Removes the annotations (and their pop-ups, and form fields) whose rectangles overlap an area. Returns how many. */
function removeAnnotations(doc: PDFDocument, page: PDFPage, quads: readonly Polygon[]): number {
  const list = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (!list) return 0;
  // Links, form fields and pop-ups are not "objects" for the editor, but they are still content under the box.
  const everything: { index: number; dict: PDFDict; subtype: string }[] = [];
  for (let i = 0; i < list.size(); i += 1) {
    const dict = list.lookupMaybe(i, PDFDict);
    if (!dict) continue;
    const subtype = (dict.lookup(PDFName.of("Subtype")) as PDFName | undefined)?.decodeText() ?? "Unknown";
    everything.push({ index: i, dict, subtype });
  }
  const gone = new Set<number>();
  const refs = new Set<string>();
  for (const { index, dict, subtype } of everything) {
    if (subtype === "Popup") continue;
    const rect = dict.lookupMaybe(PDFName.of("Rect"), PDFArray);
    if (!rect || rect.size() < 4) continue;
    const values = [0, 1, 2, 3].map((i) => (rect.lookup(i) as { asNumber?: () => number } | undefined)?.asNumber?.() ?? Number.NaN);
    if (!values.every(Number.isFinite)) continue;
    const [x1, y1, x2, y2] = values as [number, number, number, number];
    const shape = rectQuad({ x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) });
    if (quads.some((q) => overlapArea(shape, q) > 1e-6)) {
      gone.add(index);
      const entry = list.get(index);
      if (entry instanceof PDFRef) refs.add(entry.toString());
    }
  }
  if (gone.size === 0) return 0;
  // A removed annotation takes its pop-up with it, and a form field leaves the form.
  for (const { index, dict, subtype } of everything) {
    if (subtype !== "Popup") continue;
    const parent = dict.get(PDFName.of("Parent"));
    if (parent instanceof PDFRef && refs.has(parent.toString())) gone.add(index);
  }
  const form = doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
  const fields = form?.lookupMaybe(PDFName.of("Fields"), PDFArray);
  if (fields) {
    for (let i = fields.size() - 1; i >= 0; i -= 1) {
      const entry = fields.get(i);
      if (entry instanceof PDFRef && refs.has(entry.toString())) fields.remove(i);
    }
  }
  for (const index of [...gone]) {
    const entry = list.get(index);
    const parent = list.lookupMaybe(index, PDFDict)?.lookupMaybe(PDFName.of("Parent"), PDFDict);
    const kids = parent?.lookupMaybe(PDFName.of("Kids"), PDFArray);
    if (kids && entry instanceof PDFRef) {
      for (let i = kids.size() - 1; i >= 0; i -= 1) {
        const kid = kids.get(i);
        if (kid instanceof PDFRef && kid.toString() === entry.toString()) kids.remove(i);
      }
    }
  }
  for (const index of [...gone].sort((a, b) => b - a)) list.remove(index);
  return [...gone].filter((index) => everything.find((e) => e.index === index)?.subtype !== "Popup").length;
}
