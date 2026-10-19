/** Reads an .xlsx workbook into the model the layout works from. */
import { AppError } from "../../errors";
import { type OfficePackage, resolvePartPath, sniffImage } from "../package";
import { type Theme, readTheme, tintColor } from "../theme";
import { excelColumnWidthToPt, emuToPt } from "../units";
import type { Warnings } from "../warnings";
import { type XNode, descendants, elements, kid, kids, num, textOf } from "../xml";
import type { BorderDef, BorderSide, Cell, CellFormat, FontDef, HAlign, MergeRange, RichRun, Sheet, SheetImage, SheetPageSetup, VAlign, Workbook } from "./model";

/** Spreadsheet files normally have no namespace prefix, but some writers use one ("x:worksheet"); drop it. */
function unprefix(node: XNode): XNode {
  const colon = node.name.indexOf(":");
  if (colon > 0) node.name = node.name.slice(colon + 1);
  for (const child of node.children) if (typeof child !== "string") unprefix(child);
  return node;
}

function normalised(node: XNode | undefined): XNode | undefined {
  if (!node) return undefined;
  return node.name.includes(":") ? unprefix(node) : node;
}

export function columnIndex(letters: string): number {
  let value = 0;
  for (const char of letters.toUpperCase()) value = value * 26 + (char.charCodeAt(0) - 64);
  return value - 1;
}

export function parseCellRef(ref: string): { row: number; col: number } | undefined {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref.trim());
  if (!match) return undefined;
  return { col: columnIndex(match[1] as string), row: Number(match[2]) - 1 };
}

export function parseRange(ref: string): MergeRange | undefined {
  const [from, to] = ref.split(":");
  const start = parseCellRef(from ?? "");
  const end = parseCellRef(to ?? from ?? "");
  if (!start || !end) return undefined;
  return { row: Math.min(start.row, end.row), col: Math.min(start.col, end.col), rows: Math.abs(end.row - start.row) + 1, cols: Math.abs(end.col - start.col) + 1 };
}

// The legacy 64-colour palette that "indexed" colours point into.
const INDEXED = [
  "000000", "ffffff", "ff0000", "00ff00", "0000ff", "ffff00", "ff00ff", "00ffff", "000000", "ffffff", "ff0000", "00ff00", "0000ff", "ffff00", "ff00ff", "00ffff",
  "800000", "008000", "000080", "808000", "800080", "008080", "c0c0c0", "808080", "9999ff", "993366", "ffffcc", "ccffff", "660066", "ff8080", "0066cc", "ccccff",
  "000080", "ff00ff", "ffff00", "00ffff", "800080", "800000", "008080", "0000ff", "00ccff", "ccffff", "ccffcc", "ffff99", "99ccff", "ff99cc", "cc99ff", "ffcc99",
  "3366ff", "33cccc", "99cc00", "ffcc00", "ff9900", "ff6600", "666699", "969696", "003366", "339966", "003300", "333300", "993300", "993366", "333399", "333333",
];

// Spreadsheet theme colour numbers: lt1 and dk1 come first, the reverse of the order in the theme file.
const THEME_ORDER = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];

function parseColor(node: XNode | undefined, theme: Theme): string | undefined {
  if (!node) return undefined;
  if (node.attrs.rgb) {
    const rgb = node.attrs.rgb.length === 8 ? node.attrs.rgb.slice(2) : node.attrs.rgb;
    return /^[0-9a-fA-F]{6}$/.test(rgb) ? `#${rgb.toLowerCase()}` : undefined;
  }
  if (node.attrs.theme !== undefined) {
    const base = theme.colors[THEME_ORDER[Number(node.attrs.theme)] ?? ""];
    if (base) return tintColor(base, Number(node.attrs.tint ?? 0));
  }
  if (node.attrs.indexed !== undefined) {
    const hex = INDEXED[Number(node.attrs.indexed)];
    if (hex) return `#${hex}`;
  }
  return undefined;
}

function parseFont(font: XNode | undefined, theme: Theme): FontDef {
  const underline = kid(font, "u");
  const bold = kid(font, "b");
  const italic = kid(font, "i");
  const strike = kid(font, "strike");
  const off = (node: XNode | undefined) => node !== undefined && (node.attrs.val === "0" || node.attrs.val === "false");
  return {
    name: kid(font, "name")?.attrs.val ?? kid(font, "rFont")?.attrs.val ?? "Calibri",
    size: num(kid(font, "sz"), "val", 11),
    bold: bold !== undefined && !off(bold),
    italic: italic !== undefined && !off(italic),
    underline: underline ? (underline.attrs.val === "double" || underline.attrs.val === "doubleAccounting" ? "double" : underline.attrs.val === "none" ? undefined : "single") : undefined,
    strike: strike !== undefined && !off(strike),
    color: parseColor(kid(font, "color"), theme),
  };
}

function parseSide(node: XNode | undefined, theme: Theme): BorderSide | undefined {
  const style = node?.attrs.style;
  if (!node || !style || style === "none") return undefined;
  const known: BorderSide["style"][] = ["thin", "medium", "thick", "dashed", "dotted", "double", "hair"];
  const mapped: BorderSide["style"] = known.includes(style as BorderSide["style"]) ? (style as BorderSide["style"]) : style.startsWith("medium") ? "medium" : style.includes("dash") || style.includes("Dash") ? "dashed" : "thin";
  return { style: mapped, color: parseColor(kid(node, "color"), theme) ?? "#000000" };
}

export class XlsxReader {
  private readonly media = new Map<string, { bytes: Uint8Array }>();
  private theme: Theme = { colors: {} };

  constructor(
    private readonly pack: OfficePackage,
    private readonly warnings: Warnings,
  ) {}

  read(): Workbook {
    this.theme = readTheme(this.pack, "xl/theme/");
    const workbook = normalised(this.pack.xml("xl/workbook.xml"));
    if (!workbook) throw new AppError("INVALID_FILE", "This file has no workbook part, so it cannot be read as an Excel file.");
    const rels = this.pack.relationships("xl/workbook.xml");
    const shared = this.readSharedStrings();
    const { formats, defaultFont } = this.readStyles();
    const names = this.readDefinedNames(workbook);

    const sheets: Sheet[] = [];
    let hidden = 0;
    kids(kid(workbook, "sheets"), "sheet").forEach((node, index) => {
      const rel = rels.get(node.attrs["r:id"] ?? "");
      const state = node.attrs.state;
      if (!rel || rel.external) return;
      if (state === "hidden" || state === "veryHidden") {
        hidden += 1;
        return;
      }
      const sheet = this.readSheet(node.attrs.name ?? `Sheet${index + 1}`, rel.target, shared, formats, defaultFont);
      const scoped = names.filter((entry) => entry.sheet === index);
      for (const entry of scoped) {
        if (entry.name === "_xlnm.Print_Area") sheet.printArea = entry.area;
        if (entry.name === "_xlnm.Print_Titles") {
          sheet.printTitleRows = entry.rows;
          sheet.printTitleColumns = entry.columns;
        }
      }
      sheets.push(sheet);
    });
    if (hidden > 0) this.warnings.add("sheet-hidden", hidden);
    if (sheets.length === 0) throw new AppError("INVALID_FILE", "This workbook has no visible sheets to convert.");

    const core = this.pack.xml("docProps/core.xml");
    return {
      sheets,
      formats,
      date1904: kid(workbook, "workbookPr")?.attrs.date1904 === "1" || kid(workbook, "workbookPr")?.attrs.date1904 === "true",
      defaultFont,
      media: this.media,
      title: textOf(kid(core, "dc:title")).trim() || undefined,
      author: textOf(kid(core, "dc:creator")).trim() || undefined,
    };
  }

  private readDefinedNames(workbook: XNode): { name: string; sheet: number; area?: MergeRange; rows?: { first: number; last: number }; columns?: { first: number; last: number } }[] {
    const out: { name: string; sheet: number; area?: MergeRange; rows?: { first: number; last: number }; columns?: { first: number; last: number } }[] = [];
    for (const node of kids(kid(workbook, "definedNames"), "definedName")) {
      const name = node.attrs.name;
      if ((name !== "_xlnm.Print_Area" && name !== "_xlnm.Print_Titles") || node.attrs.localSheetId === undefined) continue;
      const sheet = Number(node.attrs.localSheetId);
      const text = textOf(node);
      const entry: (typeof out)[number] = { name, sheet };
      for (const part of text.split(",")) {
        const reference = part.slice(part.lastIndexOf("!") + 1).replace(/\$/g, "");
        if (name === "_xlnm.Print_Area") {
          if (!entry.area) entry.area = parseRange(reference);
        } else if (/^\d+:\d+$/.test(reference)) {
          const [a, b] = reference.split(":").map(Number) as [number, number];
          entry.rows = { first: a - 1, last: b - 1 };
        } else if (/^[A-Za-z]+:[A-Za-z]+$/.test(reference)) {
          const [a, b] = reference.split(":") as [string, string];
          entry.columns = { first: columnIndex(a), last: columnIndex(b) };
        }
      }
      out.push(entry);
    }
    return out;
  }

  private readSharedStrings(): { text: string; rich?: RichRun[] }[] {
    const root = normalised(this.pack.xml("xl/sharedStrings.xml"));
    const out: { text: string; rich?: RichRun[] }[] = [];
    for (const item of kids(root, "si")) out.push(this.readRichText(item));
    return out;
  }

  /** Text of an <si> or <is> element, with its formatting runs when there is more than one. */
  private readRichText(item: XNode): { text: string; rich?: RichRun[] } {
    const runs = kids(item, "r");
    if (runs.length === 0) return { text: kids(item, "t").map(textOf).join("") };
    const rich: RichRun[] = runs.map((run) => {
      const properties = kid(run, "rPr");
      const font: Partial<FontDef> = {};
      if (properties) {
        const parsed = parseFont(properties, this.theme);
        const fontName = kid(properties, "rFont")?.attrs.val;
        if (fontName) font.name = fontName;
        if (kid(properties, "sz")) font.size = parsed.size;
        if (kid(properties, "b")) font.bold = parsed.bold;
        if (kid(properties, "i")) font.italic = parsed.italic;
        if (kid(properties, "u")) font.underline = parsed.underline;
        if (kid(properties, "strike")) font.strike = parsed.strike;
        if (kid(properties, "color")) font.color = parsed.color;
      }
      return { text: textOf(kid(run, "t")), font };
    });
    return { text: rich.map((run) => run.text).join(""), rich };
  }

  private readStyles(): { formats: CellFormat[]; defaultFont: FontDef } {
    const root = normalised(this.pack.xml("xl/styles.xml"));
    const numFmts = new Map<number, string>();
    for (const fmt of kids(kid(root, "numFmts"), "numFmt")) numFmts.set(num(fmt, "numFmtId", -1), fmt.attrs.formatCode ?? "General");
    const fonts = kids(kid(root, "fonts"), "font").map((font) => parseFont(font, this.theme));
    const defaultFont = fonts[0] ?? { name: "Calibri", size: 11, bold: false, italic: false, strike: false };
    const fills = kids(kid(root, "fills"), "fill").map((fill): string | undefined => {
      const pattern = kid(fill, "patternFill");
      if (pattern) {
        if (pattern.attrs.patternType !== "solid") return undefined;
        return parseColor(kid(pattern, "fgColor"), this.theme);
      }
      const gradient = kid(fill, "gradientFill");
      if (gradient) {
        this.warnings.add("gradient");
        return parseColor(kid(kid(gradient, "stop"), "color"), this.theme);
      }
      return undefined;
    });
    const borders = kids(kid(root, "borders"), "border").map((border): BorderDef => ({
      left: parseSide(kid(border, "left") ?? kid(border, "start"), this.theme),
      right: parseSide(kid(border, "right") ?? kid(border, "end"), this.theme),
      top: parseSide(kid(border, "top"), this.theme),
      bottom: parseSide(kid(border, "bottom"), this.theme),
    }));
    const formats: CellFormat[] = kids(kid(root, "cellXfs"), "xf").map((xf) => {
      const alignment = kid(xf, "alignment");
      const id = num(xf, "numFmtId", 0);
      const horizontal = alignment?.attrs.horizontal as HAlign | undefined;
      const vertical = alignment?.attrs.vertical as VAlign | undefined;
      return {
        font: fonts[num(xf, "fontId", 0)] ?? defaultFont,
        fill: fills[num(xf, "fillId", 0)],
        border: borders[num(xf, "borderId", 0)] ?? {},
        numFmt: numFmts.get(id) ?? id,
        halign: horizontal ?? "general",
        valign: vertical ?? "bottom",
        wrap: alignment?.attrs.wrapText === "1" || alignment?.attrs.wrapText === "true",
        indent: num(alignment, "indent", 0),
        rotation: num(alignment, "textRotation", 0),
        shrink: alignment?.attrs.shrinkToFit === "1" || alignment?.attrs.shrinkToFit === "true",
      };
    });
    if (formats.length === 0) formats.push({ font: defaultFont, border: {}, numFmt: 0, halign: "general", valign: "bottom", wrap: false, indent: 0, rotation: 0, shrink: false });
    return { formats, defaultFont };
  }

  private readSheet(name: string, path: string, shared: { text: string; rich?: RichRun[] }[], formats: CellFormat[], defaultFont: FontDef): Sheet {
    const root = normalised(this.pack.xml(path));
    const rels = this.pack.relationships(path);
    const cells = new Map<number, Map<number, Cell>>();
    const rowHeights = new Map<number, number>();
    const hiddenRows = new Set<number>();
    const rowFormats = new Map<number, number>();
    const columnFormats = new Map<number, number>();
    const columnWidths = new Map<number, number>();
    const hiddenColumns = new Set<number>();

    const format = kid(root, "sheetFormatPr");
    // Excel's default width is the base width plus 0.71 characters of padding (8.43 for the usual base of 8).
    const defaultChars = format?.attrs.defaultColWidth ? Number(format.attrs.defaultColWidth) : num(format, "baseColWidth", 8) + 0.71;
    const defaultColumnWidth = excelColumnWidthToPt(defaultChars);
    const defaultRowHeight = num(format, "defaultRowHeight", Math.round(defaultFont.size * 1.36 * 4) / 4);

    for (const col of kids(kid(root, "cols"), "col")) {
      const first = num(col, "min", 1) - 1;
      const last = Math.min(num(col, "max", first + 1) - 1, first + 16383);
      const width = col.attrs.width !== undefined ? excelColumnWidthToPt(Number(col.attrs.width)) : undefined;
      for (let index = first; index <= last && index < 2000; index += 1) {
        if (width !== undefined) columnWidths.set(index, width);
        if (col.attrs.hidden === "1" || col.attrs.hidden === "true") hiddenColumns.add(index);
        if (col.attrs.style !== undefined) columnFormats.set(index, Number(col.attrs.style));
      }
    }

    let maxRow = -1;
    let maxColumn = -1;
    let uncached = 0;
    let nextRow = 0;
    for (const row of kids(kid(root, "sheetData"), "row")) {
      const rowIndex = row.attrs.r !== undefined ? Number(row.attrs.r) - 1 : nextRow;
      nextRow = rowIndex + 1;
      if (row.attrs.ht !== undefined) rowHeights.set(rowIndex, Number(row.attrs.ht));
      if (row.attrs.hidden === "1" || row.attrs.hidden === "true") hiddenRows.add(rowIndex);
      if (row.attrs.s !== undefined && (row.attrs.customFormat === "1" || row.attrs.customFormat === "true")) rowFormats.set(rowIndex, Number(row.attrs.s));
      let columnCursor = 0;
      for (const node of kids(row, "c")) {
        const ref = node.attrs.r ? parseCellRef(node.attrs.r) : undefined;
        const col = ref?.col ?? columnCursor;
        columnCursor = col + 1;
        const cell = this.readCell(node, shared);
        if (cell.uncached) uncached += 1;
        const visible = cell.type !== "blank" || this.hasVisibleFormat(formats[cell.format]);
        if (!visible) continue;
        let line = cells.get(rowIndex);
        if (!line) {
          line = new Map();
          cells.set(rowIndex, line);
        }
        line.set(col, cell);
        maxRow = Math.max(maxRow, rowIndex);
        maxColumn = Math.max(maxColumn, col);
      }
    }
    if (uncached > 0) this.warnings.add("formulas-uncached", uncached);

    const merges: MergeRange[] = [];
    for (const merge of kids(kid(root, "mergeCells"), "mergeCell")) {
      const range = merge.attrs.ref ? parseRange(merge.attrs.ref) : undefined;
      if (range && (range.rows > 1 || range.cols > 1)) {
        merges.push(range);
        maxRow = Math.max(maxRow, range.row + range.rows - 1);
        maxColumn = Math.max(maxColumn, range.col + range.cols - 1);
      }
    }
    if (kids(root, "conditionalFormatting").length > 0) this.warnings.add("conditional-formatting");

    const margins = kid(root, "pageMargins");
    const pageSetup = kid(root, "pageSetup");
    const options = kid(root, "printOptions");
    const fit = kid(kid(root, "sheetPr"), "pageSetUpPr")?.attrs.fitToPage;
    const setup: SheetPageSetup = {
      landscape: pageSetup?.attrs.orientation === "landscape" ? true : pageSetup?.attrs.orientation === "portrait" ? false : undefined,
      paperSize: pageSetup?.attrs.paperSize ? Number(pageSetup.attrs.paperSize) : undefined,
      scale: pageSetup?.attrs.scale ? Number(pageSetup.attrs.scale) : undefined,
      fitToPage: fit === "1" || fit === "true",
      fitToWidth: num(pageSetup, "fitToWidth", 1),
      fitToHeight: num(pageSetup, "fitToHeight", 1),
      margins: {
        left: num(margins, "left", 0.7),
        right: num(margins, "right", 0.7),
        top: num(margins, "top", 0.75),
        bottom: num(margins, "bottom", 0.75),
        header: num(margins, "header", 0.3),
        footer: num(margins, "footer", 0.3),
      },
      gridLines: options?.attrs.gridLines === "1" || options?.attrs.gridLines === "true",
      horizontalCentered: options?.attrs.horizontalCentered === "1" || options?.attrs.horizontalCentered === "true",
      verticalCentered: options?.attrs.verticalCentered === "1" || options?.attrs.verticalCentered === "true",
      overThenDown: pageSetup?.attrs.pageOrder === "overThenDown",
      firstPageNumber: pageSetup?.attrs.useFirstPageNumber === "1" ? num(pageSetup, "firstPageNumber", 1) : undefined,
    };

    const hyperlinks: Sheet["hyperlinks"] = [];
    for (const link of kids(kid(root, "hyperlinks"), "hyperlink")) {
      const range = link.attrs.ref ? parseRange(link.attrs.ref) : undefined;
      const rel = link.attrs["r:id"] ? rels.get(link.attrs["r:id"]) : undefined;
      if (range && rel?.external) hyperlinks.push({ ...range, uri: rel.target });
    }

    const sheet: Sheet = {
      name,
      visible: true,
      cells,
      rowCount: maxRow + 1,
      columnCount: maxColumn + 1,
      defaultColumnWidth,
      defaultRowHeight,
      columnWidths,
      hiddenColumns,
      rowHeights,
      hiddenRows,
      merges,
      setup,
      header: textOf(kid(kid(root, "headerFooter"), "oddHeader")),
      footer: textOf(kid(kid(root, "headerFooter"), "oddFooter")),
      rowBreaks: kids(kid(root, "rowBreaks"), "brk").map((brk) => num(brk, "id", -1)).filter((id) => id >= 0),
      columnBreaks: kids(kid(root, "colBreaks"), "brk").map((brk) => num(brk, "id", -1)).filter((id) => id >= 0),
      images: [],
      hyperlinks,
      rowFormats,
      columnFormats,
    };
    const drawing = kid(root, "drawing");
    const drawingRel = drawing ? rels.get(drawing.attrs["r:id"] ?? "") : undefined;
    if (drawingRel && !drawingRel.external) sheet.images = this.readDrawing(drawingRel.target, sheet);
    return sheet;
  }

  private hasVisibleFormat(format: CellFormat | undefined): boolean {
    if (!format) return false;
    const border = format.border;
    return format.fill !== undefined || border.left !== undefined || border.right !== undefined || border.top !== undefined || border.bottom !== undefined;
  }

  private readCell(node: XNode, shared: { text: string; rich?: RichRun[] }[]): Cell {
    const format = node.attrs.s !== undefined ? Number(node.attrs.s) : 0;
    const type = node.attrs.t ?? "n";
    const raw = textOf(kid(node, "v"));
    const hasFormula = kid(node, "f") !== undefined;
    if (type === "inlineStr") {
      const inline = kid(node, "is");
      const text = inline ? this.readRichText(inline) : { text: "" };
      return { type: text.text === "" ? "blank" : "string", value: text.text, format, rich: text.rich };
    }
    if (raw === "" && kid(node, "v") === undefined) return { type: "blank", value: null, format, uncached: hasFormula };
    switch (type) {
      case "s": {
        const entry = shared[Number(raw)];
        return entry ? { type: "string", value: entry.text, format, rich: entry.rich } : { type: "blank", value: null, format };
      }
      case "str":
        return { type: raw === "" ? "blank" : "string", value: raw, format };
      case "b":
        return { type: "boolean", value: raw === "1" || raw === "true", format };
      case "e":
        return { type: "error", value: raw, format };
      case "d": {
        const time = Date.parse(raw);
        return Number.isNaN(time) ? { type: "string", value: raw, format } : { type: "number", value: time / 86400000 + 25569, format };
      }
      default: {
        const value = Number(raw);
        return Number.isFinite(value) ? { type: "number", value, format } : { type: "string", value: raw, format };
      }
    }
  }

  /** Pictures placed over cells. Charts and shapes are counted as left out. */
  private readDrawing(path: string, sheet: Sheet): SheetImage[] {
    const root = this.pack.xml(path);
    const rels = this.pack.relationships(path);
    const out: SheetImage[] = [];
    const corner = (node: XNode | undefined) => ({
      col: Number(textOf(kid(node, "xdr:col")) || 0),
      row: Number(textOf(kid(node, "xdr:row")) || 0),
      dx: emuToPt(Number(textOf(kid(node, "xdr:colOff")) || 0)),
      dy: emuToPt(Number(textOf(kid(node, "xdr:rowOff")) || 0)),
    });
    for (const anchor of elements(root)) {
      if (anchor.name !== "xdr:twoCellAnchor" && anchor.name !== "xdr:oneCellAnchor" && anchor.name !== "xdr:absoluteAnchor") continue;
      const picture = kid(anchor, "xdr:pic");
      if (!picture) {
        if (kid(anchor, "xdr:graphicFrame")) this.warnings.add("chart");
        else if (descendants(anchor, "xdr:txBody").length > 0) this.warnings.add("textbox");
        else if (kid(anchor, "xdr:sp") || kid(anchor, "xdr:grpSp") || kid(anchor, "xdr:cxnSp")) this.warnings.add("shape");
        continue;
      }
      const blip = descendants(picture, "a:blip")[0];
      const rel = blip?.attrs["r:embed"] ? rels.get(blip.attrs["r:embed"]) : undefined;
      const bytes = rel && !rel.external ? this.pack.bytes(rel.target) : undefined;
      if (!rel || !bytes) {
        this.warnings.add("image-broken");
        continue;
      }
      const format = sniffImage(bytes);
      if (format !== "png" && format !== "jpeg" && format !== "gif" && format !== "bmp" && format !== "webp") {
        this.warnings.add("image-format", 1, format === "unknown" ? undefined : format.toUpperCase());
        continue;
      }
      this.media.set(rel.target, { bytes });
      const from = corner(kid(anchor, "xdr:from"));
      if (anchor.name === "xdr:twoCellAnchor") out.push({ part: rel.target, from, to: corner(kid(anchor, "xdr:to")) });
      else {
        const ext = kid(anchor, "xdr:ext");
        out.push({ part: rel.target, from, size: { width: emuToPt(num(ext, "cx", 0)), height: emuToPt(num(ext, "cy", 0)) } });
      }
    }
    void sheet;
    void resolvePartPath;
    return out;
  }
}
