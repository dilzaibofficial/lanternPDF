import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { AppError } from "../errors";
import type { FontKind, RawItem } from "./layout";

/** The text of one page, positioned as the page is displayed. */
export interface TextPage {
  pageNumber: number;
  /** Displayed page size in points. */
  width: number;
  height: number;
  items: RawItem[];
  /** Pieces of rotated or vertical text that cannot be placed in a flowing document. */
  skipped: number;
}

type Matrix = readonly [number, number, number, number, number, number];

/** Applies `m` first, then `n` (PDF's convention). */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
}

interface FontTrait {
  bold: boolean;
  italic: boolean;
  font: FontKind;
}

interface StyleInfo {
  fontFamily: string;
}

/**
 * Bold and italic are not part of the text content, but pdf.js knows them once the page's operators have
 * been read (that is when it loads the fonts). Reading them costs a little, so it is only done for pages
 * that have text at all.
 */
async function fontTraits(page: PDFPageProxy, styles: Record<string, StyleInfo>): Promise<Map<string, FontTrait>> {
  const traits = new Map<string, FontTrait>();
  try {
    await page.getOperatorList();
  } catch {
    // keep going with what the styles say
  }
  for (const [id, style] of Object.entries(styles)) {
    let bold = false;
    let italic = false;
    try {
      const font = page.commonObjs.get(id) as { bold?: boolean; black?: boolean; italic?: boolean } | undefined;
      bold = Boolean(font?.bold || font?.black);
      italic = Boolean(font?.italic);
    } catch {
      // not resolved: treat as regular
    }
    const family = style.fontFamily.toLowerCase();
    traits.set(id, { bold, italic, font: family.includes("mono") ? "mono" : family.includes("serif") && !family.includes("sans") ? "serif" : "sans" });
  }
  return traits;
}

const REGULAR: FontTrait = { bold: false, italic: false, font: "sans" };

export async function extractPageText(doc: PDFDocumentProxy, pageNumber: number): Promise<TextPage> {
  const page = await doc.getPage(pageNumber);
  try {
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const pieces = content.items.filter((item): item is Extract<(typeof content.items)[number], { str: string }> => "str" in item && item.str.trim() !== "");
    const traits = pieces.length > 0 ? await fontTraits(page, content.styles as Record<string, StyleInfo>) : new Map<string, FontTrait>();

    const items: RawItem[] = [];
    let skipped = 0;
    for (const piece of pieces) {
      const m = multiply(piece.transform as unknown as Matrix, viewport.transform as unknown as Matrix);
      if (Math.abs(Math.atan2(m[1], m[0])) > 0.35) {
        skipped += 1; // turned more than about 20 degrees: vertical or diagonal text
        continue;
      }
      const trait = traits.get(piece.fontName) ?? REGULAR;
      items.push({ text: piece.str, x: m[4], y: m[5], width: piece.width, fontSize: Math.hypot(m[0], m[1]), bold: trait.bold, italic: trait.italic, font: trait.font });
    }
    return { pageNumber, width: viewport.width, height: viewport.height, items, skipped };
  } finally {
    page.cleanup();
  }
}

export interface ExtractOptions {
  onProgress?: (fraction: number, message?: string) => void;
  signal?: AbortSignal;
}

/** Reads the text of every page. Throws CANCELLED when `signal` fires between pages. */
export async function extractDocumentText(doc: PDFDocumentProxy, options: ExtractOptions = {}): Promise<TextPage[]> {
  const pages: TextPage[] = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    if (options.signal?.aborted) throw new AppError("CANCELLED", "The operation was cancelled.");
    options.onProgress?.((number - 1) / doc.numPages, `Reading page ${number} of ${doc.numPages}`);
    pages.push(await extractPageText(doc, number));
  }
  return pages;
}

/** Total characters of text found, for telling scans (none) from real documents. */
export const countCharacters = (pages: readonly TextPage[]): number => pages.reduce((sum, page) => sum + page.items.reduce((inner, item) => inner + item.text.trim().length, 0), 0);
