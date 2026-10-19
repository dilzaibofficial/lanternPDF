import type { PDFDocumentProxy } from "pdfjs-dist";
import { unzipSync } from "fflate";
import { BRAND } from "../../config/brand";
import { AppError } from "../errors";
import { baseName, plural } from "../format";
import { MIME, type OutputFile } from "../pdf/types";
import { type DocxPage, buildDocx } from "./docxBuilder";
import { type Block, type Line, type Paragraph, type TableBlock, bodyFontSize, buildLines, buildParagraphs, findTables, headingSizes, lineLeft, lineRight, lineText, parseNumber, readingOrder } from "./layout";
import { type TextPage, countCharacters, extractDocumentText, extractPageText } from "./pdfText";
import { type SlideInput, buildPptx } from "./pptxBuilder";
import { type Cell, type Sheet, buildXlsx } from "./xlsxBuilder";

export interface ConvertContext {
  onProgress?: (fraction: number, message?: string) => void;
  signal?: AbortSignal;
}

export interface Conversion {
  file: OutputFile;
  pages: number;
  /** What was converted and what was not, in plain language. */
  notes: string[];
}

/** Words for "this PDF has no text we can read", used by Word and Excel conversion. */
const NO_TEXT = "This PDF has no text that can be read, so there is nothing to convert. It is probably a scan or a set of pictures. This converter works from the text in the file and does not do text recognition (OCR).";

function requireText(pages: readonly TextPage[], fileName: string): void {
  if (countCharacters(pages) < 8) throw new AppError("UNSUPPORTED", NO_TEXT, { fileName });
}

/** Notes shared by the text-based conversions: pages without text, and text that could not be placed. */
function textNotes(pages: readonly TextPage[]): string[] {
  const notes: string[] = [];
  const empty = pages.filter((page) => page.items.length === 0).map((page) => page.pageNumber);
  if (empty.length > 0 && empty.length < pages.length) {
    notes.push(`${empty.length === 1 ? `Page ${empty[0]} has` : `Pages ${empty.length <= 8 ? empty.join(", ") : `${empty.slice(0, 8).join(", ")} and ${empty.length - 8} more`} have`} no text (pictures only), so ${empty.length === 1 ? "it is" : "they are"} empty in the result.`);
  }
  const skipped = pages.reduce((sum, page) => sum + page.skipped, 0);
  if (skipped > 0) notes.push(`${plural(skipped, "piece")} of vertical or diagonal text could not be placed and ${skipped === 1 ? "was" : "were"} left out.`);
  return notes;
}

const pageLines = (page: TextPage, segmentGap: number): Line[] => readingOrder(buildLines(page.items, { segmentGap }), page.width);

/** Entries a genuine Office file of each kind contains; a result without them is discarded. */
function verifyZip(bytes: Uint8Array, required: readonly (string | RegExp)[], label: string): Record<string, Uint8Array> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new AppError("VERIFICATION_FAILED", `The ${label} that was produced could not be opened again, so it was discarded.`);
  }
  for (const entry of required) {
    const found = typeof entry === "string" ? entry in entries : Object.keys(entries).some((name) => entry.test(name));
    if (!found) throw new AppError("VERIFICATION_FAILED", `The ${label} that was produced is incomplete, so it was discarded.`);
  }
  return entries;
}

const decode = (bytes: Uint8Array | undefined): string => (bytes ? new TextDecoder().decode(bytes) : "");

const REQUIRED_PARTS = { docx: "word/document.xml", pptx: "ppt/presentation.xml", xlsx: "xl/workbook.xml" } as const;

/**
 * Checks that bytes received from elsewhere (the server's LibreOffice) really are a Word, Excel or PowerPoint
 * file, so a failed conversion is reported as one instead of being offered as a download.
 */
export function checkOfficeFile(bytes: Uint8Array, kind: keyof typeof REQUIRED_PARTS, name: string): void {
  if (bytes.length < 100) throw new AppError("VERIFICATION_FAILED", `The converted file for “${name}” is empty, so it was discarded.`, { fileName: name });
  verifyZip(bytes, ["[Content_Types].xml", REQUIRED_PARTS[kind]], `${kind.toUpperCase()} file`);
}

// ---- Word ----------------------------------------------------------------------------------------------

/** Groups consecutive text blocks into paragraphs and leaves tables as they are. */
function contentOf(blocks: readonly Block[], page: TextPage, body: number, headings: readonly number[]): (Paragraph | TableBlock)[] {
  const content: (Paragraph | TableBlock)[] = [];
  const all = blocks.filter((block): block is Extract<Block, { type: "text" }> => block.type === "text").map((block) => block.line);
  const textLeft = all.length > 0 ? Math.min(...all.map(lineLeft)) : 0;
  const textRight = all.length > 0 ? Math.max(...all.map(lineRight)) : page.width;
  const geometry = { width: page.width, textLeft, textRight };
  let run: Line[] = [];
  const flush = () => {
    if (run.length > 0) content.push(...buildParagraphs(run, geometry, body, headings));
    run = [];
  };
  for (const block of blocks) {
    if (block.type === "text") {
      run.push(block.line);
    } else {
      flush();
      content.push(block);
    }
  }
  flush();
  return content;
}

export async function pdfToDocx(doc: PDFDocumentProxy, fileName: string, ctx: ConvertContext = {}): Promise<Conversion> {
  const pages = await extractDocumentText(doc, { signal: ctx.signal, onProgress: (fraction, message) => ctx.onProgress?.(fraction * 0.7, message) });
  requireText(pages, fileName);
  ctx.onProgress?.(0.72, "Arranging paragraphs");

  const ordered = pages.map((page) => pageLines(page, 1.2));
  const body = bodyFontSize(ordered.flat());
  const headings = headingSizes(ordered.flat(), body);
  const docxPages: DocxPage[] = pages.map((page, index) => {
    const blocks = findTables(ordered[index] as Line[], 8);
    const content = contentOf(blocks, page, body, headings);
    const lefts = (ordered[index] as Line[]).map(lineLeft);
    const rights = (ordered[index] as Line[]).map(lineRight);
    return { width: page.width, height: page.height, textLeft: lefts.length ? Math.min(...lefts) : 72, textRight: rights.length ? Math.max(...rights) : page.width - 72, content };
  });

  ctx.onProgress?.(0.85, "Writing the Word document");
  const bytes = await buildDocx(docxPages, { title: baseName(fileName), creator: BRAND.name });
  const entries = verifyZip(bytes, ["[Content_Types].xml", "word/document.xml"], "Word document");
  const written = decode(entries["word/document.xml"]).replace(/<[^>]+>/g, "").length;
  if (written < countCharacters(pages) * 0.5) throw new AppError("VERIFICATION_FAILED", "The Word document that was produced is missing most of the text, so it was discarded.");

  const tables = docxPages.reduce((sum, page) => sum + page.content.filter((block) => "type" in block).length, 0);
  const notes = [
    "Text, headings, lists, columns and simple tables were rebuilt from the positions of the text. Complicated layouts, pictures, shapes and exact fonts are not carried over.",
    ...(tables > 0 ? [`${plural(tables, "table")} ${tables === 1 ? "was" : "were"} detected. Check ${tables === 1 ? "it" : "them"} against the PDF.`] : []),
    ...textNotes(pages),
  ];
  ctx.onProgress?.(1);
  return { file: { name: `${baseName(fileName)}.docx`, bytes, mime: MIME.docx }, pages: pages.length, notes };
}

// ---- Excel ---------------------------------------------------------------------------------------------

export interface XlsxOptions {
  /** One sheet per PDF page, or everything on one sheet. */
  layout: "per-page" | "single";
  /** Store numbers that are clearly numbers as numbers instead of text. */
  numbers: boolean;
}

function cellOf(text: string, numbers: boolean, bold = false): Cell {
  const parsed = numbers ? parseNumber(text) : null;
  return parsed ? { value: parsed.value, format: parsed.format, bold } : { value: text, bold };
}

export async function pdfToXlsx(doc: PDFDocumentProxy, fileName: string, options: XlsxOptions, ctx: ConvertContext = {}): Promise<Conversion> {
  const pages = await extractDocumentText(doc, { signal: ctx.signal, onProgress: (fraction, message) => ctx.onProgress?.(fraction * 0.7, message) });
  requireText(pages, fileName);
  ctx.onProgress?.(0.72, "Finding tables");

  let tables = 0;
  const sheets: Sheet[] = [];
  pages.forEach((page, index) => {
    const rows: Cell[][] = [];
    for (const block of findTables(pageLines(page, 0.8), 6)) {
      if (block.type === "text") {
        rows.push([cellOf(lineText(block.line, " "), false, block.line.segments.every((segment) => segment.bold))]);
      } else {
        tables += 1;
        block.rows.forEach((cells, rowIndex) => rows.push(cells.map((text) => cellOf(text, options.numbers && !(rowIndex === 0 && block.headerBold), rowIndex === 0 && block.headerBold))));
      }
    }
    if (options.layout === "single") {
      const sheet = sheets[0] ?? { name: baseName(fileName), rows: [] };
      if (sheets.length === 0) sheets.push(sheet);
      if (index > 0 && sheet.rows.length > 0 && rows.length > 0) sheet.rows.push([]);
      sheet.rows.push(...rows);
    } else {
      sheets.push({ name: `Page ${page.pageNumber}`, rows });
    }
  });

  ctx.onProgress?.(0.85, "Writing the spreadsheet");
  const bytes = await buildXlsx(sheets, { creator: BRAND.name });
  const entries = verifyZip(bytes, ["[Content_Types].xml", "xl/workbook.xml", /^xl\/worksheets\/sheet1\.xml$/], "spreadsheet");
  const sheetCount = Object.keys(entries).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).length;
  if (sheetCount !== Math.max(1, sheets.length)) throw new AppError("VERIFICATION_FAILED", "The spreadsheet that was produced does not have the expected sheets, so it was discarded.");

  const notes = [
    tables > 0 ? `${plural(tables, "table")} ${tables === 1 ? "was" : "were"} found from the way the text lines up in rows and columns. Check the cells against the PDF.` : "No tables were found. Each line of text is in its own row, in column A.",
    ...(options.numbers ? ["Numbers that are clearly numbers (such as 1,234.50, 12% or $9.99) are stored as numbers; codes with leading zeros, dates and anything ambiguous stay text."] : []),
    ...textNotes(pages),
  ];
  ctx.onProgress?.(1);
  return { file: { name: `${baseName(fileName)}.xlsx`, bytes, mime: MIME.xlsx }, pages: pages.length, notes };
}

// ---- PowerPoint ----------------------------------------------------------------------------------------

/** Draws a page to a JPEG. In the browser this uses pdf.js and a canvas. */
export type PageRenderer = (pageNumber: number) => Promise<{ jpeg: Uint8Array; width: number; height: number }>;

export async function pdfToPptx(doc: PDFDocumentProxy, fileName: string, render: PageRenderer, ctx: ConvertContext = {}): Promise<Conversion> {
  const slides: SlideInput[] = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    if (ctx.signal?.aborted) throw new AppError("CANCELLED", "The operation was cancelled.");
    ctx.onProgress?.(((number - 1) / doc.numPages) * 0.85, `Drawing page ${number} of ${doc.numPages}`);
    const picture = await render(number);
    const notes = pageLines(await extractPageText(doc, number), 1.2)
      .map((line) => lineText(line, "  "))
      .join("\n");
    slides.push({ ...picture, notes });
  }

  ctx.onProgress?.(0.9, "Writing the presentation");
  const bytes = await buildPptx(slides, { title: baseName(fileName), author: BRAND.name });
  const entries = verifyZip(bytes, ["[Content_Types].xml", "ppt/presentation.xml"], "presentation");
  const slideCount = Object.keys(entries).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length;
  if (slideCount !== slides.length) throw new AppError("VERIFICATION_FAILED", `The presentation has ${plural(slideCount, "slide")} instead of ${slides.length}, so it was discarded.`);
  ctx.onProgress?.(1);
  return {
    file: { name: `${baseName(fileName)}.pptx`, bytes, mime: MIME.pptx },
    pages: slides.length,
    notes: ["Each slide holds a picture of one page, so it looks exactly like the PDF, but the text cannot be edited. The text of each page is in the slide's notes, where it can be searched and copied."],
  };
}
