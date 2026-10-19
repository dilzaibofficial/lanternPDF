/** Draws slides onto PDF pages. */
import { familyFor, symbolKindOf, symbolToUnicode } from "../fontLibrary";
import { type EmbeddedImage, type GradientDef, type PageBuilder, type PdfBuilder, type StrokeStyle, rgb } from "../pdfBuilder";
import { type DrawContext, type InlineItem, type Line, type ParagraphShape, type TextShaper, type TextStyle, breakLines, buildAtoms, drawLine, drawPicture, linesHeight } from "../textflow";
import type { Warnings } from "../warnings";
import { type DrawPath, geometryPaths, textRectOf } from "./geometry";
import type { FillDef, LineDef, PresentationM, RunStyle, ShapeM, SlideM, TableCellM, TextBodyM, Transform } from "./model";
import { formatNumber } from "./text";

export interface RenderContext {
  builder: PdfBuilder;
  shaper: TextShaper;
  images: ReadonlyMap<string, EmbeddedImage>;
  warnings: Warnings;
  /** Page index (in the PDF) of each slide, by its part name, for links between slides. */
  pageOfSlide: ReadonlyMap<string, number>;
  model: PresentationM;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const DEFAULT_SIZE = 18;

export function toTextStyle(run: RunStyle, scale: number, pageOfSlide?: ReadonlyMap<string, number>): TextStyle {
  const symbolKind = symbolKindOf(run.fontName);
  const baseline = run.baseline ?? 0;
  const style: TextStyle = {
    family: familyFor(run.fontName),
    bold: run.bold ?? false,
    italic: run.italic ?? false,
    size: (run.size ?? DEFAULT_SIZE) * scale,
    color: run.color ?? "#000000",
    underline: run.underline,
    strike: run.strike,
    caps: run.caps === "all",
    smallCaps: run.caps === "small",
    script: baseline > 0 ? "super" : baseline < 0 ? "sub" : undefined,
    spacing: run.spacing,
  };
  if (run.link) style.link = { uri: run.link };
  else if (run.linkSlide) {
    const page = pageOfSlide?.get(run.linkSlide);
    if (page !== undefined) style.link = { page };
  }
  if (symbolKind) {
    style.symbol = true;
    style.symbolKind = symbolKind;
  }
  return style;
}

/** Picture-font characters are stored as plain codes (a tick is "ü" in Wingdings); the shaper expects them in the private-use block. */
function symbolText(text: string, style: TextStyle): string {
  if (!style.symbol) return text;
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    out += code >= 0x20 && code < 0x100 ? String.fromCodePoint(0xf000 + code) : char;
  }
  return out;
}

function pushText(items: InlineItem[], text: string, style: TextStyle): void {
  const pieces = text.split(new RegExp("([" + String.fromCharCode(9, 10, 11) + "])"));
  for (const piece of pieces) {
    if (piece === "") continue;
    if (piece === "\t") items.push({ kind: "tab", style });
    else if (piece === "\n" || piece === "\u000b") items.push({ kind: "break", type: "line", style });
    else items.push({ kind: "text", text: symbolText(piece, style), style });
  }
}

// ---- text layout -----------------------------------------------------------------------------------------

interface LaidParagraph {
  lines: Line[];
  before: number;
  after: number;
  marL: number;
  align: "l" | "ctr" | "r" | "just" | "dist";
  bullet?: { text: string; style: TextStyle; x: number };
}

interface LaidText {
  paragraphs: LaidParagraph[];
  height: number;
}

const ALIGN: Record<string, ParagraphShape["align"]> = { l: "left", ctr: "center", r: "right", just: "justify", dist: "distribute" };

/** The character a bullet shows. Picture-font bullets ("§" in Wingdings) are mapped to real symbols. */
export function bulletText(char: string | undefined, font: string | undefined): { text: string; symbolKind?: ReturnType<typeof symbolKindOf> } {
  const value = char && char !== "" ? char : "•";
  const kind = symbolKindOf(font);
  if (!kind) return { text: value };
  const code = value.codePointAt(0) as number;
  const mapped = symbolToUnicode(code < 0x100 ? 0xf000 + code : code, kind);
  return mapped >= 0xf000 && mapped <= 0xf0ff ? { text: "•" } : { text: String.fromCodePoint(mapped) };
}

function layoutText(rc: RenderContext, slide: SlideM, text: TextBodyM, width: number, scale: number, reduction: number): LaidText {
  const { shaper } = rc;
  const paragraphs: LaidParagraph[] = [];
  let height = 0;
  text.paragraphs.forEach((paragraph, index) => {
    const base = toTextStyle(paragraph.run, scale, rc.pageOfSlide);
    const items: InlineItem[] = [];
    let lead: TextStyle | undefined;
    let hasText = false;
    for (const item of paragraph.items) {
      const style = toTextStyle(item.style, scale, rc.pageOfSlide);
      lead ??= style;
      if (item.kind === "run") {
        pushText(items, item.text, style);
        if (item.text.trim() !== "") hasText = true;
      } else if (item.kind === "break") {
        items.push({ kind: "break", type: "line", style });
      } else {
        const shown = item.slideNumber ? String(slide.number) : item.text;
        pushText(items, shown, style);
        if (shown.trim() !== "") hasText = true;
      }
    }
    const leadStyle = lead ?? base;
    const marL = paragraph.style.marL ?? 0;
    const marR = paragraph.style.marR ?? 0;
    const indent = paragraph.style.indent ?? 0;

    let bullet: LaidParagraph["bullet"];
    let firstOffset = indent;
    const definition = paragraph.style.bullet;
    if (hasText && definition && (definition.kind === "char" || definition.kind === "auto")) {
      const bulletFont = definition.font && !definition.font.startsWith("+") ? definition.font : undefined;
      const symbol = definition.kind === "char" ? bulletText(definition.char, bulletFont) : { text: formatNumber(definition.autoType ?? "arabicPeriod", paragraph.number ?? 1) };
      const style: TextStyle = { ...leadStyle, underline: undefined, strike: undefined, link: undefined, size: leadStyle.size * (definition.sizePct ?? 1), color: definition.color ?? leadStyle.color, caps: false, smallCaps: false, script: undefined, symbol: false, symbolKind: undefined };
      if (bulletFont) style.family = familyFor(bulletFont);
      const bulletWidth = shaper.width(symbol.text, style);
      const bulletX = marL + indent;
      const textStart = indent < 0 ? Math.max(marL, bulletX + bulletWidth + leadStyle.size * 0.15) : bulletX + bulletWidth + leadStyle.size * 0.3;
      firstOffset = textStart - marL;
      bullet = { text: symbol.text, style, x: bulletX };
    }

    const exact = paragraph.style.lnPts !== undefined;
    const shape: ParagraphShape = {
      width: Math.max(1, width - marL - marR),
      firstLineOffset: firstOffset,
      leftIndent: marL,
      align: text.wrap ? (ALIGN[paragraph.style.align ?? "l"] ?? "left") : "left",
      tabs: [],
      defaultTabStop: paragraph.style.defTab ?? 72,
      lineRule: exact ? "exact" : "auto",
      lineValue: exact ? (paragraph.style.lnPts as number) * (1 - reduction) : Math.max(0.3, (paragraph.style.lnPct ?? 1) - reduction),
      markStyle: base,
    };
    const lines = breakLines(buildAtoms(items, shaper), shape, shaper);
    const reference = leadStyle.size * 1.2;
    const before = paragraph.style.spcBefPts !== undefined ? paragraph.style.spcBefPts : (paragraph.style.spcBefPct ?? 0) * reference;
    const after = paragraph.style.spcAftPts !== undefined ? paragraph.style.spcAftPts : (paragraph.style.spcAftPct ?? 0) * reference;
    const laid: LaidParagraph = { lines, before: index === 0 ? 0 : before * (1 - reduction), after: after * (1 - reduction), marL, align: paragraph.style.align ?? "l", bullet };
    paragraphs.push(laid);
    height += laid.before + linesHeight(lines);
    if (index < text.paragraphs.length - 1) height += laid.after;
  });
  return { paragraphs, height };
}

/** Lays text out in a box of the given size, shrinking it to fit when the shape asks for that. */
function fitText(rc: RenderContext, slide: SlideM, text: TextBodyM, areaW: number, areaH: number): LaidText {
  const width = text.wrap ? Math.max(1, areaW) : 1_000_000;
  let scale = text.autofit === "norm" ? text.fontScale : 1;
  let reduction = text.autofit === "norm" ? text.lnReduction : 0;
  let laid = layoutText(rc, slide, text, width, scale, reduction);
  if (text.autofit === "norm" && laid.height > areaH + 0.5) {
    for (let next = Math.min(scale, 1) - 0.05; next >= 0.3; next -= 0.05) {
      scale = next;
      reduction = next < 0.9 ? 0.2 : 0.1;
      laid = layoutText(rc, slide, text, width, scale, reduction);
      if (laid.height <= areaH + 0.5) break;
    }
  }
  return laid;
}

function paintBullet(rc: RenderContext, page: PageBuilder, bullet: NonNullable<LaidParagraph["bullet"]>, x: number, baseline: number): void {
  let cursor = x + bullet.x;
  for (const piece of rc.shaper.shape(bullet.text, bullet.style)) {
    page.text(piece.font, piece.size, cursor, baseline - piece.rise, piece.text, bullet.style.color);
    cursor += piece.width;
  }
}

/** Draws laid-out text with its first line at `top` inside an area of the given width. */
function paintLaidText(rc: RenderContext, page: PageBuilder, slide: SlideM, laid: LaidText, text: TextBodyM, area: Box): void {
  const free = area.h - laid.height;
  let y = area.y + (text.anchor === "t" ? 0 : text.anchor === "ctr" ? free / 2 : free);
  const context: DrawContext = { page, shaper: rc.shaper, pageNumber: slide.number, pageCount: 0 };
  laid.paragraphs.forEach((paragraph, index) => {
    if (index > 0) y += paragraph.before;
    paragraph.lines.forEach((line, lineIndex) => {
      let x = area.x + paragraph.marL;
      // Without wrapping a line may be wider than the box; it is aligned to the box the way PowerPoint does.
      if (!text.wrap) x += paragraph.align === "ctr" ? (area.w - paragraph.marL - line.width) / 2 : paragraph.align === "r" ? area.w - paragraph.marL - line.width : 0;
      drawLine(context, line, x, y);
      if (lineIndex === 0 && paragraph.bullet) paintBullet(rc, page, paragraph.bullet, area.x, y + line.baseline);
      y += line.height;
    });
    y += paragraph.after;
  });
}

/** Text inside the box `outer` (insets and vertical text handled); returns how tall the text is. */
function paintText(rc: RenderContext, page: PageBuilder, slide: SlideM, text: TextBodyM, outer: Box): number {
  const vertical = text.vert !== "horz";
  const frame: Box = vertical ? { x: outer.x + outer.w / 2 - outer.h / 2, y: outer.y + outer.h / 2 - outer.w / 2, w: outer.h, h: outer.w } : outer;
  const area: Box = { x: frame.x + text.insets.l, y: frame.y + text.insets.t, w: Math.max(1, frame.w - text.insets.l - text.insets.r), h: Math.max(1, frame.h - text.insets.t - text.insets.b) };
  const laid = fitText(rc, slide, text, area.w, area.h);
  page.save();
  if (vertical) page.rotateAbout(outer.x + outer.w / 2, outer.y + outer.h / 2, text.vert === "vert" ? 90 : 270);
  paintLaidText(rc, page, slide, laid, text, area);
  page.restore();
  return laid.height + text.insets.t + text.insets.b;
}

// ---- fills, lines, paths ---------------------------------------------------------------------------------

function shadeColor(color: string, amount: number): string {
  if (!amount) return color;
  const [r, g, b] = rgb(color).map((value) => value * 255) as [number, number, number];
  const mix = (channel: number) => Math.round(Math.min(255, Math.max(0, amount > 0 ? channel + (255 - channel) * amount : channel * (1 + amount))));
  return `#${[r, g, b].map((channel) => mix(channel).toString(16).padStart(2, "0")).join("")}`;
}

function pathString(page: PageBuilder, path: DrawPath, dx: number, dy: number): string {
  const parts: string[] = [];
  const p = path.points;
  let i = 0;
  for (const command of path.commands) {
    if (command === "M") {
      parts.push(page.pathOps.move(dx + (p[i] as number), dy + (p[i + 1] as number)));
      i += 2;
    } else if (command === "L") {
      parts.push(page.pathOps.line(dx + (p[i] as number), dy + (p[i + 1] as number)));
      i += 2;
    } else if (command === "C") {
      parts.push(page.pathOps.curve(dx + (p[i] as number), dy + (p[i + 1] as number), dx + (p[i + 2] as number), dy + (p[i + 3] as number), dx + (p[i + 4] as number), dy + (p[i + 5] as number)));
      i += 6;
    } else {
      parts.push(page.pathOps.close());
    }
  }
  return parts.join(" ");
}

function gradientFor(fill: Extract<FillDef, { kind: "gradient" }>, box: Box, shade: number): GradientDef {
  const stops = fill.stops.map((stop) => ({ position: stop.position, color: shadeColor(stop.color, shade) }));
  if (fill.radial) {
    const cx = box.x + fill.focus.x * box.w;
    const cy = box.y + fill.focus.y * box.h;
    const reach = Math.max(Math.hypot(cx - box.x, cy - box.y), Math.hypot(box.x + box.w - cx, cy - box.y), Math.hypot(cx - box.x, box.y + box.h - cy), Math.hypot(box.x + box.w - cx, box.y + box.h - cy));
    return { kind: "radial", stops, cx, cy, r0: 0, r1: Math.max(1, reach) };
  }
  const angle = (fill.angle * Math.PI) / 180;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const length = Math.abs(box.w * dx) + Math.abs(box.h * dy) || 1;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return { kind: "linear", stops, x0: cx - (dx * length) / 2, y0: cy - (dy * length) / 2, x1: cx + (dx * length) / 2, y1: cy + (dy * length) / 2 };
}

function paintFill(rc: RenderContext, page: PageBuilder, fill: FillDef, d: string, box: Box, shade = 0, evenOdd = false): void {
  if (fill.kind === "solid") {
    page.path(d, { fill: shadeColor(fill.color, shade), opacity: fill.alpha, evenOdd });
  } else if (fill.kind === "gradient") {
    page.gradient(d, gradientFor(fill, box, shade));
  } else if (fill.kind === "picture") {
    const image = rc.images.get(fill.part);
    if (!image) return;
    page.save();
    page.clipPath(d, evenOdd);
    drawPicture(page, image, box.x, box.y, box.w, box.h, fill.crop, fill.alpha);
    page.restore();
  }
}

function strokeOf(line: LineDef): { stroke: StrokeStyle; opacity: number } | null {
  const fill = line.fill;
  if (fill.kind === "none") return null;
  const color = fill.kind === "solid" ? fill.color : fill.kind === "gradient" ? (fill.stops[0]?.color ?? "#000000") : "#000000";
  const opacity = fill.kind === "solid" || fill.kind === "gradient" ? fill.alpha : 1;
  const width = Math.max(0.25, line.width);
  return { stroke: { color, width, dash: line.dash?.map((value) => value * Math.max(width, 0.75)), cap: line.cap }, opacity };
}

/** A small filled arrow head with its tip at (x, y), pointing along the direction (dx, dy). */
function arrowHead(page: PageBuilder, x: number, y: number, dx: number, dy: number, line: LineDef): void {
  const length = Math.hypot(dx, dy);
  const painted = strokeOf(line);
  if (length === 0 || !painted) return;
  const ux = dx / length;
  const uy = dy / length;
  const size = Math.max(5, painted.stroke.width * 3.2);
  const wing = size * 0.45;
  const bx = x - ux * size;
  const by = y - uy * size;
  const d = [page.pathOps.move(x, y), page.pathOps.line(bx - uy * wing, by + ux * wing), page.pathOps.line(bx + uy * wing, by - ux * wing), page.pathOps.close()].join(" ");
  page.path(d, { fill: painted.stroke.color, opacity: painted.opacity });
}

function drawArrowHeads(page: PageBuilder, path: DrawPath, line: LineDef, dx: number, dy: number): void {
  const p = path.points;
  if (p.length < 4 || path.commands.includes("Z")) return;
  if (line.headArrow) arrowHead(page, dx + (p[0] as number), dy + (p[1] as number), (p[0] as number) - (p[2] as number), (p[1] as number) - (p[3] as number), line);
  if (line.tailArrow) {
    const n = p.length;
    arrowHead(page, dx + (p[n - 2] as number), dy + (p[n - 1] as number), (p[n - 2] as number) - (p[n - 4] as number), (p[n - 1] as number) - (p[n - 3] as number), line);
  }
}

/** Everything drawn until the matching `restore()` is turned and mirrored the way the shape is. */
function applyTransform(page: PageBuilder, xf: Transform): void {
  if (xf.rot !== 0 || xf.flipH || xf.flipV) page.rotateAbout(xf.x + xf.w / 2, xf.y + xf.h / 2, xf.rot, xf.flipH, xf.flipV);
}

function linkTarget(rc: RenderContext, link: { uri?: string; slide?: string } | undefined): { uri?: string; page?: number } | undefined {
  if (!link) return undefined;
  if (link.uri) return { uri: link.uri };
  const page = link.slide ? rc.pageOfSlide.get(link.slide) : undefined;
  return page === undefined ? undefined : { page };
}

// ---- shapes ----------------------------------------------------------------------------------------------

function drawShape(rc: RenderContext, page: PageBuilder, slide: SlideM, shape: Extract<ShapeM, { kind: "shape" }>): void {
  const { xf } = shape;
  const box: Box = { x: xf.x, y: xf.y, w: xf.w, h: xf.h };
  const text = shape.text;

  // A shape that resizes to its text grows to the height the text needs.
  if (text?.autofit === "shape" && text.vert === "horz") {
    const rect = textRectOf(shape.geometry, box.w, box.h);
    const laid = fitText(rc, slide, text, rect.w - text.insets.l - text.insets.r, Number.POSITIVE_INFINITY);
    const needed = laid.height + text.insets.t + text.insets.b - rect.h;
    if (needed > 0.5) {
      if (text.anchor === "ctr") box.y -= needed / 2;
      else if (text.anchor === "b") box.y -= needed;
      box.h += needed;
    }
  }

  page.save();
  applyTransform(page, { ...xf, ...box });
  const built = geometryPaths(shape.geometry, box.w, box.h);
  const painted = shape.line ? strokeOf(shape.line) : null;
  for (const path of built.paths) {
    const d = pathString(page, path, box.x, box.y);
    if (path.fill && shape.fill.kind !== "none") paintFill(rc, page, shape.fill, d, box, path.shade ?? 0, path.evenOdd);
    if (path.stroke && painted && shape.line) {
      page.path(d, { stroke: painted.stroke, opacity: painted.opacity });
      drawArrowHeads(page, path, shape.line, box.x, box.y);
    }
  }
  page.restore();

  if (text) {
    // Text turns with the shape but is not mirrored; a shape flipped upside down also turns its text over.
    page.save();
    if (shape.textXf) {
      const own = shape.textXf;
      page.rotateAbout(own.x + own.w / 2, own.y + own.h / 2, own.rot);
      paintText(rc, page, slide, text, { x: own.x, y: own.y, w: own.w, h: own.h });
    } else {
      page.rotateAbout(box.x + box.w / 2, box.y + box.h / 2, xf.rot + (xf.flipV ? 180 : 0));
      const rect = textRectOf(shape.geometry, box.w, box.h);
      paintText(rc, page, slide, text, { x: box.x + rect.x, y: box.y + rect.y, w: rect.w, h: rect.h });
    }
    page.restore();
  }
  const target = linkTarget(rc, shape.link);
  if (target) page.link(box.x, box.y, box.w, box.h, target);
}

function drawPictureShape(rc: RenderContext, page: PageBuilder, shape: Extract<ShapeM, { kind: "picture" }>): void {
  const image = rc.images.get(shape.part);
  const { xf } = shape;
  if (!image) return;
  const box: Box = { x: xf.x, y: xf.y, w: xf.w, h: xf.h };
  page.save();
  applyTransform(page, xf);
  const built = shape.geometry ? geometryPaths(shape.geometry, box.w, box.h) : undefined;
  const first = built?.paths[0];
  if (first) {
    page.clipPath(pathString(page, first, box.x, box.y));
  }
  drawPicture(page, image, box.x, box.y, box.w, box.h, shape.crop, shape.alpha);
  page.restore();
  const painted = shape.line ? strokeOf(shape.line) : null;
  if (painted) {
    page.save();
    applyTransform(page, xf);
    if (first) page.path(pathString(page, first, box.x, box.y), { stroke: painted.stroke, opacity: painted.opacity });
    else page.strokeRect(box.x, box.y, box.w, box.h, painted.stroke);
    page.restore();
  }
  const target = linkTarget(rc, shape.link);
  if (target) page.link(box.x, box.y, box.w, box.h, target);
}

function drawTable(rc: RenderContext, page: PageBuilder, slide: SlideM, table: Extract<ShapeM, { kind: "table" }>): void {
  const { xf, columns, rows } = table;
  const columnX = [xf.x];
  for (const width of columns) columnX.push((columnX[columnX.length - 1] as number) + width);
  const spanWidth = (start: number, span: number) => (columnX[Math.min(columns.length, start + span)] as number) - (columnX[start] as number);

  // Rows grow to fit their text, as PowerPoint makes them.
  const heights = rows.map((row) => row.height);
  rows.forEach((row, r) => {
    row.cells.forEach((cell, c) => {
      if (cell.covered || cell.rowSpan > 1) return;
      const width = spanWidth(c, cell.gridSpan);
      const laid = fitText(rc, slide, cell.text, width - cell.text.insets.l - cell.text.insets.r, Number.POSITIVE_INFINITY);
      heights[r] = Math.max(heights[r] as number, laid.height + cell.text.insets.t + cell.text.insets.b);
    });
  });
  const rowY = [xf.y];
  for (const height of heights) rowY.push((rowY[rowY.length - 1] as number) + height);

  const cellBox = (r: number, c: number, cell: TableCellM): Box => ({ x: columnX[c] as number, y: rowY[r] as number, w: spanWidth(c, cell.gridSpan), h: (rowY[Math.min(rows.length, r + cell.rowSpan)] as number) - (rowY[r] as number) });
  rows.forEach((row, r) =>
    row.cells.forEach((cell, c) => {
      if (cell.covered) return;
      const box = cellBox(r, c, cell);
      if (cell.fill.kind !== "none") paintFill(rc, page, cell.fill, [page.pathOps.move(box.x, box.y), page.pathOps.line(box.x + box.w, box.y), page.pathOps.line(box.x + box.w, box.y + box.h), page.pathOps.line(box.x, box.y + box.h), page.pathOps.close()].join(" "), box);
    }),
  );
  rows.forEach((row, r) =>
    row.cells.forEach((cell, c) => {
      if (cell.covered || cell.text.paragraphs.every((paragraph) => paragraph.items.length === 0)) return;
      paintText(rc, page, slide, cell.text, cellBox(r, c, cell));
    }),
  );
  rows.forEach((row, r) =>
    row.cells.forEach((cell, c) => {
      if (cell.covered) return;
      const box = cellBox(r, c, cell);
      const edge = (line: LineDef | null, x1: number, y1: number, x2: number, y2: number) => {
        const painted = line ? strokeOf(line) : null;
        if (painted) page.line(x1, y1, x2, y2, painted.stroke);
      };
      edge(cell.borders.t, box.x, box.y, box.x + box.w, box.y);
      edge(cell.borders.b, box.x, box.y + box.h, box.x + box.w, box.y + box.h);
      edge(cell.borders.l, box.x, box.y, box.x, box.y + box.h);
      edge(cell.borders.r, box.x + box.w, box.y, box.x + box.w, box.y + box.h);
    }),
  );
}

export function renderSlide(rc: RenderContext, slide: SlideM): void {
  const { width, height } = rc.model;
  const page = rc.builder.addPage(width, height);
  const whole: Box = { x: 0, y: 0, w: width, h: height };
  const background = slide.background;
  const rect = [page.pathOps.move(0, 0), page.pathOps.line(width, 0), page.pathOps.line(width, height), page.pathOps.line(0, height), page.pathOps.close()].join(" ");
  page.fillRect(0, 0, width, height, "#ffffff");
  if (background && background.kind !== "none") paintFill(rc, page, background, rect, whole);

  for (const shape of slide.shapes) {
    if (shape.kind === "shape") drawShape(rc, page, slide, shape);
    else if (shape.kind === "picture") drawPictureShape(rc, page, shape);
    else drawTable(rc, page, slide, shape);
  }
}
