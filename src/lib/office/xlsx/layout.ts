/**
 * Spreadsheet layout and drawing: from a sheet to printed pages.
 *
 * A sheet is measured once (column widths, row heights with wrapped text), cut into pages the way Excel prints
 * (down then over, with the sheet's own scale or fit-to-page setting, or shrunk to the page width), and drawn
 * through a scaled view so that a sheet printed at 80% really is 80%.
 */
import SSF from "ssf";
import { type FamilyId, familyFor } from "../fontLibrary";
import type { EmbeddedImage, PageBuilder } from "../pdfBuilder";
import { type DrawContext, type InlineItem, type Line, type ParagraphShape, type TextShaper, type TextStyle, breakLines, buildAtoms, drawLine, drawPicture } from "../textflow";
import type { BorderSide, Cell, CellFormat, FontDef, MergeRange, Sheet, Workbook } from "./model";

export interface XlsxOptions {
  /** Shrink a sheet that is wider than the page so that all its columns fit across (never below half size). */
  fitWidth: boolean;
  orientation: "auto" | "portrait" | "landscape";
  gridlines: "sheet" | "on" | "off";
}

export const DEFAULT_XLSX_OPTIONS: XlsxOptions = { fitWidth: true, orientation: "auto", gridlines: "sheet" };

const PAPER: Record<number, [number, number]> = {
  1: [612, 792],
  2: [612, 792],
  3: [792, 1224],
  4: [1224, 792],
  5: [612, 1008],
  6: [396, 612],
  7: [522, 756],
  8: [842, 1191],
  9: [595, 842],
  10: [595, 842],
  11: [420, 595],
  12: [729, 1032],
  13: [516, 729],
};

const MIN_AUTO_SCALE = 0.5;
const PAD_X = 2;
const PAD_Y = 1;

function textStyle(font: FontDef): TextStyle {
  return {
    family: familyFor(font.name) as FamilyId,
    bold: font.bold,
    italic: font.italic,
    size: font.size,
    color: font.color ?? "#000000",
    underline: font.underline,
    strike: font.strike,
  };
}

const styleCache = new WeakMap<FontDef, TextStyle>();
function styleOf(font: FontDef): TextStyle {
  let style = styleCache.get(font);
  if (!style) {
    style = textStyle(font);
    styleCache.set(font, style);
  }
  return style;
}

interface CellLayout {
  lines: Line[];
  textWidth: number;
  textHeight: number;
  numeric: boolean;
  align: "left" | "center" | "right" | "justify";
  /** The text is wider than its cell and is not wrapped. */
  overflows: boolean;
  scale: number;
  tooWide: boolean;
}

function formatValue(cell: Cell, format: CellFormat, date1904: boolean): string {
  switch (cell.type) {
    case "number": {
      const value = cell.value as number;
      try {
        return SSF.format(format.numFmt === "" ? 0 : format.numFmt, value, { date1904 });
      } catch {
        return String(value);
      }
    }
    case "boolean":
      return cell.value ? "TRUE" : "FALSE";
    case "string":
    case "error":
      return String(cell.value ?? "");
    default:
      return "";
  }
}

export class SheetPlan {
  readonly columnX: number[] = [0];
  readonly rowY: number[] = [0];
  private readonly colWidths: number[] = [];
  private readonly rowHeights: number[] = [];
  private readonly merged = new Map<string, MergeRange>();
  private readonly covered = new Set<string>();
  private readonly layouts = new Map<string, CellLayout | null>();
  readonly firstRow: number;
  readonly firstColumn: number;
  private lastRowIndex: number;
  private lastColumnIndex: number;

  get lastRow(): number {
    return this.lastRowIndex;
  }

  get lastColumn(): number {
    return this.lastColumnIndex;
  }

  constructor(
    readonly sheet: Sheet,
    private readonly book: Workbook,
    private readonly shaper: TextShaper,
  ) {
    const area = sheet.printArea;
    this.firstRow = area?.row ?? 0;
    this.firstColumn = area?.col ?? 0;
    this.lastRowIndex = area ? area.row + area.rows - 1 : sheet.rowCount - 1;
    this.lastColumnIndex = area ? area.col + area.cols - 1 : sheet.columnCount - 1;
    for (const merge of sheet.merges) {
      this.merged.set(`${merge.row}:${merge.col}`, merge);
      for (let r = merge.row; r < merge.row + merge.rows; r += 1) for (let c = merge.col; c < merge.col + merge.cols; c += 1) if (r !== merge.row || c !== merge.col) this.covered.add(`${r}:${c}`);
    }
    const columns = Math.max(this.lastColumn + 1, 0);
    for (let c = 0; c < columns; c += 1) {
      const width = sheet.hiddenColumns.has(c) ? 0 : (sheet.columnWidths.get(c) ?? sheet.defaultColumnWidth);
      this.colWidths.push(width);
      this.columnX.push((this.columnX[c] as number) + width);
    }
    for (let r = 0; r <= this.lastRow; r += 1) {
      const height = this.measureRow(r);
      this.rowHeights.push(height);
      this.rowY.push((this.rowY[r] as number) + height);
    }
    // Without a print area, Excel prints everything: pictures, and text that spills past the last column.
    if (!area) this.extendForContent();
  }

  private addColumn(): void {
    const index = this.colWidths.length;
    const width = this.sheet.hiddenColumns.has(index) ? 0 : (this.sheet.columnWidths.get(index) ?? this.sheet.defaultColumnWidth);
    this.colWidths.push(width);
    this.columnX.push((this.columnX[index] as number) + width);
    this.lastColumnIndex = index;
  }

  private addRow(): void {
    const index = this.rowHeights.length;
    const height = this.sheet.hiddenRows.has(index) ? 0 : (this.sheet.rowHeights.get(index) ?? this.sheet.defaultRowHeight);
    this.rowHeights.push(height);
    this.rowY.push((this.rowY[index] as number) + height);
    this.lastRowIndex = index;
  }

  private extendForContent(): void {
    for (const image of this.sheet.images) {
      if (image.to) {
        while (this.lastColumn < image.to.col) this.addColumn();
        while (this.lastRow < image.to.row) this.addRow();
        continue;
      }
      const width = image.size?.width ?? 0;
      const height = image.size?.height ?? 0;
      while (this.lastColumn < image.from.col) this.addColumn();
      while (this.lastRow < image.from.row) this.addRow();
      while ((this.columnX[this.lastColumn + 1] as number) - (this.columnX[image.from.col] as number) < image.from.dx + width && this.lastColumn < 400) this.addColumn();
      while ((this.rowY[this.lastRow + 1] as number) - (this.rowY[image.from.row] as number) < image.from.dy + height && this.lastRow < 5000) this.addRow();
    }
    // Text that runs off the right edge of the last column.
    for (const [r, row] of this.sheet.cells) {
      if (r > this.lastRow) continue;
      let rightmost = -1;
      for (const [c, cell] of row) if (cell.type !== "blank" && c > rightmost) rightmost = c;
      const cell = rightmost >= 0 ? row.get(rightmost) : undefined;
      if (!cell || cell.type !== "string" || this.covered.has(`${r}:${rightmost}`)) continue;
      const layout = this.layoutCell(r, rightmost);
      if (!layout || !layout.overflows || layout.align !== "left") continue;
      let available = 0;
      for (let c = rightmost; c <= this.lastColumn; c += 1) available += this.colWidth(c);
      while (layout.textWidth + PAD_X * 2 > available && this.lastColumn < 400) {
        this.addColumn();
        available += this.colWidth(this.lastColumn);
      }
    }
  }

  colWidth(c: number): number {
    return this.colWidths[c] ?? this.sheet.defaultColumnWidth;
  }

  rowHeight(r: number): number {
    return this.rowHeights[r] ?? this.sheet.defaultRowHeight;
  }

  /** The size of the whole printed area in points. */
  get width(): number {
    return (this.columnX[this.lastColumn + 1] as number) - (this.columnX[this.firstColumn] as number);
  }

  get height(): number {
    return (this.rowY[this.lastRow + 1] as number) - (this.rowY[this.firstRow] as number);
  }

  mergeAt(r: number, c: number): MergeRange | undefined {
    return this.merged.get(`${r}:${c}`);
  }

  isCovered(r: number, c: number): boolean {
    return this.covered.has(`${r}:${c}`);
  }

  cellAt(r: number, c: number): Cell | undefined {
    return this.sheet.cells.get(r)?.get(c);
  }

  formatOf(cell: Cell): CellFormat {
    return this.book.formats[cell.format] ?? (this.book.formats[0] as CellFormat);
  }

  /** The width of a cell, which for the first cell of a merged range is the whole range. */
  cellWidth(r: number, c: number): number {
    const merge = this.mergeAt(r, c);
    if (!merge) return this.colWidth(c);
    let total = 0;
    for (let i = merge.col; i < merge.col + merge.cols; i += 1) total += this.colWidth(i);
    return total;
  }

  cellHeight(r: number, c: number): number {
    const merge = this.mergeAt(r, c);
    if (!merge) return this.rowHeight(r);
    let total = 0;
    for (let i = merge.row; i < merge.row + merge.rows; i += 1) total += this.rowHeight(i);
    return total;
  }

  private measureRow(r: number): number {
    const { sheet } = this;
    if (sheet.hiddenRows.has(r)) return 0;
    const explicit = sheet.rowHeights.get(r);
    if (explicit !== undefined) return explicit;
    let height = sheet.defaultRowHeight;
    const row = sheet.cells.get(r);
    if (!row) return height;
    for (const [c, cell] of row) {
      if (c > this.lastColumn || this.covered.has(`${r}:${c}`) || this.merged.has(`${r}:${c}`)) continue;
      const format = this.formatOf(cell);
      const metrics = this.shaper.metrics(styleOf(format.font));
      height = Math.max(height, metrics.ascent + metrics.descent + 1.5);
      if (format.wrap && cell.type === "string") {
        const layout = this.layoutCell(r, c);
        if (layout) height = Math.max(height, layout.textHeight + PAD_Y * 2 + 0.5);
      }
    }
    return height;
  }

  /** How a cell's text is set: lines, alignment and whether it fits. Null for cells with nothing to draw. */
  layoutCell(r: number, c: number): CellLayout | null {
    const key = `${r}:${c}`;
    if (this.layouts.has(key)) return this.layouts.get(key) ?? null;
    const cell = this.cellAt(r, c);
    let layout: CellLayout | null = null;
    if (cell && cell.type !== "blank") layout = this.buildLayout(r, c, cell);
    this.layouts.set(key, layout);
    return layout;
  }

  private buildLayout(r: number, c: number, cell: Cell): CellLayout | null {
    const format = this.formatOf(cell);
    const base = styleOf(format.font);
    const width = c < this.colWidths.length ? this.cellWidth(r, c) : this.sheet.defaultColumnWidth;
    const indent = format.indent > 0 ? format.indent * 3 * this.shaper.width(" ", base) : 0;
    const inner = Math.max(width - PAD_X * 2 - indent, 2);
    const numeric = cell.type === "number";
    const wrap = format.wrap && cell.type === "string";

    const items: InlineItem[] = [];
    const text = formatValue(cell, format, this.book.date1904);
    if (text === "") return null;
    if (cell.rich && cell.type === "string") {
      for (const run of cell.rich) {
        const style = styleOf({ ...format.font, ...run.font });
        this.pushText(items, run.text, style, wrap);
      }
    } else {
      this.pushText(items, text, base, wrap);
    }
    let style = base;
    let scale = 1;
    let shapeWidth = wrap ? inner : 1e6;
    if (format.shrink && !wrap) {
      const natural = this.shaper.width(text, base);
      if (natural > inner) {
        scale = Math.max(inner / natural, 0.3);
        style = { ...base, size: base.size * scale };
        items.length = 0;
        this.pushText(items, text, style, false);
        shapeWidth = 1e6;
      }
    }

    const defaultAlign = cell.type === "number" ? "right" : cell.type === "boolean" || cell.type === "error" ? "center" : "left";
    const horizontal = format.halign === "general" ? defaultAlign : format.halign;
    const align = horizontal === "right" ? "right" : horizontal === "center" || horizontal === "centerContinuous" || horizontal === "distributed" ? "center" : horizontal === "justify" && wrap ? "justify" : "left";
    const shape: ParagraphShape = { width: shapeWidth, firstLineOffset: 0, leftIndent: 0, align: wrap ? align : "left", tabs: [], defaultTabStop: 36, lineRule: "auto", lineValue: 1, markStyle: style };
    const lines = breakLines(buildAtoms(items, this.shaper), shape, this.shaper);
    const textWidth = lines.reduce((widest, line) => Math.max(widest, line.width), 0);
    const textHeight = lines.reduce((sum, line) => sum + line.height, 0);
    // A number that does not fit its column is shown as ####, as Excel does.
    const tooWide = numeric && textWidth > inner + 0.5 && !format.shrink;
    return { lines, textWidth, textHeight, numeric, align, overflows: !wrap && textWidth > inner + 0.5, scale, tooWide };
  }

  private pushText(items: InlineItem[], text: string, style: TextStyle, wrap: boolean): void {
    if (!wrap) {
      items.push({ kind: "text", text: text.replace(/\r?\n/g, " "), style });
      return;
    }
    text.split(/\r?\n/).forEach((part, index) => {
      if (index > 0) items.push({ kind: "break", type: "line", style });
      items.push({ kind: "text", text: part, style });
    });
  }

  /** Whether a cell has nothing in it, so that text can spill over it. */
  isEmpty(r: number, c: number): boolean {
    if (this.covered.has(`${r}:${c}`) || this.merged.has(`${r}:${c}`)) return false;
    const cell = this.cellAt(r, c);
    return !cell || cell.type === "blank";
  }
}

// ---- pages -----------------------------------------------------------------------------------------------

export interface PagePlan {
  plan: SheetPlan;
  rows: [number, number];
  columns: [number, number];
  /** Rows repeated at the top (print titles), when this is not the first page of its columns. */
  titleRows?: [number, number];
  scale: number;
  width: number;
  height: number;
  margins: { left: number; right: number; top: number; bottom: number; header: number; footer: number };
  centerX: boolean;
  centerY: boolean;
  gridlines: boolean;
  /** One-based position of this sheet's pages, for headers that count per sheet. */
  sheetPageNumber: number;
}

function pageDimensions(sheet: Sheet, options: XlsxOptions, contentWidth: number): { width: number; height: number } {
  const [w, h] = PAPER[sheet.setup.paperSize ?? 9] ?? PAPER[9] ?? [595, 842];
  const portrait = { width: Math.min(w, h), height: Math.max(w, h) };
  const landscape = { width: portrait.height, height: portrait.width };
  if (options.orientation === "portrait") return portrait;
  if (options.orientation === "landscape") return landscape;
  // A sheet that asks to be fitted to pages keeps the orientation it chose. Otherwise a sheet that is wider than a
  // portrait page is printed sideways, because that splits it into fewer pages.
  if (sheet.setup.fitToPage && sheet.setup.landscape !== undefined) return sheet.setup.landscape ? landscape : portrait;
  const printable = portrait.width - (sheet.setup.margins.left + sheet.setup.margins.right) * 72;
  if (contentWidth > printable * 1.05) return landscape;
  return sheet.setup.landscape ? landscape : portrait;
}

function chunk(from: number, to: number, size: (index: number) => number, limit: number, breaks: number[]): [number, number][] {
  const out: [number, number][] = [];
  let start = from;
  let used = 0;
  for (let index = from; index <= to; index += 1) {
    const length = size(index);
    const forced = breaks.includes(index) && index > start;
    if ((forced || (used + length > limit + 0.01 && index > start)) && index > start) {
      out.push([start, index - 1]);
      start = index;
      used = 0;
    }
    used += length;
  }
  if (start <= to) out.push([start, to]);
  return out;
}

export function planPages(plan: SheetPlan, options: XlsxOptions): PagePlan[] {
  const { sheet } = plan;
  if (plan.lastRow < plan.firstRow || plan.lastColumn < plan.firstColumn) return [];
  const setup = sheet.setup;
  const page = pageDimensions(sheet, options, plan.width);
  const margins = { left: setup.margins.left * 72, right: setup.margins.right * 72, top: setup.margins.top * 72, bottom: setup.margins.bottom * 72, header: setup.margins.header * 72, footer: setup.margins.footer * 72 };
  const printableWidth = Math.max(page.width - margins.left - margins.right, 72);
  const printableHeight = Math.max(page.height - margins.top - margins.bottom, 72);

  let scale = (setup.scale ?? 100) / 100;
  if (setup.fitToPage) {
    const byWidth = setup.fitToWidth > 0 ? (printableWidth * setup.fitToWidth) / plan.width : Number.POSITIVE_INFINITY;
    const byHeight = setup.fitToHeight > 0 ? (printableHeight * setup.fitToHeight) / plan.height : Number.POSITIVE_INFINITY;
    scale = Math.max(0.1, Math.min(1, byWidth, byHeight));
  }
  if (options.fitWidth && plan.width * scale > printableWidth + 0.5) scale = Math.min(scale, Math.max(MIN_AUTO_SCALE, printableWidth / plan.width));

  const virtualWidth = printableWidth / scale;
  const virtualHeight = printableHeight / scale;
  const titles = sheet.printTitleRows;
  const titleHeight = titles ? (plan.rowY[titles.last + 1] as number) - (plan.rowY[titles.first] as number) : 0;
  const gridlines = options.gridlines === "on" ? true : options.gridlines === "off" ? false : setup.gridLines;

  const columnBlocks = chunk(plan.firstColumn, plan.lastColumn, (c) => plan.colWidth(c), virtualWidth, sheet.columnBreaks);
  const out: PagePlan[] = [];
  const rowPagesFor = (): [number, number][] => {
    const pages: [number, number][] = [];
    let start = plan.firstRow;
    let first = true;
    while (start <= plan.lastRow) {
      const limit = virtualHeight - (first || !titles ? 0 : titleHeight);
      const slice = chunk(start, plan.lastRow, (r) => plan.rowHeight(r), limit, sheet.rowBreaks);
      const head = slice[0] as [number, number];
      pages.push(head);
      start = head[1] + 1;
      first = false;
    }
    return pages;
  };
  const rowPages = rowPagesFor();
  const make = (rows: [number, number], columns: [number, number], index: number): PagePlan => ({
    plan,
    rows,
    columns,
    titleRows: titles && rows[0] > titles.last ? [titles.first, titles.last] : undefined,
    scale,
    width: page.width,
    height: page.height,
    margins,
    centerX: setup.horizontalCentered,
    centerY: setup.verticalCentered,
    gridlines,
    sheetPageNumber: index,
  });
  let index = 0;
  if (setup.overThenDown) {
    for (const rows of rowPages) for (const columns of columnBlocks) out.push(make(rows, columns, (index += 1)));
  } else {
    for (const columns of columnBlocks) for (const rows of rowPages) out.push(make(rows, columns, (index += 1)));
  }
  return out;
}

// ---- drawing ---------------------------------------------------------------------------------------------

const BORDER_WIDTH: Record<BorderSide["style"], number> = { hair: 0.25, thin: 0.5, dotted: 0.5, dashed: 0.5, medium: 1, thick: 1.75, double: 1.5 };

function strokeSide(page: PageBuilder, side: BorderSide, x1: number, y1: number, x2: number, y2: number): void {
  const width = BORDER_WIDTH[side.style];
  if (side.style === "double") {
    const horizontal = Math.abs(y2 - y1) < 0.001;
    const offset = 0.6;
    if (horizontal) {
      page.line(x1, y1 - offset, x2, y2 - offset, { color: side.color, width: 0.5 });
      page.line(x1, y1 + offset, x2, y2 + offset, { color: side.color, width: 0.5 });
    } else {
      page.line(x1 - offset, y1, x2 - offset, y2, { color: side.color, width: 0.5 });
      page.line(x1 + offset, y1, x2 + offset, y2, { color: side.color, width: 0.5 });
    }
    return;
  }
  page.line(x1, y1, x2, y2, { color: side.color, width, dash: side.style === "dotted" ? [width, width * 1.5] : side.style === "dashed" ? [width * 4, width * 2] : undefined });
}

export interface SheetRenderInput {
  page: PageBuilder;
  pagePlan: PagePlan;
  shaper: TextShaper;
  images: Map<string, EmbeddedImage>;
  pageNumber: number;
  pageCount: number;
}

/** Draws the cells, borders, pictures and links of one page, inside a scaled view. */
export function drawSheetPage(input: SheetRenderInput): void {
  const { page, pagePlan, shaper } = input;
  const { plan, scale } = pagePlan;
  const { sheet } = plan;
  const printableWidth = pagePlan.width - pagePlan.margins.left - pagePlan.margins.right;
  const printableHeight = pagePlan.height - pagePlan.margins.top - pagePlan.margins.bottom;
  const [r0, r1] = pagePlan.rows;
  const [c0, c1] = pagePlan.columns;
  const blockWidth = (plan.columnX[c1 + 1] as number) - (plan.columnX[c0] as number);
  const titleHeight = pagePlan.titleRows ? (plan.rowY[pagePlan.titleRows[1] + 1] as number) - (plan.rowY[pagePlan.titleRows[0]] as number) : 0;
  const blockHeight = (plan.rowY[r1 + 1] as number) - (plan.rowY[r0] as number) + titleHeight;
  const offsetX = pagePlan.margins.left + (pagePlan.centerX ? Math.max((printableWidth - blockWidth * scale) / 2, 0) : 0);
  const offsetY = pagePlan.margins.top + (pagePlan.centerY ? Math.max((printableHeight - blockHeight * scale) / 2, 0) : 0);
  page.beginView(scale, offsetX, offsetY, printableHeight / scale);

  const ctx: DrawContext = { page, shaper, pageNumber: input.pageNumber, pageCount: input.pageCount };
  const xOf = (c: number) => (plan.columnX[c] as number) - (plan.columnX[c0] as number);
  // Where a row sits on this page: title rows first, then the page's own rows.
  const rowOrigin = new Map<number, number>();
  let cursor = 0;
  const rows: number[] = [];
  if (pagePlan.titleRows) for (let r = pagePlan.titleRows[0]; r <= pagePlan.titleRows[1]; r += 1) rows.push(r);
  for (let r = r0; r <= r1; r += 1) rows.push(r);
  for (const r of rows) {
    rowOrigin.set(r, cursor);
    cursor += plan.rowHeight(r);
  }

  if (pagePlan.gridlines) {
    const grid = { color: "#bfbfbf", width: 0.5 };
    for (const r of rows) {
      const y = rowOrigin.get(r) as number;
      page.line(0, y, blockWidth, y, grid);
      page.line(0, y + plan.rowHeight(r), blockWidth, y + plan.rowHeight(r), grid);
    }
    for (let c = c0; c <= c1 + 1; c += 1) page.line(xOf(c), 0, xOf(c), cursor, grid);
  }

  // Fills first, then text, then borders on top.
  for (const r of rows) {
    const rowCells = sheet.cells.get(r);
    if (!rowCells) continue;
    for (const [c, cell] of rowCells) {
      if (c < c0 || c > c1 || plan.isCovered(r, c)) continue;
      const format = plan.formatOf(cell);
      if (!format.fill) continue;
      page.fillRect(xOf(c), rowOrigin.get(r) as number, plan.cellWidth(r, c), plan.cellHeight(r, c), format.fill);
    }
  }

  for (const r of rows) {
    const rowCells = sheet.cells.get(r);
    if (!rowCells) continue;
    for (const [c, cell] of rowCells) {
      if (c < c0 || c > c1 || plan.isCovered(r, c)) continue;
      const layout = plan.layoutCell(r, c);
      if (!layout) continue;
      const format = plan.formatOf(cell);
      const x = xOf(c);
      const y = rowOrigin.get(r) as number;
      const width = plan.cellWidth(r, c);
      const height = plan.cellHeight(r, c);
      if (layout.tooWide) {
        const style = styleOf(format.font);
        const hash = "#";
        const count = Math.max(1, Math.floor((width - PAD_X * 2) / Math.max(shaper.width(hash, style), 0.1)));
        const font = shaper.shape(hash, style)[0];
        if (font) page.text(font.font, font.size, x + PAD_X, y + height - PAD_Y - shaper.metrics(style).descent, hash.repeat(count), style.color);
        continue;
      }
      // Text may spill over empty neighbours when it is not wrapped.
      let left = x;
      let right = x + width;
      if (layout.overflows && cell.type === "string") {
        const spill = layout.textWidth + PAD_X * 2 - width;
        const alignRight = layout.align === "right";
        const alignCenter = layout.align === "center";
        let needRight = alignRight ? 0 : alignCenter ? spill / 2 : spill;
        let needLeft = alignRight ? spill : alignCenter ? spill / 2 : 0;
        for (let cc = c + 1; needRight > 0 && cc <= c1 && plan.isEmpty(r, cc); cc += 1) {
          right += plan.colWidth(cc);
          needRight -= plan.colWidth(cc);
        }
        for (let cc = c - 1; needLeft > 0 && cc >= c0 && plan.isEmpty(r, cc); cc -= 1) {
          left -= plan.colWidth(cc);
          needLeft -= plan.colWidth(cc);
        }
      }
      const indent = format.indent > 0 ? format.indent * 3 * shaper.width(" ", styleOf(format.font)) : 0;
      let textLeft = x + PAD_X + (layout.align === "left" ? indent : 0);
      if (layout.align === "right") textLeft = x + width - PAD_X - layout.textWidth;
      else if (layout.align === "center") textLeft = x + (width - layout.textWidth) / 2;
      const free = height - layout.textHeight - PAD_Y * 2;
      const textTop = y + PAD_Y + (format.valign === "bottom" || format.valign === "justify" ? Math.max(free, 0) : format.valign === "center" || format.valign === "distributed" ? Math.max(free, 0) / 2 : 0);
      page.save();
      page.clipRect(left, y, right - left, height);
      let lineTop = textTop;
      for (const line of layout.lines) {
        // Multi-line text keeps its own alignment inside the block.
        const lineLeft = layout.lines.length > 1 && layout.align === "center" ? textLeft + (layout.textWidth - line.width) / 2 : layout.lines.length > 1 && layout.align === "right" ? textLeft + (layout.textWidth - line.width) : textLeft;
        drawLine(ctx, line, lineLeft, lineTop);
        lineTop += line.height;
      }
      page.restore();
    }
  }

  for (const r of rows) {
    const rowCells = sheet.cells.get(r);
    if (!rowCells) continue;
    for (const [c, cell] of rowCells) {
      if (c < c0 || c > c1 || plan.isCovered(r, c)) continue;
      const border = plan.formatOf(cell).border;
      if (!border.left && !border.right && !border.top && !border.bottom) continue;
      const x = xOf(c);
      const y = rowOrigin.get(r) as number;
      const width = plan.cellWidth(r, c);
      const height = plan.cellHeight(r, c);
      if (border.top) strokeSide(page, border.top, x, y, x + width, y);
      if (border.bottom) strokeSide(page, border.bottom, x, y + height, x + width, y + height);
      if (border.left) strokeSide(page, border.left, x, y, x, y + height);
      if (border.right) strokeSide(page, border.right, x + width, y, x + width, y + height);
    }
  }

  // Pictures over the cells, and links.
  const bodyTop = plan.rowY[r0] as number;
  for (const image of sheet.images) {
    const embedded = input.images.get(image.part);
    if (!embedded) continue;
    const left = columnPosition(plan, image.from.col) + image.from.dx;
    const top = rowPosition(plan, image.from.row) + image.from.dy;
    const right = image.to ? columnPosition(plan, image.to.col) + image.to.dx : left + (image.size?.width ?? 0);
    const bottom = image.to ? rowPosition(plan, image.to.row) + image.to.dy : top + (image.size?.height ?? 0);
    if (right <= left || bottom <= top) continue;
    const pageLeft = left - (plan.columnX[c0] as number);
    const pageTop = top - bodyTop + titleHeight;
    if (pageLeft + (right - left) < 0 || pageLeft > blockWidth || pageTop + (bottom - top) < titleHeight || pageTop > blockHeight) continue;
    page.save();
    page.clipRect(0, titleHeight, blockWidth, blockHeight - titleHeight);
    drawPicture(page, embedded, pageLeft, pageTop, right - left, bottom - top);
    page.restore();
  }
  for (const link of sheet.hyperlinks) {
    if (link.col > c1 || link.col + link.cols - 1 < c0 || link.row > r1 || link.row + link.rows - 1 < r0) continue;
    const y = rowOrigin.get(link.row);
    if (y === undefined) continue;
    let width = 0;
    for (let c = link.col; c < link.col + link.cols; c += 1) width += plan.colWidth(c);
    let height = 0;
    for (let r = link.row; r < link.row + link.rows; r += 1) height += plan.rowHeight(r);
    page.link(xOf(link.col), y, width, height, { uri: link.uri });
  }
  page.endView();
}

function columnPosition(plan: SheetPlan, col: number): number {
  if (col < plan.columnX.length) return plan.columnX[col] as number;
  return (plan.columnX[plan.columnX.length - 1] as number) + (col - plan.columnX.length + 1) * plan.sheet.defaultColumnWidth;
}

function rowPosition(plan: SheetPlan, row: number): number {
  if (row < plan.rowY.length) return plan.rowY[row] as number;
  return (plan.rowY[plan.rowY.length - 1] as number) + (row - plan.rowY.length + 1) * plan.sheet.defaultRowHeight;
}

// ---- headers and footers ---------------------------------------------------------------------------------

/** Splits Excel's "&L...&C...&R..." header text into its three parts and fills in the codes. */
export function parseHeaderFooter(source: string, values: { page: number; pages: number; sheet: string; file: string }): { left: string; center: string; right: string } {
  const parts = { L: "", C: "", R: "" };
  let section: "L" | "C" | "R" = "C";
  const now = new Date();
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char !== "&") {
      parts[section] += char;
      continue;
    }
    const next = source[i + 1];
    i += 1;
    if (next === undefined) break;
    if (next === "L" || next === "C" || next === "R") section = next;
    else if (next === "P") parts[section] += String(values.page);
    else if (next === "N") parts[section] += String(values.pages);
    else if (next === "A") parts[section] += values.sheet;
    else if (next === "F") parts[section] += values.file;
    else if (next === "D") parts[section] += now.toLocaleDateString();
    else if (next === "T") parts[section] += now.toLocaleTimeString();
    else if (next === "&") parts[section] += "&";
    else if (next === '"') {
      const close = source.indexOf('"', i + 1);
      i = close === -1 ? source.length : close;
    } else if (/\d/.test(next)) {
      while (i + 1 < source.length && /\d/.test(source[i + 1] as string)) i += 1;
    }
  }
  return { left: parts.L, center: parts.C, right: parts.R };
}
