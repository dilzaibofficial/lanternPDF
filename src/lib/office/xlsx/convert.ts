/** Excel (.xlsx) and CSV to PDF. */
import { AppError } from "../../errors";
import { FontLibrary, type FontRequest } from "../fontLibrary";
import { OfficePackage } from "../package";
import { PdfBuilder } from "../pdfBuilder";
import { embedImages, sampleChars } from "../shared";
import { TextShaper, type TextStyle } from "../textflow";
import type { ConversionResult, ConvertOptions } from "../types";
import { Warnings } from "../warnings";
import { DEFAULT_XLSX_OPTIONS, type PagePlan, SheetPlan, type XlsxOptions, drawSheetPage, parseHeaderFooter, planPages } from "./layout";
import type { Cell, CellFormat, FontDef, Sheet, Workbook } from "./model";
import { XlsxReader } from "./read";
import { familyFor } from "../fontLibrary";

export type XlsxConvertOptions = ConvertOptions & Partial<XlsxOptions>;

function sheetFonts(book: Workbook): { request: FontRequest; text: string }[] {
  const wanted = new Map<string, { request: FontRequest; chars: Set<string> }>();
  const add = (font: FontDef, text: string) => {
    const key = `${font.name}|${font.bold}|${font.italic}`;
    let entry = wanted.get(key);
    if (!entry) {
      entry = { request: { family: familyFor(font.name), bold: font.bold, italic: font.italic }, chars: new Set() };
      wanted.set(key, entry);
    }
    for (const char of text) entry.chars.add(char);
  };
  add(book.defaultFont, "0123456789.,-+%$()/: ");
  for (const sheet of book.sheets) {
    for (const row of sheet.cells.values()) {
      for (const cell of row.values()) {
        const format = book.formats[cell.format] as CellFormat;
        if (cell.type === "number") add(format.font, "0123456789.,-+%$€£()/: EeAaMmPpJjFfSsOoNnDdTtWwUuHhRrYyGgIiLlCcBbVvKkXxZzQq#");
        else if (cell.type === "boolean") add(format.font, "TRUEFALS");
        else if (cell.type === "string" || cell.type === "error") {
          if (cell.rich) for (const run of cell.rich) add({ ...format.font, ...run.font }, run.text);
          else add(format.font, String(cell.value ?? ""));
        } else add(format.font, "");
      }
    }
  }
  return [...wanted.values()].map(({ request, chars }) => ({ request, text: [...chars].join("") }));
}

async function render(book: Workbook, options: XlsxConvertOptions, warnings: Warnings, fileName: string): Promise<ConversionResult> {
  const progress = (fraction: number, message?: string) => options.onProgress?.(fraction, message);
  const settings: XlsxOptions = { ...DEFAULT_XLSX_OPTIONS, fitWidth: options.fitWidth ?? true, orientation: options.orientation ?? "auto", gridlines: options.gridlines ?? "sheet" };

  progress(0.15, "Loading fonts");
  const fonts = new FontLibrary();
  await fonts.prepare(sheetFonts(book));
  const shaper = new TextShaper(fonts);
  const builder = await PdfBuilder.create();
  progress(0.25, "Preparing pictures");
  const images = await embedImages(builder, book.media, warnings);

  progress(0.35, "Laying out the sheets");
  const plans: { sheet: Sheet; pages: PagePlan[] }[] = [];
  let total = 0;
  const MAX_PAGES = 1500;
  for (const sheet of book.sheets) {
    const plan = new SheetPlan(sheet, book, shaper);
    const pages = planPages(plan, settings);
    plans.push({ sheet, pages });
    total += pages.length;
    if (total > MAX_PAGES) throw new AppError("FILE_TOO_LARGE", `This workbook would make more than ${MAX_PAGES} pages. Set a print area in Excel for the part you need, or split the workbook, and try again.`);
  }
  if (total === 0) throw new AppError("INVALID_FILE", "There is nothing to print in this workbook: every visible sheet is empty.");

  progress(0.55, "Writing the PDF");
  const defaultStyle: TextStyle = { family: familyFor(book.defaultFont.name), bold: false, italic: false, size: Math.min(book.defaultFont.size, 11), color: "#000000" };
  let pageNumber = 0;
  for (const { sheet, pages } of plans) {
    const first = sheet.setup.firstPageNumber;
    if (first !== undefined) pageNumber = first - 1;
    for (const pagePlan of pages) {
      pageNumber += 1;
      const page = builder.addPage(pagePlan.width, pagePlan.height);
      const values = { page: pageNumber, pages: total, sheet: sheet.name, file: fileName };
      const printable = pagePlan.width - pagePlan.margins.left - pagePlan.margins.right;
      const place = (text: { left: string; center: string; right: string }, baseline: number) => {
        const draw = (value: string, anchor: "left" | "center" | "right") => {
          if (value === "") return;
          const width = shaper.width(value, defaultStyle);
          const x = anchor === "left" ? pagePlan.margins.left : anchor === "right" ? pagePlan.margins.left + printable - width : pagePlan.margins.left + (printable - width) / 2;
          let cursor = x;
          for (const piece of shaper.shape(value, defaultStyle)) {
            page.text(piece.font, piece.size, cursor, baseline, piece.text, "#000000");
            cursor += piece.width;
          }
        };
        draw(text.left, "left");
        draw(text.center, "center");
        draw(text.right, "right");
      };
      if (sheet.header) place(parseHeaderFooter(sheet.header, values), pagePlan.margins.header + defaultStyle.size);
      if (sheet.footer) place(parseHeaderFooter(sheet.footer, values), pagePlan.height - pagePlan.margins.footer);
      drawSheetPage({ page, pagePlan, shaper, images, pageNumber, pageCount: total });
    }
  }
  if (shaper.warnings.unsupported.size > 0) warnings.add("missing-glyphs", shaper.warnings.unsupported.size, sampleChars(shaper.warnings.unsupported));
  const baseName = fileName.replace(/\.[^.]+$/, "");
  const bytes = await builder.save({ title: book.title || baseName || undefined, author: book.author });
  progress(0.98, "Done");
  return { bytes, pageCount: total, warnings: warnings.messages() };
}

export async function convertXlsx(bytes: Uint8Array, options: XlsxConvertOptions = {}): Promise<ConversionResult> {
  options.onProgress?.(0.03, "Opening the workbook");
  const pack = OfficePackage.open(bytes, "xlsx");
  const warnings = new Warnings();
  const book = new XlsxReader(pack, warnings).read();
  return render(book, options, warnings, options.name ?? "workbook.xlsx");
}

// ---- CSV ----------------------------------------------------------------------------------------------------

/** Splits CSV text into rows of fields (RFC 4180 quoting). The delimiter is the most common of comma, semicolon and tab. */
export function parseCsv(text: string): string[][] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const sample = clean.split(/\r?\n/).slice(0, 5).join("\n");
  const count = (char: string) => sample.split(char).length - 1;
  const delimiter = [",", ";", "\t"].reduce((best, candidate) => (count(candidate) > count(best) ? candidate : best), ",");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i] as string;
    if (quoted) {
      if (char === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && clean[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += char;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  while (rows.length > 0 && (rows[rows.length - 1] as string[]).every((value) => value === "")) rows.pop();
  return rows;
}

export async function convertCsv(bytes: Uint8Array, options: XlsxConvertOptions = {}): Promise<ConversionResult> {
  options.onProgress?.(0.03, "Reading the file");
  const rows = parseCsv(new TextDecoder("utf-8").decode(bytes));
  if (rows.length === 0) throw new AppError("INVALID_FILE", "This file has no rows to convert.");
  const font: FontDef = { name: "Calibri", size: 10, bold: false, italic: false, strike: false };
  const format: CellFormat = { font, border: {}, numFmt: 0, halign: "general", valign: "bottom", wrap: false, indent: 0, rotation: 0, shrink: false };
  const header: CellFormat = { ...format, font: { ...font, bold: true }, fill: "#e9e9fb" };
  const cells = new Map<number, Map<number, Cell>>();
  let columns = 0;
  rows.forEach((fields, r) => {
    const line = new Map<number, Cell>();
    fields.forEach((value, c) => {
      columns = Math.max(columns, c + 1);
      if (value === "") return;
      const isNumber = /^-?\d+(\.\d+)?$/.test(value.trim()) && value.trim().length < 16;
      line.set(c, isNumber ? { type: "number", value: Number(value), format: r === 0 ? 1 : 0 } : { type: "string", value, format: r === 0 ? 1 : 0 });
    });
    cells.set(r, line);
  });
  // Column widths from the content: the widest of the first rows, within limits.
  const widths = new Map<number, number>();
  for (let c = 0; c < columns; c += 1) {
    let longest = 0;
    for (let r = 0; r < Math.min(rows.length, 400); r += 1) longest = Math.max(longest, ((rows[r] as string[])[c] ?? "").length);
    widths.set(c, Math.min(Math.max(longest * 5.4 + 10, 36), 260));
  }
  const sheet: Sheet = {
    name: "Sheet1",
    visible: true,
    cells,
    rowCount: rows.length,
    columnCount: columns,
    defaultColumnWidth: 48,
    defaultRowHeight: 13.5,
    columnWidths: widths,
    hiddenColumns: new Set(),
    rowHeights: new Map(),
    hiddenRows: new Set(),
    merges: [],
    setup: { fitToPage: false, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 }, gridLines: true, horizontalCentered: false, verticalCentered: false, overThenDown: false },
    header: "",
    footer: "&C&P",
    rowBreaks: [],
    columnBreaks: [],
    images: [],
    hyperlinks: [],
    rowFormats: new Map(),
    columnFormats: new Map(),
    printTitleRows: { first: 0, last: 0 },
  };
  const book: Workbook = { sheets: [sheet], formats: [format, header], date1904: false, defaultFont: font, media: new Map() };
  return render(book, { ...options, gridlines: options.gridlines ?? "on" }, new Warnings(), options.name ?? "data.csv");
}
