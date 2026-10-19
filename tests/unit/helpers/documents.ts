import { PDFDocument, type PDFFont, type PDFPage, StandardFonts, degrees } from "@cantoo/pdf-lib";
import { strToU8, unzipSync, zipSync } from "fflate";
import { makeImage } from "./images";
import { drawPixels, photoPixels } from "./pdfImages";

/** Test documents with known content and layout, shared by the unit and browser tests. */

export const A4: [number, number] = [595, 842];

export interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
}

export async function fontsOf(doc: PDFDocument): Promise<Fonts> {
  return { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold), italic: await doc.embedFont(StandardFonts.HelveticaOblique) };
}

/** Draws text with its baseline `top` points below the top edge of the page. */
export function put(page: PDFPage, text: string, x: number, top: number, size: number, font: PDFFont, rotate = 0): void {
  page.drawText(text, { x, y: page.getHeight() - top, size, font, rotate: degrees(rotate) });
}

/** A report: title, centred subtitle, a heading, a three-line paragraph, a bullet list, and a second page. */
export async function makeReport(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const f = await fontsOf(doc);
  const one = doc.addPage(A4);
  put(one, "Annual Report", 72, 90, 26, f.bold);
  const subtitle = "Fiscal year 2025";
  put(one, subtitle, (595 - f.regular.widthOfTextAtSize(subtitle, 14)) / 2, 125, 14, f.regular);
  put(one, "Overview", 72, 170, 15, f.bold);
  put(one, "The company grew steadily during the year and expanded into three new", 72, 200, 11, f.regular);
  put(one, "markets while keeping costs under control. Customer satisfaction", 72, 214, 11, f.regular);
  put(one, "reached an all-time high in the autumn survey.", 72, 228, 11, f.regular);
  put(one, "• Revenue up 12%", 80, 262, 11, f.regular);
  put(one, "• Costs down 3%", 80, 276, 11, f.regular);
  put(one, "Looking ahead, we expect the trend to continue into the next period.", 72, 310, 11, f.regular);
  const two = doc.addPage(A4);
  put(two, "Details", 72, 90, 15, f.bold);
  put(two, "Second page text goes here with some more words in the line.", 72, 120, 11, f.regular);
  return doc.save();
}

export async function makeTwoColumns(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const f = await fontsOf(doc);
  const page = doc.addPage(A4);
  put(page, "A Two Column Article Title Spanning The Whole Page Width", 72, 90, 18, f.bold);
  for (let i = 0; i < 8; i += 1) {
    put(page, `Left column sentence number ${i + 1} flows`, 72, 140 + i * 14, 10, f.regular);
    put(page, `Right column sentence number ${i + 1} flows`, 320, 140 + i * 14, 10, f.regular);
  }
  return doc.save();
}

export async function makeTable(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const f = await fontsOf(doc);
  const page = doc.addPage(A4);
  put(page, "Price list", 72, 90, 16, f.bold);
  const columns = [72, 260, 380];
  const rows = [
    ["Item", "Qty", "Price"],
    ["Widget", "4", "$9.99"],
    ["Gadget with a long name", "1,200", "$129.50"],
    ["Gizmo", "12", "12%"],
    ["Part 007", "3", "(250)"],
  ];
  rows.forEach((cells, r) => cells.forEach((text, c) => put(page, text, columns[c] as number, 140 + r * 18, 11, r === 0 ? f.bold : f.regular)));
  put(page, "Prices exclude tax.", 72, 260, 10, f.italic);
  return doc.save();
}

/** One page that is only a picture: no text to read. */
export async function makeScan(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  page.drawImage(await doc.embedJpg(makeImage("jpeg", 400, 560, drawPixels(photoPixels(400, 560, 4)))), { x: 0, y: 0, width: 595, height: 842 });
  return doc.save();
}

/** Appends a comment after %%EOF that the test doubles for LibreOffice and Ghostscript react to. Readers ignore it. */
export const withMarker = (bytes: Uint8Array, marker: string): Uint8Array => new Uint8Array(Buffer.concat([bytes, Buffer.from(`\n%${marker}\n`)]));

// ---- Office files (just enough structure to pass the server's checks) ----------------------------------------

export const docx = (marker = ""): Uint8Array => zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8("<w/>"), "marker.txt": strToU8(marker) }, { level: 0 });
export const odt = (marker = ""): Uint8Array => zipSync({ mimetype: strToU8("application/vnd.oasis.opendocument.text"), "marker.txt": strToU8(marker) }, { level: 0 });
export const ole = (marker = ""): Uint8Array => new Uint8Array(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512), Buffer.from(marker)]));
export const csv = (marker = ""): Uint8Array => new Uint8Array(Buffer.from(`name,amount\nwidget,4\n${marker}\n`));

// ---- reading Office files back ------------------------------------------------------------------------------------

export const unzip = (bytes: Uint8Array): Record<string, Uint8Array> => unzipSync(bytes);
export const textOf = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);
const unescapeXml = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export interface DocxParagraph {
  text: string;
  xml: string;
}

/** The paragraphs of a .docx: their text (tabs as \t) and their raw XML, for checking styles. Table cells are included in order. */
export function docxParagraphs(bytes: Uint8Array): DocxParagraph[] {
  const xml = textOf(unzip(bytes)["word/document.xml"]);
  return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((match) => {
    const body = match[0];
    const parts = [...body.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>/g)].map((m) => (m[1] === undefined ? "\t" : unescapeXml(m[1])));
    return { text: parts.join(""), xml: body };
  });
}

export const nonEmpty = (paragraphs: DocxParagraph[]): string[] => paragraphs.map((p) => p.text).filter((t) => t !== "");

export async function sheetsOf(bytes: Uint8Array): Promise<{ name: string; rows: unknown[][]; numFmt: (row: number, col: number) => string | undefined }[]> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  return workbook.worksheets.map((sheet) => ({
    name: sheet.name,
    rows: Array.from({ length: sheet.rowCount }, (_, r) => Array.from({ length: Math.max(sheet.columnCount, 1) }, (_, c) => sheet.getRow(r + 1).getCell(c + 1).value as unknown)),
    numFmt: (row, col) => sheet.getRow(row).getCell(col).numFmt,
  }));
}
