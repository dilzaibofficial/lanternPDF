/**
 * Word layout: from the document model to pages.
 *
 * Stage A lays every block out at the width it will have (paragraphs become lines, table cells become laid-out content
 * with a height). Stage B places those blocks on pages, deciding where pages break, and produces a display list per page
 * with absolute coordinates. Drawing (docx/render.ts) then only has to follow the list.
 */
import { familyFor, symbolKindOf } from "../fontLibrary";
import type { EmbeddedImage } from "../pdfBuilder";
import { type InlineItem, type Line, type LinkRef, type ParagraphShape, type TabStop, type TextShaper, type TextStyle, breakLines, buildAtoms, linesHeight } from "../textflow";
import type { Warnings } from "../warnings";
import type { AnchorInfo, Block, Border, Borders, CellProps, DocxModel, ParagraphBlock, RowModel, RunProps, SectionProps, TableBlock } from "./types";

// ---- styles ----------------------------------------------------------------------------------------------

const styleCache = new WeakMap<RunProps, TextStyle>();

export function toTextStyle(run: RunProps): TextStyle {
  const cached = styleCache.get(run);
  if (cached) return cached;
  const style: TextStyle = {
    family: familyFor(run.fontName, run.fontClass ?? "auto"),
    bold: run.bold ?? false,
    italic: run.italic ?? false,
    size: run.size ?? 10,
    color: run.color ?? "#000000",
    underline: run.underline && run.underline !== "none" ? run.underline : undefined,
    underlineColor: run.underlineColor,
    strike: run.strike,
    doubleStrike: run.dstrike,
    background: run.highlight ?? run.shade,
    caps: run.caps,
    smallCaps: run.smallCaps,
    script: run.vertAlign === "superscript" ? "super" : run.vertAlign === "subscript" ? "sub" : undefined,
    spacing: run.spacing,
    rise: run.position,
    symbol: run.symbolFont,
    symbolKind: symbolKindOf(run.fontName),
  };
  styleCache.set(run, style);
  return style;
}

// ---- results ---------------------------------------------------------------------------------------------

export type DisplayItem =
  | { kind: "lines"; x: number; y: number; lines: Line[] }
  | { kind: "rect"; x: number; y: number; width: number; height: number; fill: string }
  | { kind: "edge"; x1: number; y1: number; x2: number; y2: number; border: Border }
  | { kind: "image"; x: number; y: number; width: number; height: number; image: EmbeddedImage; crop?: { left: number; top: number; right: number; bottom: number } };

export interface DisplayPage {
  sectionIndex: number;
  /** The number printed for this page (after any restart). */
  number: number;
  width: number;
  height: number;
  behind: DisplayItem[];
  items: DisplayItem[];
  front: DisplayItem[];
  /** Which header and footer to use. */
  kind: "first" | "even" | "default";
}

export interface LaidParagraph {
  kind: "p";
  lines: Line[];
  left: number;
  width: number;
  before: number;
  after: number;
  keepNext: boolean;
  keepLines: boolean;
  pageBreakBefore: boolean;
  widowControl: boolean;
  shading?: string;
  borders?: Borders;
  bookmarks: string[];
  overlays: { anchor: AnchorInfo; image: EmbeddedImage; width: number; height: number }[];
  styleId?: string;
  contextual: boolean;
  height: number;
}

interface LaidCell {
  x: number;
  width: number;
  height: number;
  innerLeft: number;
  innerTop: number;
  innerWidth: number;
  blocks: LaidBlock[];
  props: CellProps;
  colStart: number;
  colSpan: number;
  rowSpan: number;
  vMergeContinue: boolean;
  vMergeStart: boolean;
  margins: { top: number; left: number; bottom: number; right: number };
  contentHeight: number;
}

interface LaidRow {
  cells: LaidCell[];
  height: number;
  header: boolean;
  cantSplit: boolean;
  exact: boolean;
}

export interface LaidTable {
  kind: "t";
  rows: LaidRow[];
  left: number;
  width: number;
  columnX: number[];
  borders: Borders;
}

export type LaidBlock = LaidParagraph | LaidTable;

export interface LayoutContext {
  shaper: TextShaper;
  images: Map<string, EmbeddedImage>;
  warnings: Warnings;
  defaultTabStop: number;
  contentHeightLimit: number;
}

// ---- Stage A: blocks -------------------------------------------------------------------------------------

function withLink(style: TextStyle, link: LinkRef | undefined): TextStyle {
  return link ? { ...style, link } : style;
}

const CELL_DEFAULT_MARGIN = { top: 0, left: 5.4, bottom: 0, right: 5.4 };

/** Fits a picture inside the width a paragraph has, and inside a page. */
function fitImage(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  let scale = 1;
  if (width > maxWidth) scale = Math.min(scale, maxWidth / width);
  if (height * scale > maxHeight) scale = Math.min(scale, maxHeight / height);
  return { width: Math.max(1, width * scale), height: Math.max(1, height * scale) };
}

export function layoutParagraph(p: ParagraphBlock, contentWidth: number, ctx: LayoutContext): LaidParagraph {
  const props = p.props;
  const indent = props.indent ?? {};
  const left = indent.left ?? 0;
  const right = indent.right ?? 0;
  const width = Math.max(contentWidth - left - right, 24);
  const firstLineOffset = (indent.firstLine ?? 0) - (indent.hanging ?? 0);

  const items: InlineItem[] = [];
  const overlays: LaidParagraph["overlays"] = [];
  const bookmarks: string[] = [];
  for (const item of p.items) {
    if (item.kind === "text") {
      items.push({ kind: "text", text: item.text, style: withLink(toTextStyle(item.run), item.link) });
    } else if (item.kind === "tab") {
      items.push({ kind: "tab", style: toTextStyle(item.run) });
    } else if (item.kind === "break") {
      items.push({ kind: "break", type: item.type, style: toTextStyle(item.run) });
    } else if (item.kind === "field") {
      items.push({ kind: "field", field: item.field, style: toTextStyle(item.run) });
    } else if (item.kind === "note") {
      items.push({ kind: "text", text: item.label, style: toTextStyle(item.run) });
    } else if (item.kind === "bookmark") {
      bookmarks.push(item.name);
    } else {
      const image = ctx.images.get(item.part);
      if (!image) continue;
      const anchor = item.anchor;
      const free = anchor && (anchor.behind || anchor.wrap === "none");
      if (free) {
        overlays.push({ anchor, image, width: item.width, height: item.height });
        continue;
      }
      if (anchor) ctx.warnings.add("floating");
      const size = fitImage(item.width, item.height, width, ctx.contentHeightLimit);
      items.push({ kind: "image", image, width: size.width, height: size.height, rise: item.rise, link: item.link, style: toTextStyle(item.run), crop: item.crop });
    }
  }

  const cleared = new Set(props.clearedTabs ?? []);
  const tabs: TabStop[] = (props.tabs ?? []).filter((stop) => !cleared.has(stop.position));
  const spacing = props.spacing ?? {};
  const shape: ParagraphShape = {
    width,
    firstLineOffset,
    leftIndent: left,
    align: props.align ?? "left",
    tabs,
    defaultTabStop: ctx.defaultTabStop,
    lineRule: spacing.lineRule ?? "auto",
    lineValue: spacing.line ?? 1,
    markStyle: toTextStyle(p.markRun),
  };
  const atoms = buildAtoms(items, ctx.shaper);
  const lines = breakLines(atoms, shape, ctx.shaper);

  const borders = props.borders;
  const topSpace = borders?.top && borders.top.style !== "none" ? borders.top.width + borders.top.space : 0;
  const bottomSpace = borders?.bottom && borders.bottom.style !== "none" ? borders.bottom.width + borders.bottom.space : 0;
  return {
    kind: "p",
    lines,
    left,
    width,
    before: (spacing.beforeAuto ? 14 : (spacing.before ?? 0)) + topSpace,
    after: (spacing.afterAuto ? 14 : (spacing.after ?? 0)) + bottomSpace,
    keepNext: props.keepNext ?? false,
    keepLines: props.keepLines ?? false,
    pageBreakBefore: props.pageBreakBefore ?? false,
    widowControl: props.widowControl ?? true,
    shading: props.shading,
    borders,
    bookmarks,
    overlays,
    styleId: p.styleId,
    contextual: props.contextualSpacing ?? false,
    height: linesHeight(lines),
  };
}

/** Column widths: the grid, scaled to the table's stated width, and never wider than the text area. */
function columnWidths(table: TableBlock, contentWidth: number): number[] {
  let widths = table.grid.map((value) => Math.max(value, 0));
  if (widths.length === 0) return widths;
  const sum = widths.reduce((a, b) => a + b, 0) || 1;
  const target = table.props.width;
  let wanted = sum;
  if (target?.type === "pct") wanted = (contentWidth * target.value) / 100;
  else if (target?.type === "pt" && target.value > 0 && !table.props.fixed) wanted = target.value;
  const indent = table.props.indent ?? 0;
  const room = Math.max(contentWidth - Math.max(indent, 0), 24);
  if (wanted > room + 0.5) wanted = room;
  if (Math.abs(wanted - sum) > 0.5) widths = widths.map((value) => (value * wanted) / sum);
  return widths;
}

function resolveBorder(...candidates: (Border | undefined)[]): Border | undefined {
  for (const candidate of candidates) if (candidate) return candidate.style === "none" ? undefined : candidate;
  return undefined;
}

export function layoutTable(table: TableBlock, contentWidth: number, ctx: LayoutContext): LaidTable {
  const widths = columnWidths(table, contentWidth);
  const columnX: number[] = [0];
  for (const width of widths) columnX.push((columnX[columnX.length - 1] as number) + width);
  const tableWidth = columnX[columnX.length - 1] as number;
  const align = table.props.align ?? "left";
  const left = align === "center" ? (contentWidth - tableWidth) / 2 : align === "right" ? contentWidth - tableWidth : (table.props.indent ?? 0);
  const margins = { ...CELL_DEFAULT_MARGIN, ...(table.props.cellMargins ?? {}) };
  const tableBorders = table.props.borders ?? {};
  const rowCount = table.rows.length;

  const rows: LaidRow[] = [];
  table.rows.forEach((row, rowIndex) => {
    const cells: LaidCell[] = [];
    let column = 0;
    for (const cell of row.cells) {
      const span = Math.min(cell.gridSpan, Math.max(widths.length - column, 1));
      const cellWidth = (columnX[Math.min(column + span, widths.length)] as number) - (columnX[column] as number);
      const cellMargins = { ...margins, ...(cell.props.margins ?? {}) };
      const innerWidth = Math.max(cellWidth - cellMargins.left - cellMargins.right, 12);
      const blocks = cell.vMerge === "continue" ? [] : layoutBlocks(cell.blocks, innerWidth, ctx);
      const contentHeight = blocks.reduce((sum, block) => sum + blockHeight(block), 0);
      cells.push({
        x: columnX[column] as number,
        width: cellWidth,
        height: 0,
        innerLeft: cellMargins.left,
        innerTop: cellMargins.top,
        innerWidth,
        blocks,
        props: cell.props,
        colStart: column,
        colSpan: span,
        rowSpan: 1,
        vMergeContinue: cell.vMerge === "continue",
        vMergeStart: cell.vMerge === "restart",
        margins: cellMargins,
        contentHeight,
      });
      column += span;
    }
    rows.push({ cells, height: 0, header: row.header, cantSplit: row.cantSplit, exact: row.height?.rule === "exact" });
    void rowIndex;
  });

  // Vertical merges: the cell that starts a merge also covers the rows below it that continue it.
  for (let r = 0; r < rows.length; r += 1) {
    for (const cell of (rows[r] as LaidRow).cells) {
      if (!cell.vMergeStart) continue;
      let span = 1;
      for (let next = r + 1; next < rows.length; next += 1) {
        const below = (rows[next] as LaidRow).cells.find((c) => c.colStart === cell.colStart);
        if (below?.vMergeContinue) span += 1;
        else break;
      }
      cell.rowSpan = span;
    }
  }

  // Row heights: the tallest cell that sits in the row alone, at least the stated height.
  rows.forEach((row, rowIndex) => {
    const source = table.rows[rowIndex] as RowModel;
    let height = 0;
    for (const cell of row.cells) {
      if (cell.rowSpan === 1 && !cell.vMergeContinue) height = Math.max(height, cell.contentHeight + cell.margins.top + cell.margins.bottom);
    }
    if (source.height) height = source.height.rule === "exact" ? source.height.value : Math.max(height, source.height.value);
    row.height = Math.max(height, row.cells.length === 0 ? 0 : 1);
  });
  // A merged cell taller than the rows it covers makes its last row taller.
  rows.forEach((row, rowIndex) => {
    for (const cell of row.cells) {
      if (cell.rowSpan <= 1) continue;
      const covered = rows.slice(rowIndex, rowIndex + cell.rowSpan).reduce((sum, r) => sum + r.height, 0);
      const needed = cell.contentHeight + cell.margins.top + cell.margins.bottom;
      if (needed > covered) (rows[rowIndex + cell.rowSpan - 1] as LaidRow).height += needed - covered;
    }
  });
  for (const row of rows) for (const cell of row.cells) cell.height = row.height;
  for (let r = 0; r < rows.length; r += 1) {
    for (const cell of (rows[r] as LaidRow).cells) {
      if (cell.rowSpan > 1) cell.height = rows.slice(r, r + cell.rowSpan).reduce((sum, row) => sum + row.height, 0);
    }
  }

  // Which borders each cell draws: its own, else the table's outer or inner border for that side.
  rows.forEach((row, rowIndex) => {
    for (const cell of row.cells) {
      const own = cell.props.borders ?? {};
      const lastRow = rowIndex + cell.rowSpan >= rowCount;
      const lastColumn = cell.colStart + cell.colSpan >= widths.length;
      cell.props = {
        ...cell.props,
        borders: {
          top: resolveBorder(own.top, rowIndex === 0 ? tableBorders.top : tableBorders.insideH),
          bottom: resolveBorder(own.bottom, lastRow ? tableBorders.bottom : tableBorders.insideH),
          left: resolveBorder(own.left, cell.colStart === 0 ? tableBorders.left : tableBorders.insideV),
          right: resolveBorder(own.right, lastColumn ? tableBorders.right : tableBorders.insideV),
        },
      };
    }
  });

  return { kind: "t", rows, left, width: tableWidth, columnX, borders: tableBorders };
}

export function blockHeight(block: LaidBlock): number {
  if (block.kind === "p") return block.before + block.height + block.after;
  return block.rows.reduce((sum, row) => sum + row.height, 0);
}

export function layoutBlocks(blocks: readonly Block[], width: number, ctx: LayoutContext): LaidBlock[] {
  return blocks.map((block) => (block.type === "p" ? layoutParagraph(block, width, ctx) : layoutTable(block, width, ctx)));
}

// ---- Stage B: pages --------------------------------------------------------------------------------------

export interface HeaderFooterLayout {
  /** Height the part takes, to keep the body clear of it. */
  height: number;
}

/** What the paginator needs from the document: how tall headers and footers are. */
export interface PageFurniture {
  headerHeight(section: SectionProps, kind: DisplayPage["kind"]): number;
  footerHeight(section: SectionProps, kind: DisplayPage["kind"]): number;
}

interface Cursor {
  page: DisplayPage;
  y: number;
  /** Space owed after the previous paragraph. */
  owed: number;
  previous?: LaidParagraph;
  atTop: boolean;
}

export interface Pagination {
  pages: DisplayPage[];
  /** Page index by bookmark name. */
  bookmarks: Map<string, number>;
}

export function paginate(model: DocxModel, ctx: LayoutContext, furniture: PageFurniture, extraBlocks?: (width: number) => LaidBlock[]): Pagination {
  const pages: DisplayPage[] = [];
  const bookmarks = new Map<string, number>();
  let numberOffset = 0;

  model.sections.forEach((section, sectionIndex) => {
    const props = section.props;
    const contentWidth = Math.max(props.pageWidth - props.margins.left - props.margins.right, 36);
    const isLast = sectionIndex === model.sections.length - 1;
    const laid = layoutBlocks(section.blocks, contentWidth, ctx);
    if (isLast && extraBlocks) laid.push(...extraBlocks(contentWidth));

    const startsNewPage = props.type !== "continuous" || pages.length === 0 || !sameGeometry(model.sections[sectionIndex - 1]?.props, props);
    if (props.pageNumberStart !== undefined) numberOffset = props.pageNumberStart - 1 - pages.length;
    let cursor: Cursor | undefined = startsNewPage ? undefined : { page: pages[pages.length - 1] as DisplayPage, y: 0, owed: 0, atTop: false };

    const kindFor = (indexInSection: number, number: number): DisplayPage["kind"] => {
      if (props.titlePage && indexInSection === 0) return "first";
      if (model.evenAndOddHeaders && number % 2 === 0) return "even";
      return "default";
    };
    let indexInSection = 0;

    const bodyTop = (kind: DisplayPage["kind"]) => Math.max(props.margins.top, props.margins.header + furniture.headerHeight(props, kind) + (furniture.headerHeight(props, kind) > 0 ? 6 : 0));
    const bodyBottom = (kind: DisplayPage["kind"]) => {
      const footer = furniture.footerHeight(props, kind);
      return props.pageHeight - Math.max(props.margins.bottom, props.margins.footer + footer + (footer > 0 ? 6 : 0));
    };

    const newPage = (): Cursor => {
      const number = pages.length + 1 + numberOffset;
      const kind = kindFor(indexInSection, number);
      const page: DisplayPage = { sectionIndex, number, width: props.pageWidth, height: props.pageHeight, behind: [], items: [], front: [], kind };
      pages.push(page);
      indexInSection += 1;
      return { page, y: bodyTop(kind), owed: 0, atTop: true };
    };
    if (!cursor) cursor = newPage();
    else {
      cursor.y = Math.max(cursor.y, bodyTop(cursor.page.kind));
      indexInSection = 1;
    }
    let current = cursor;
    const limit = () => bodyBottom(current.page.kind);
    const breakPage = () => {
      current = newPage();
    };

    const flushOwed = (before: number, keepAtTop: boolean) => {
      // Space before a paragraph at the top of a page is dropped, except when the page was forced.
      if (current.atTop && !keepAtTop) {
        current.owed = 0;
        return 0;
      }
      const gap = current.owed + before;
      current.owed = 0;
      return gap;
    };

    const placeLines = (p: LaidParagraph, lines: Line[], first: boolean, forceTop: boolean): void => {
      const gap = first ? flushOwed(p.before, forceTop) : 0;
      current.y += gap;
      const top = current.y;
      const height = linesHeight(lines);
      const x = props.margins.left + p.left;
      if (p.shading) current.page.items.push({ kind: "rect", x, y: top, width: p.width, height, fill: p.shading });
      current.page.items.push({ kind: "lines", x, y: top, lines });
      const b = p.borders;
      if (b) {
        const pad = (side?: Border) => (side && side.style !== "none" ? side.space + side.width : 0);
        const x1 = x - pad(b.left);
        const x2 = x + p.width + pad(b.right);
        if (b.top && b.top.style !== "none" && first) current.page.items.push({ kind: "edge", x1, y1: top - pad(b.top) / 2, x2, y2: top - pad(b.top) / 2, border: b.top });
        if (b.bottom && b.bottom.style !== "none" && lines === p.lines) current.page.items.push({ kind: "edge", x1, y1: top + height + pad(b.bottom) / 2, x2, y2: top + height + pad(b.bottom) / 2, border: b.bottom });
        if (b.left && b.left.style !== "none") current.page.items.push({ kind: "edge", x1, y1: top, x2: x1, y2: top + height, border: b.left });
        if (b.right && b.right.style !== "none") current.page.items.push({ kind: "edge", x1: x2, y1: top, x2, y2: top + height, border: b.right });
      }
      current.y = top + height;
      current.atTop = false;
    };

    const placeOverlays = (p: LaidParagraph, paragraphTop: number) => {
      for (const overlay of p.overlays) {
        const placed = overlayRect(overlay, props, paragraphTop, p.left);
        const item: DisplayItem = { kind: "image", x: placed.x, y: placed.y, width: overlay.width, height: overlay.height, image: overlay.image };
        if (overlay.anchor.behind) current.page.behind.push(item);
        else current.page.front.push(item);
      }
    };

    const placeParagraph = (p: LaidParagraph, nextBlock: LaidBlock | undefined, chainHeight: number): void => {
      if (p.pageBreakBefore && !current.atTop) breakPage();
      const forced = p.pageBreakBefore;
      const registerBookmarks = () => {
        for (const name of p.bookmarks) bookmarks.set(name, pages.indexOf(current.page));
      };
      // Keep with next: a heading must not be left alone at the bottom of a page.
      if (p.keepNext && nextBlock && !current.atTop) {
        const needed = p.before + p.height + p.after + chainHeight;
        const available = limit() - current.y - current.owed;
        const fullPage = limit() - bodyTop(current.page.kind);
        if (needed > available && needed <= fullPage) breakPage();
      }
      if (p.lines.length === 0) {
        const gap = flushOwed(p.before, forced);
        current.y += gap;
        registerBookmarks();
        placeOverlays(p, current.y);
        current.owed = p.after;
        return;
      }
      let remaining = p.lines;
      let first = true;
      let paragraphTop = current.y;
      while (remaining.length > 0) {
        const before = first ? (current.atTop && !forced ? 0 : current.owed + p.before) : 0;
        const available = limit() - current.y - before;
        let fit = 0;
        let used = 0;
        while (fit < remaining.length && used + (remaining[fit] as Line).height <= available + 0.01) {
          used += (remaining[fit] as Line).height;
          fit += 1;
          if ((remaining[fit - 1] as Line).pageBreakAfter) break;
        }
        const total = remaining.length;
        const forcedBreak = fit > 0 && (remaining[fit - 1] as Line).pageBreakAfter;
        if (fit < total && !forcedBreak) {
          const orphan = p.widowControl ? 2 : 1;
          const widow = p.widowControl ? 2 : 1;
          if (p.keepLines && first && !current.atTop) {
            breakPage();
            continue;
          }
          if (fit < orphan && !current.atTop) {
            breakPage();
            continue;
          }
          if (total - fit < widow && fit - (widow - (total - fit)) >= orphan) fit -= widow - (total - fit);
          if (fit === 0) fit = 1; // never loop forever on a line taller than the page
        }
        const slice = remaining.slice(0, fit);
        if (first) {
          paragraphTop = current.y + (current.atTop && !forced ? 0 : current.owed + p.before);
          registerBookmarks();
        }
        placeLines(p, slice, first, forced);
        if (first) placeOverlays(p, paragraphTop);
        first = false;
        remaining = remaining.slice(fit);
        const lastPlaced = slice[slice.length - 1] as Line;
        if (remaining.length > 0 || lastPlaced.pageBreakAfter) {
          breakPage();
          if (remaining.length === 0) {
            current.owed = 0;
            current.previous = p;
            return;
          }
        }
      }
      current.owed = p.after;
      current.previous = p;
    };

    const placeTable = (t: LaidTable): void => {
      current.owed = 0;
      const headers = t.rows.filter((row, index) => row.header && t.rows.slice(0, index).every((r) => r.header));
      const draw = (row: LaidRow, y: number) => drawRow(t, row, y, props.margins.left, current.page, rowSpanEnd(t, row));
      t.rows.forEach((row, index) => {
        const available = limit() - current.y;
        if (row.height > available + 0.01 && !(current.atTop && index === 0)) {
          const fullPage = limit() - bodyTop(current.page.kind);
          if (row.height > fullPage && current.atTop) {
            ctx.warnings.add("tall-row");
          } else {
            breakPage();
            // The header rows repeat at the top of every page the table continues on.
            if (headers.length > 0 && !row.header) for (const header of headers) {
              draw(header, current.y);
              current.y += header.height;
            }
          }
        }
        draw(row, current.y);
        current.y += row.height;
        current.atTop = false;
      });
      current.previous = undefined;
    };

    laid.forEach((block, index) => {
      if (block.kind === "t") {
        placeTable(block);
        return;
      }
      const prev = current.previous;
      if (prev && prev.contextual && block.contextual && prev.styleId === block.styleId) {
        current.owed = 0;
        block = { ...block, before: 0 };
      }
      // How much of what follows must travel with a keep-with-next paragraph.
      let chain = 0;
      if (block.keepNext) {
        for (let next = index + 1; next < laid.length; next += 1) {
          const following = laid[next] as LaidBlock;
          if (following.kind === "t") {
            chain += (following.rows[0]?.height ?? 0) + 0;
            break;
          }
          const firstLine = following.lines[0]?.height ?? following.height;
          chain += following.before + firstLine;
          if (!following.keepNext) break;
          chain += following.height - firstLine + following.after;
        }
      }
      placeParagraph(block, laid[index + 1], chain);
    });
  });

  return { pages, bookmarks };
}

function sameGeometry(a: SectionProps | undefined, b: SectionProps): boolean {
  if (!a) return false;
  return a.pageWidth === b.pageWidth && a.pageHeight === b.pageHeight && a.margins.left === b.margins.left && a.margins.right === b.margins.right && a.margins.top === b.margins.top && a.margins.bottom === b.margins.bottom;
}

function rowSpanEnd(table: LaidTable, row: LaidRow): number {
  return table.rows.indexOf(row);
}

/** Where an anchored picture sits on the page. */
function overlayRect(overlay: LaidParagraph["overlays"][number], section: SectionProps, paragraphTop: number, paragraphLeft: number): { x: number; y: number } {
  const a = overlay.anchor;
  const contentWidth = section.pageWidth - section.margins.left - section.margins.right;
  const contentHeight = section.pageHeight - section.margins.top - section.margins.bottom;
  let x: number;
  const frameLeft = a.hFrom === "page" ? 0 : section.margins.left;
  const frameWidth = a.hFrom === "page" ? section.pageWidth : contentWidth;
  if (a.hAlign === "center") x = frameLeft + (frameWidth - overlay.width) / 2;
  else if (a.hAlign === "right" || a.hAlign === "outside") x = frameLeft + frameWidth - overlay.width;
  else if (a.hAlign === "left" || a.hAlign === "inside") x = frameLeft;
  else x = (a.hFrom === "column" || a.hFrom === "character" ? section.margins.left + paragraphLeft : frameLeft) + a.hOffset;
  let y: number;
  const frameTop = a.vFrom === "page" ? 0 : a.vFrom === "paragraph" || a.vFrom === "line" ? paragraphTop : section.margins.top;
  const frameHeight = a.vFrom === "page" ? section.pageHeight : contentHeight;
  if (a.vAlign === "center") y = frameTop + (frameHeight - overlay.height) / 2;
  else if (a.vAlign === "bottom" || a.vAlign === "outside") y = frameTop + frameHeight - overlay.height;
  else if (a.vAlign === "top" || a.vAlign === "inside") y = frameTop;
  else y = frameTop + a.vOffset;
  return { x, y };
}

// ---- rows ------------------------------------------------------------------------------------------------

/** Puts a table row's backgrounds, text and borders on the page at (x, y). */
function drawRow(table: LaidTable, row: LaidRow, y: number, contentLeft: number, page: Pick<DisplayPage, "items">, _end: number): void {
  const originX = contentLeft + table.left;
  for (const cell of row.cells) {
    if (cell.vMergeContinue) continue;
    const x = originX + cell.x;
    if (cell.props.shading) page.items.push({ kind: "rect", x, y, width: cell.width, height: cell.height, fill: cell.props.shading });
  }
  for (const cell of row.cells) {
    if (cell.vMergeContinue) continue;
    const x = originX + cell.x;
    const free = cell.height - cell.margins.top - cell.margins.bottom - cell.contentHeight;
    const shift = cell.props.vAlign === "center" ? free / 2 : cell.props.vAlign === "bottom" ? free : 0;
    placeBlocks(cell.blocks, x + cell.innerLeft, y + cell.margins.top + Math.max(shift, 0), cell.innerWidth, page);
  }
  for (const cell of row.cells) {
    if (cell.vMergeContinue) continue;
    const x = originX + cell.x;
    const b = cell.props.borders ?? {};
    if (b.top) page.items.push({ kind: "edge", x1: x, y1: y, x2: x + cell.width, y2: y, border: b.top });
    if (b.bottom) page.items.push({ kind: "edge", x1: x, y1: y + cell.height, x2: x + cell.width, y2: y + cell.height, border: b.bottom });
    if (b.left) page.items.push({ kind: "edge", x1: x, y1: y, x2: x, y2: y + cell.height, border: b.left });
    if (b.right) page.items.push({ kind: "edge", x1: x + cell.width, y1: y, x2: x + cell.width, y2: y + cell.height, border: b.right });
  }
}

/** Content of a table cell: no page breaking, just stacked from the top. */
export function placeBlocks(blocks: LaidBlock[], x: number, y: number, width: number, page: Pick<DisplayPage, "items">): number {
  let cursor = y;
  let owed = 0;
  blocks.forEach((block, index) => {
    if (block.kind === "p") {
      cursor += index === 0 ? block.before : owed + block.before;
      if (block.shading) page.items.push({ kind: "rect", x: x + block.left, y: cursor, width: block.width, height: block.height, fill: block.shading });
      if (block.lines.length > 0) page.items.push({ kind: "lines", x: x + block.left, y: cursor, lines: block.lines });
      cursor += block.height;
      owed = block.after;
    } else {
      cursor += owed;
      owed = 0;
      for (const row of block.rows) {
        drawRow(block, row, cursor, x, page, 0);
        cursor += row.height;
      }
    }
  });
  void width;
  return cursor - y;
}
