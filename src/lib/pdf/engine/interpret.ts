import { PDFDict, type PDFDocument, PDFName, type PDFObject, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, PDFHexString, PDFArray } from "@cantoo/pdf-lib";
import { type FontModel, type GlyphCode, buildFontModel, fontKeyOf, fontSignature } from "./fonts/fontModel";
import { IDENTITY, type Matrix, type Rect, apply, isFiniteMatrix, multiply, transformRect, translation } from "./matrix";
import { type ContentSource, readFormContent } from "./streams";
import { parseSource } from "./streams";
import { type Operand, type Operation, numbersOf } from "./tokenizer";

/**
 * Walks a page's content the way a viewer would, tracking the graphics state, and reports what is drawn:
 * text runs (one per text-showing operation, with the exact bytes they came from), images, painted path
 * extents and the forms that were drawn.
 *
 * It follows form XObjects (to a bounded depth, with cycle protection) because text inside a form is still
 * text on the page. It does not render anything and it never throws: what it cannot understand it notes in
 * `problems` and skips.
 */

export interface RunGlyph {
  code: number;
  /** Bytes of the string this glyph occupies. */
  length: number;
  /** The character(s) it stands for; empty when the font does not say. */
  text: string;
  /** Advance width in 1/1000 em. */
  width: number;
  /** Offset of the glyph's origin from the start of the run, in text space (after horizontal scaling). */
  x: number;
  /** How far the pen moves for this glyph in text space, including character and word spacing. */
  advance: number;
}

export interface RunString {
  kind: "str";
  bytes: Uint8Array;
  glyphs: RunGlyph[];
  /** Byte range of the string token in the content stream. */
  start: number;
  end: number;
  hex: boolean;
}

export interface RunAdjust {
  kind: "adj";
  value: number;
  /** Offset from the run start (text space) where the adjustment is applied. */
  x: number;
  /** How far the pen moves because of it (text space). */
  advance: number;
  start: number;
  end: number;
}

export type RunElement = RunString | RunAdjust;

export interface TextRun {
  /** Stable within a content stream: `<stream id>#<operation index>`. */
  id: string;
  source: ContentSource;
  opIndex: number;
  op: Operation;
  operator: "Tj" | "TJ" | "'" | '"';
  elements: RunElement[];
  font: FontModel;
  /** The resource name the stream selected the font by (`/F1` is "F1"). */
  fontName: string;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  /** Horizontal scaling as a fraction (1 = 100%). */
  hScale: number;
  rise: number;
  renderMode: number;
  leading: number;
  /** Maps text space (the space `x` and `advance` are measured in) to the space the stream draws in. */
  matrix: Matrix;
  /** The text matrix when the run starts (pen position), and the line matrix then in effect, both before the CTM. */
  textMatrix: Matrix;
  lineMatrix: Matrix;
  /** The graphics-state matrix alone (without the text matrix). */
  ctm: Matrix;
  /** Total pen advance in text space. */
  advance: number;
  text: string;
  /** Bounding box in the space the stream draws in (page user space for page content). */
  box: Rect;
  /** Fill colour as #rrggbb, or null when it is not a plain device colour. */
  fill: string | null;
  /** Replacement text of an enclosing marked-content `/ActualText`, if any. */
  actualText: string | null;
  /** Index of the `BDC` operator that carries that replacement text. */
  actualOp: number | null;
  /** Index of the text object (`BT`…`ET`) this run belongs to, unique within the stream. */
  textObject: number;
  /** Index (into the interpretation's runs) of the run whose pen position this one continues from, or null. */
  flowFrom: number | null;
  /** True when a newline operator (`'`, `"`) moved the line before showing. */
  newline: boolean;
  /** Depth of form XObject nesting this run was found at (0 = the page itself). */
  depth: number;
  /** Position in the page's paint order, shared with images and shapes: later is on top. */
  seq: number;
}

export interface ImageUse {
  id: string;
  source: ContentSource;
  opIndex: number;
  /** Resource name for XObject images; null for inline images. */
  name: string | null;
  ref: PDFRef | null;
  inline: boolean;
  /** Maps the image's unit square to the space the stream draws in. */
  matrix: Matrix;
  box: Rect;
  /** Pixel size, when the image dictionary says. */
  pixelWidth: number | null;
  pixelHeight: number | null;
  depth: number;
  /** Position in the page's paint order. */
  seq: number;
}

/** A painted outline in the space the stream draws in: closed or open runs of points (curves are flattened). */
export interface Subpath {
  points: [number, number][];
  closed: boolean;
}

export interface PathUse {
  /** `<source key>#<index of the painting operator>`. */
  id: string;
  source: ContentSource;
  /** First path-construction operator of the shape, and the painting operator that ends it. */
  startOp: number;
  endOp: number;
  box: Rect;
  fill: boolean;
  stroke: boolean;
  depth: number;
  /** The graphics-state matrix in effect when it was painted. */
  ctm: Matrix;
  /** The same path also sets the clip: it cannot be moved or removed without changing what is drawn after it. */
  clipped: boolean;
  seq: number;
  /** Operators the path was built from, in order (`m`, `l`, `c`, `re`, `h`…), for telling a rectangle from a line. */
  built: string;
  /** The outline, when it is simple enough to keep (so that a click can be tested against the real shape). */
  outline: Subpath[] | null;
}

export interface FormUse {
  name: string;
  ref: PDFRef | null;
  depth: number;
  /** The stream that draws the form. */
  source: ContentSource;
  opIndex: number;
  /** The form's own content, when it was read. */
  content: ContentSource | null;
}

export interface Interpretation {
  runs: TextRun[];
  images: ImageUse[];
  paths: PathUse[];
  forms: FormUse[];
  sources: ContentSource[];
  problems: string[];
  /** True when a safety limit stopped the walk before the end. */
  truncated: boolean;
}

export interface InterpretOptions {
  /** Only record which character codes each font is used with, and how often forms are drawn. */
  light?: boolean;
  maxRuns?: number;
  maxPaths?: number;
  maxFormDepth?: number;
}

export type FontCache = Map<string, FontModel>;

const MAX_RUNS = 400_000;
const MAX_PATHS = 20_000;
const MAX_FORM_DEPTH = 8;
const MAX_GRAPHICS_STACK = 256;

const N = {
  Font: PDFName.of("Font"),
  XObject: PDFName.of("XObject"),
  Subtype: PDFName.of("Subtype"),
  Image: PDFName.of("Image"),
  Form: PDFName.of("Form"),
  Matrix: PDFName.of("Matrix"),
  Width: PDFName.of("Width"),
  Height: PDFName.of("Height"),
  ColorSpace: PDFName.of("ColorSpace"),
  Properties: PDFName.of("Properties"),
  ActualText: PDFName.of("ActualText"),
  N: PDFName.of("N"),
};

interface GraphicsState {
  ctm: Matrix;
  font: FontModel | null;
  fontName: string;
  fontSize: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  rise: number;
  tr: number;
  fill: string | null;
  fillSpace: string | null;
}

const initialState = (ctm: Matrix): GraphicsState => ({ ctm, font: null, fontName: "", fontSize: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, tr: 0, fill: "#000000", fillSpace: "DeviceGray" });

// ---- colour ---------------------------------------------------------------------------------------------------

const hex2 = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, "0");
const gray = (g: number) => `#${hex2(g)}${hex2(g)}${hex2(g)}`;
const rgbColor = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const cmyk = (c: number, m: number, y: number, k: number) => rgbColor((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));

function colorFromComponents(space: string | null, values: readonly number[]): string | null {
  switch (space) {
    case "DeviceGray":
    case "CalGray":
      return values.length === 1 ? gray(values[0] as number) : null;
    case "DeviceRGB":
    case "CalRGB":
      return values.length === 3 ? rgbColor(values[0] as number, values[1] as number, values[2] as number) : null;
    case "DeviceCMYK":
      return values.length === 4 ? cmyk(values[0] as number, values[1] as number, values[2] as number, values[3] as number) : null;
    default:
      if (space?.startsWith("ICC:")) {
        if (values.length === 1) return gray(values[0] as number);
        if (values.length === 3) return rgbColor(values[0] as number, values[1] as number, values[2] as number);
        if (values.length === 4) return cmyk(values[0] as number, values[1] as number, values[2] as number, values[3] as number);
      }
      return null;
  }
}

function colorSpaceName(resources: PDFDict | undefined, name: string): string | null {
  if (name === "DeviceGray" || name === "DeviceRGB" || name === "DeviceCMYK" || name === "Pattern") return name;
  if (name === "G") return "DeviceGray";
  if (name === "RGB") return "DeviceRGB";
  if (name === "CMYK") return "DeviceCMYK";
  const spaces = resources?.lookupMaybe(N.ColorSpace, PDFDict);
  const entry = spaces?.lookup(PDFName.of(name));
  if (entry instanceof PDFName) return entry.decodeText();
  if (entry instanceof PDFArray) {
    const first = entry.lookup(0);
    const kind = first instanceof PDFName ? first.decodeText() : null;
    if (kind === "ICCBased") {
      const stream = entry.lookup(1);
      const n = stream instanceof PDFStream ? stream.dict.lookup(N.N) : undefined;
      return n instanceof PDFNumber ? `ICC:${n.asNumber()}` : null;
    }
    return kind;
  }
  return null;
}

// ---- helpers --------------------------------------------------------------------------------------------------

const numberArg = (args: readonly Operand[], index: number): number | null => {
  const a = args[index];
  return a && a.t === "num" ? a.v : null;
};

function lookupResource(resources: PDFDict | undefined, category: PDFName, name: string): { entry: PDFObject | undefined; object: PDFObject | undefined } {
  const dict = resources?.lookupMaybe(category, PDFDict);
  if (!dict) return { entry: undefined, object: undefined };
  const entry = dict.get(PDFName.of(name));
  const object = entry instanceof PDFRef ? dict.context.lookup(entry) : entry;
  return { entry, object };
}

function textOfPdfString(object: PDFObject | undefined): string | null {
  if (object instanceof PDFString || object instanceof PDFHexString) return object.decodeText();
  return null;
}

// ---------------------------------------------------------------------------------------------------------------

interface Walk {
  doc: PDFDocument;
  fonts: FontCache;
  out: Interpretation;
  options: Required<Pick<InterpretOptions, "maxRuns" | "maxPaths" | "maxFormDepth">> & { light: boolean };
  /** Form streams being walked right now, to stop a form that draws itself. */
  active: Set<string>;
  /** Form sources already read, by reference, so a form drawn many times is read once. */
  formSources: Map<string, ContentSource>;
  /** Codes known to be in use with a font elsewhere in the document (by font signature). */
  seedUsed?: ReadonlyMap<string, ReadonlySet<number>>;
  /** Counts what is painted, in order. */
  seq: number;
}

/** Longest outline (in points) kept for hit-testing a shape. */
const MAX_OUTLINE_POINTS = 240;

function getFont(walk: Walk, resources: PDFDict | undefined, name: string): FontModel | null {
  const { entry, object } = lookupResource(resources, N.Font, name);
  if (!(object instanceof PDFDict)) return null;
  const key = fontKeyOf(entry, object);
  let model = walk.fonts.get(key);
  if (!model) {
    model = buildFontModel(object, name, key);
    const seeded = walk.seedUsed?.get(fontSignature(model));
    if (seeded) for (const code of seeded) model.used.add(code);
    walk.fonts.set(key, model);
  }
  return model;
}

const MISSING_FONT_CACHE = new WeakMap<Walk, FontModel>();

function missingFont(walk: Walk, name: string): FontModel {
  let model = MISSING_FONT_CACHE.get(walk);
  if (!model) {
    const stub = PDFDict.withContext(walk.doc.context);
    model = buildFontModel(stub, name, `missing:${name}`);
    MISSING_FONT_CACHE.set(walk, model);
  }
  return model;
}

/**
 * `key` names the stream for the ids of what it draws: `page` for the page, then `/<resource name>@<operator index>` for
 * each form drawn from it. Unlike a form's object number it does not change when the page is copied into another file,
 * so ids found while analysing a page still address the same things in the copy that gets edited.
 */
function interpretSource(walk: Walk, source: ContentSource, startCtm: Matrix, depth: number, key: string): void {
  const { ops, truncated, problems } = parseSource(source);
  if (truncated) {
    walk.out.truncated = true;
    walk.out.problems.push("A very long content stream was only partly read.");
  }
  if (problems > 50) walk.out.problems.push("Part of the page content is malformed.");
  if (source.unreadable > 0) walk.out.problems.push("Some of the page content uses a compression this editor cannot read.");
  if (source.tooLarge) {
    walk.out.truncated = true;
    walk.out.problems.push("The page content is too large to read safely.");
  }

  const light = walk.options.light;
  let gs = initialState(startCtm);
  const stack: GraphicsState[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let textObject = -1;
  /** The run the pen is continuing from, until something repositions it. */
  let flowRun: number | null = null;
  const marked: { actualText: string | null; op: number }[] = [];
  let currentActual: string | null = null;
  let currentActualOp: number | null = null;

  // path state, for extents and outlines
  let pathStart = -1;
  let pathBuilt = "";
  let pendingClip = false;
  let subpaths: Subpath[] = [];
  let currentSub: Subpath | null = null;
  let outlineBudget = MAX_OUTLINE_POINTS;
  let px0 = Number.POSITIVE_INFINITY;
  let py0 = Number.POSITIVE_INFINITY;
  let px1 = Number.NEGATIVE_INFINITY;
  let py1 = Number.NEGATIVE_INFINITY;
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  const addPoint = (x: number, y: number) => {
    const [ux, uy] = apply(gs.ctm, x, y);
    if (ux < px0) px0 = ux;
    if (uy < py0) py0 = uy;
    if (ux > px1) px1 = ux;
    if (uy > py1) py1 = uy;
  };
  const noteOp = (index: number, name: string) => {
    if (pathStart < 0) pathStart = index;
    if (pathBuilt.length < 64) pathBuilt += `${name} `;
  };
  /** Adds a point to the outline being built (in the stream's drawing space). */
  const outlinePoint = (x: number, y: number, newSubpath: boolean) => {
    const at = apply(gs.ctm, x, y);
    if (newSubpath || !currentSub) {
      currentSub = { points: [], closed: false };
      subpaths.push(currentSub);
    }
    if (outlineBudget > 0) {
      currentSub.points.push(at);
      outlineBudget -= 1;
    }
  };
  const closeSubpath = () => {
    if (currentSub) currentSub.closed = true;
  };
  /** A Bezier curve from the current point, flattened into a few segments for the outline. */
  const curveTo = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
    const x0 = cx;
    const y0 = cy;
    const steps = 6;
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const u = 1 - t;
      const x = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
      const y = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
      outlinePoint(x, y, false);
    }
    cx = x3;
    cy = y3;
  };
  const resetPath = () => {
    px0 = py0 = Number.POSITIVE_INFINITY;
    px1 = py1 = Number.NEGATIVE_INFINITY;
    pathStart = -1;
    pathBuilt = "";
    pendingClip = false;
    subpaths = [];
    currentSub = null;
    outlineBudget = MAX_OUTLINE_POINTS;
  };
  const paint = (fill: boolean, stroke: boolean, opIndex: number) => {
    if (!light && px1 >= px0 && pathStart >= 0 && walk.out.paths.length < walk.options.maxPaths) {
      walk.out.paths.push({
        id: `${key}#${opIndex}`,
        source,
        startOp: pathStart,
        endOp: opIndex,
        box: { x: px0, y: py0, width: px1 - px0, height: py1 - py0 },
        fill,
        stroke,
        depth,
        ctm: gs.ctm,
        clipped: pendingClip,
        seq: walk.seq++,
        built: pathBuilt.trim(),
        outline: outlineBudget > 0 ? subpaths.filter((sub) => sub.points.length > 0) : null,
      });
    }
    resetPath();
  };

  const setFill = (space: string | null, values: readonly number[]) => {
    gs.fill = colorFromComponents(space, values);
  };

  const showText = (op: Operation, opIndex: number, operator: TextRun["operator"], newline: boolean) => {
    if (!gs.font) {
      // Text before any Tf: the spec leaves this undefined; treat as an unknown font so the walk can go on.
      gs.font = missingFont(walk, "?");
    }
    const font = gs.font;

    // Gather strings and adjustments from the operands.
    const list: ({ kind: "str"; operand: Extract<Operand, { t: "str" }> } | { kind: "adj"; operand: Extract<Operand, { t: "num" }> })[] = [];
    if (operator === "TJ") {
      const array = op.args[op.args.length - 1];
      if (array?.t !== "arr") return;
      for (const item of array.items) {
        if (item.t === "str") list.push({ kind: "str", operand: item });
        else if (item.t === "num") list.push({ kind: "adj", operand: item });
      }
    } else {
      const operand = op.args[op.args.length - 1];
      if (operand?.t !== "str") return;
      list.push({ kind: "str", operand });
    }

    if (light) {
      for (const item of list) {
        if (item.kind === "str") for (const glyph of font.decode(item.operand.bytes)) font.used.add(glyph.code);
      }
      return;
    }
    if (walk.out.runs.length >= walk.options.maxRuns) {
      walk.out.truncated = true;
      return;
    }

    const elements: RunElement[] = [];
    let x = 0;
    let text = "";
    const th = gs.th;
    for (const item of list) {
      if (item.kind === "adj") {
        const advance = (-item.operand.v / 1000) * gs.fontSize * th;
        elements.push({ kind: "adj", value: item.operand.v, x, advance, start: item.operand.s, end: item.operand.e });
        x += advance;
        if (-item.operand.v > 200 && text !== "" && !text.endsWith(" ")) text += " ";
        continue;
      }
      const glyphs: RunGlyph[] = [];
      for (const code of font.decode(item.operand.bytes) as GlyphCode[]) {
        const width = font.widthOf(code.code);
        const advance = ((width / 1000) * gs.fontSize + gs.tc + (font.isWordSpace(code) ? gs.tw : 0)) * th;
        const glyphText = font.unicodeOf(code.code) ?? "";
        glyphs.push({ code: code.code, length: code.length, text: glyphText, width, x, advance });
        text += glyphText;
        x += advance;
        font.used.add(code.code);
      }
      elements.push({ kind: "str", bytes: item.operand.bytes, glyphs, start: item.operand.s, end: item.operand.e, hex: item.operand.hex });
    }

    const matrix = multiply(tm, gs.ctm);
    const ascent = (font.ascent / 1000) * gs.fontSize;
    const descent = (font.descent / 1000) * gs.fontSize;
    // The box covers the drawn glyphs, not spacing that trails after the last one.
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    for (const element of elements) {
      if (element.kind !== "str") continue;
      for (const glyph of element.glyphs) {
        left = Math.min(left, glyph.x);
        right = Math.max(right, glyph.x + Math.max(0, (glyph.width / 1000) * gs.fontSize * th));
      }
    }
    if (!Number.isFinite(left)) {
      left = Math.min(0, x);
      right = Math.max(0, x);
    }
    const box = transformRect(matrix, { x: left, y: gs.rise + descent, width: Math.max(0, right - left), height: ascent - descent });
    const run: TextRun = {
      id: `${key}#${opIndex}`,
      source,
      opIndex,
      op,
      operator,
      elements,
      font,
      fontName: gs.fontName,
      fontSize: gs.fontSize,
      charSpacing: gs.tc,
      wordSpacing: gs.tw,
      hScale: th,
      rise: gs.rise,
      renderMode: gs.tr,
      leading: gs.tl,
      matrix,
      textMatrix: tm,
      lineMatrix: tlm,
      ctm: gs.ctm,
      advance: x,
      text,
      box,
      fill: gs.fill,
      actualText: currentActual,
      actualOp: currentActualOp,
      textObject,
      flowFrom: flowRun,
      newline,
      depth,
      seq: walk.seq++,
    };
    walk.out.runs.push(run);
    flowRun = walk.out.runs.length - 1;
    tm = multiply(translation(x, 0), tm);
  };

  const nextLine = () => {
    tlm = multiply(translation(0, -gs.tl), tlm);
    tm = tlm;
    flowRun = null;
  };

  for (let opIndex = 0; opIndex < ops.length; opIndex += 1) {
    const op = ops[opIndex] as Operation;
    const args = op.args;
    switch (op.op) {
      // ---- graphics state --------------------------------------------------------------------------------------
      case "q":
        if (stack.length < MAX_GRAPHICS_STACK) stack.push({ ...gs });
        break;
      case "Q": {
        const previous = stack.pop();
        if (previous) gs = previous;
        break;
      }
      case "cm": {
        const m = numbersOf(args, 6);
        if (m) {
          const next = multiply(m as unknown as Matrix, gs.ctm);
          if (isFiniteMatrix(next)) gs.ctm = next;
        }
        break;
      }
      // ---- text objects and positioning ------------------------------------------------------------------------
      case "BT":
        textObject += 1;
        tm = IDENTITY;
        tlm = IDENTITY;
        flowRun = null;
        break;
      case "ET":
        flowRun = null;
        break;
      case "Td":
      case "TD": {
        const t = numbersOf(args, 2);
        if (t) {
          if (op.op === "TD") gs.tl = -(t[1] as number);
          tlm = multiply(translation(t[0] as number, t[1] as number), tlm);
          tm = tlm;
          flowRun = null;
        }
        break;
      }
      case "Tm": {
        const m = numbersOf(args, 6);
        if (m && isFiniteMatrix(m as unknown as Matrix)) {
          tm = m as unknown as Matrix;
          tlm = tm;
          flowRun = null;
        }
        break;
      }
      case "T*":
        nextLine();
        break;
      // ---- text state ------------------------------------------------------------------------------------------
      case "Tf": {
        const name = args[0];
        const size = numberArg(args, 1);
        if (name?.t === "name" && size !== null) {
          gs.fontName = name.v;
          gs.fontSize = size;
          gs.font = getFont(walk, source.resources, name.v) ?? missingFont(walk, name.v);
        }
        break;
      }
      case "Tc": {
        const v = numberArg(args, 0);
        if (v !== null) gs.tc = v;
        break;
      }
      case "Tw": {
        const v = numberArg(args, 0);
        if (v !== null) gs.tw = v;
        break;
      }
      case "Tz": {
        const v = numberArg(args, 0);
        if (v !== null) gs.th = v / 100;
        break;
      }
      case "TL": {
        const v = numberArg(args, 0);
        if (v !== null) gs.tl = v;
        break;
      }
      case "Ts": {
        const v = numberArg(args, 0);
        if (v !== null) gs.rise = v;
        break;
      }
      case "Tr": {
        const v = numberArg(args, 0);
        if (v !== null) gs.tr = v;
        break;
      }
      // ---- showing text ----------------------------------------------------------------------------------------
      case "Tj":
      case "TJ":
        showText(op, opIndex, op.op, false);
        break;
      case "'":
        nextLine();
        showText(op, opIndex, "'", true);
        break;
      case '"': {
        const aw = numberArg(args, 0);
        const ac = numberArg(args, 1);
        if (aw !== null) gs.tw = aw;
        if (ac !== null) gs.tc = ac;
        nextLine();
        showText(op, opIndex, '"', true);
        break;
      }
      // ---- colour (fill only; that is the text colour) ---------------------------------------------------------
      case "g": {
        const v = numberArg(args, 0);
        if (v !== null) {
          gs.fillSpace = "DeviceGray";
          setFill("DeviceGray", [v]);
        }
        break;
      }
      case "rg": {
        const v = numbersOf(args, 3);
        if (v) {
          gs.fillSpace = "DeviceRGB";
          setFill("DeviceRGB", v);
        }
        break;
      }
      case "k": {
        const v = numbersOf(args, 4);
        if (v) {
          gs.fillSpace = "DeviceCMYK";
          setFill("DeviceCMYK", v);
        }
        break;
      }
      case "cs": {
        const name = args[0];
        if (name?.t === "name") {
          gs.fillSpace = colorSpaceName(source.resources, name.v);
          gs.fill = gs.fillSpace === "DeviceGray" || gs.fillSpace === "CalGray" ? "#000000" : gs.fillSpace === "DeviceRGB" || gs.fillSpace === "CalRGB" ? "#000000" : gs.fillSpace === "DeviceCMYK" ? "#000000" : null;
        }
        break;
      }
      case "sc":
      case "scn": {
        const values = args.filter((a): a is Extract<Operand, { t: "num" }> => a.t === "num").map((a) => a.v);
        if (values.length > 0 && args[args.length - 1]?.t === "num") setFill(gs.fillSpace, values);
        else gs.fill = null; // a pattern or a name
        break;
      }
      // ---- marked content --------------------------------------------------------------------------------------
      case "BDC":
      case "BMC": {
        let actual: string | null = null;
        if (op.op === "BDC") {
          const props = args[1];
          if (props?.t === "dict") {
            const value = props.entries.get("ActualText");
            if (value?.t === "str") actual = decodeActualText(value.bytes);
          } else if (props?.t === "name") {
            const { object } = lookupResource(source.resources, N.Properties, props.v);
            if (object instanceof PDFDict) actual = textOfPdfString(object.lookup(N.ActualText));
          }
        }
        marked.push({ actualText: actual, op: opIndex });
        if (actual !== null) {
          currentActual = actual;
          currentActualOp = opIndex;
        }
        break;
      }
      case "EMC": {
        marked.pop();
        currentActual = null;
        currentActualOp = null;
        for (let i = marked.length - 1; i >= 0; i -= 1) {
          const candidate = marked[i] as { actualText: string | null; op: number };
          if (candidate.actualText !== null) {
            currentActual = candidate.actualText;
            currentActualOp = candidate.op;
            break;
          }
        }
        break;
      }
      // ---- paths (extents, outlines and the operators that built them) ----------------------------------------------
      case "m": {
        const v = numbersOf(args, 2);
        if (v) {
          noteOp(opIndex, "m");
          cx = v[0] as number;
          cy = v[1] as number;
          startX = cx;
          startY = cy;
          addPoint(cx, cy);
          outlinePoint(cx, cy, true);
        }
        break;
      }
      case "l": {
        const v = numbersOf(args, 2);
        if (v) {
          noteOp(opIndex, "l");
          cx = v[0] as number;
          cy = v[1] as number;
          addPoint(cx, cy);
          outlinePoint(cx, cy, false);
        }
        break;
      }
      case "c": {
        const v = numbersOf(args, 6);
        if (v) {
          noteOp(opIndex, "c");
          addPoint(v[0] as number, v[1] as number);
          addPoint(v[2] as number, v[3] as number);
          addPoint(v[4] as number, v[5] as number);
          curveTo(v[0] as number, v[1] as number, v[2] as number, v[3] as number, v[4] as number, v[5] as number);
        }
        break;
      }
      case "v": {
        const v = numbersOf(args, 4);
        if (v) {
          noteOp(opIndex, "c");
          addPoint(v[0] as number, v[1] as number);
          addPoint(v[2] as number, v[3] as number);
          curveTo(cx, cy, v[0] as number, v[1] as number, v[2] as number, v[3] as number);
        }
        break;
      }
      case "y": {
        const v = numbersOf(args, 4);
        if (v) {
          noteOp(opIndex, "c");
          addPoint(v[0] as number, v[1] as number);
          addPoint(v[2] as number, v[3] as number);
          curveTo(v[0] as number, v[1] as number, v[2] as number, v[3] as number, v[2] as number, v[3] as number);
        }
        break;
      }
      case "h":
        noteOp(opIndex, "h");
        closeSubpath();
        cx = startX;
        cy = startY;
        break;
      case "re": {
        const v = numbersOf(args, 4);
        if (v) {
          noteOp(opIndex, "re");
          const [x, y, w, h] = v as [number, number, number, number];
          addPoint(x, y);
          addPoint(x + w, y + h);
          addPoint(x + w, y);
          addPoint(x, y + h);
          outlinePoint(x, y, true);
          outlinePoint(x + w, y, false);
          outlinePoint(x + w, y + h, false);
          outlinePoint(x, y + h, false);
          closeSubpath();
          cx = x;
          cy = y;
          startX = x;
          startY = y;
        }
        break;
      }
      case "W":
      case "W*":
        pendingClip = true;
        break;
      case "S":
        paint(false, true, opIndex);
        break;
      case "s":
        closeSubpath();
        paint(false, true, opIndex);
        break;
      case "f":
      case "F":
      case "f*":
        paint(true, false, opIndex);
        break;
      case "B":
      case "B*":
        paint(true, true, opIndex);
        break;
      case "b":
      case "b*":
        closeSubpath();
        paint(true, true, opIndex);
        break;
      case "n":
        resetPath();
        break;
      // ---- XObjects ---------------------------------------------------------------------------------------------
      case "Do": {
        const name = args[args.length - 1];
        if (name?.t !== "name") break;
        const { entry, object } = lookupResource(source.resources, N.XObject, name.v);
        if (!(object instanceof PDFStream)) break;
        const subtype = object.dict.lookup(N.Subtype);
        if (subtype === N.Image) {
          if (light) break;
          const wpx = object.dict.lookup(N.Width);
          const hpx = object.dict.lookup(N.Height);
          walk.out.images.push({
            id: `${key}#${opIndex}`,
            source,
            opIndex,
            name: name.v,
            ref: entry instanceof PDFRef ? entry : null,
            inline: false,
            matrix: gs.ctm,
            box: transformRect(gs.ctm, { x: 0, y: 0, width: 1, height: 1 }),
            pixelWidth: wpx instanceof PDFNumber ? wpx.asNumber() : null,
            pixelHeight: hpx instanceof PDFNumber ? hpx.asNumber() : null,
            depth,
            seq: walk.seq++,
          });
        } else if (subtype === N.Form) {
          const use: FormUse = { name: name.v, ref: entry instanceof PDFRef ? entry : null, depth, source, opIndex, content: null };
          walk.out.forms.push(use);
          if (depth >= walk.options.maxFormDepth) {
            walk.out.problems.push("Forms are nested too deeply; the inner ones were not read.");
            break;
          }
          const cacheKey = entry instanceof PDFRef ? entry.toString() : `inline:${source.id}#${opIndex}`;
          if (walk.active.has(cacheKey)) break; // a form that draws itself
          let formSource = walk.formSources.get(cacheKey);
          if (!formSource && object instanceof PDFRawStream) {
            formSource = readFormContent(entry instanceof PDFRef ? entry : null, object, source.resources);
            walk.formSources.set(cacheKey, formSource);
          }
          if (!formSource) break;
          use.content = formSource;
          const formMatrix = readMatrix(object.dict.lookupMaybe(N.Matrix, PDFArray)) ?? IDENTITY;
          walk.active.add(cacheKey);
          try {
            interpretSource(walk, formSource, multiply(formMatrix, gs.ctm), depth + 1, `${key}/${name.v}@${opIndex}`);
          } finally {
            walk.active.delete(cacheKey);
          }
        }
        break;
      }
      case "BI": {
        if (light) break;
        const matrix = gs.ctm;
        walk.out.images.push({
          id: `${key}#${opIndex}`,
          source,
          opIndex,
          name: null,
          ref: null,
          inline: true,
          matrix,
          box: transformRect(matrix, { x: 0, y: 0, width: 1, height: 1 }),
          pixelWidth: numberFromOperand(op.inline?.dict.get("W") ?? op.inline?.dict.get("Width")),
          pixelHeight: numberFromOperand(op.inline?.dict.get("H") ?? op.inline?.dict.get("Height")),
          depth,
          seq: walk.seq++,
        });
        break;
      }
      default:
        break;
    }
  }
}

const numberFromOperand = (operand: Operand | undefined): number | null => (operand && operand.t === "num" ? operand.v : null);

function readMatrix(array: PDFArray | undefined): Matrix | null {
  if (!array || array.size() < 6) return null;
  const values: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const n = array.lookup(i);
    if (!(n instanceof PDFNumber)) return null;
    values.push(n.asNumber());
  }
  return values as unknown as Matrix;
}

/** ActualText is a PDF text string: UTF-16BE with a BOM, or PDFDocEncoding (Latin-1 here). */
function decodeActualText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let text = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) text += String.fromCharCode(((bytes[i] as number) << 8) | (bytes[i + 1] as number));
    return text;
  }
  return Array.from(bytes, (b) => String.fromCharCode(b)).join("");
}

/** Interprets one content source (a page's content) and everything it draws. */
export function interpret(
  doc: PDFDocument,
  source: ContentSource,
  startCtm: Matrix,
  fonts: FontCache,
  options: InterpretOptions = {},
  shared?: { formSources: Map<string, ContentSource>; seedUsed?: ReadonlyMap<string, ReadonlySet<number>> },
): Interpretation {
  const out: Interpretation = { runs: [], images: [], paths: [], forms: [], sources: [source], problems: [], truncated: false };
  const walk: Walk = {
    doc,
    fonts,
    out,
    options: { light: options.light ?? false, maxRuns: options.maxRuns ?? MAX_RUNS, maxPaths: options.maxPaths ?? MAX_PATHS, maxFormDepth: options.maxFormDepth ?? MAX_FORM_DEPTH },
    active: new Set(),
    formSources: shared?.formSources ?? new Map(),
    seedUsed: shared?.seedUsed,
    seq: 0,
  };
  interpretSource(walk, source, startCtm, 0, "page");
  for (const formSource of walk.formSources.values()) if (!out.sources.includes(formSource)) out.sources.push(formSource);
  out.problems = [...new Set(out.problems)];
  return out;
}

/** The glyph's box in the space the run draws in, for hit-testing and redaction. */
export function glyphBox(run: TextRun, glyph: RunGlyph): Rect {
  const ascent = (run.font.ascent / 1000) * run.fontSize;
  const descent = (run.font.descent / 1000) * run.fontSize;
  const width = (glyph.width / 1000) * run.fontSize * run.hScale;
  return transformRect(run.matrix, { x: glyph.x, y: run.rise + descent, width, height: ascent - descent });
}
