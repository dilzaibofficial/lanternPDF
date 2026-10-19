import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

/** A PDF whose page N shows the text "<label> p<N>", so tests can tell pages apart after any operation. */
export async function makeTextPdf(label: string, pages: number, size: readonly [number, number] = [300, 200]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i += 1) {
    doc.addPage([size[0], size[1]]).drawText(`${label} p${i}`, { x: 20, y: size[1] / 2, size: 24, font });
  }
  return doc.save();
}

/** A PDF whose pages are filled with the given RGB colours (0-255), for pixel-level checks. */
export async function makeColorPdf(colors: readonly (readonly [number, number, number])[], size: readonly [number, number] = [200, 100]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const [r, g, b] of colors) {
    const page = doc.addPage([size[0], size[1]]);
    page.drawRectangle({ x: 0, y: 0, width: size[0], height: size[1], color: rgb(r / 255, g / 255, b / 255) });
  }
  return doc.save();
}

/** The visible text of every page, via pdf.js (an independent reader from the one that wrote the file). */
export async function pageTexts(bytes: Uint8Array, password?: string): Promise<string[]> {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, password });
  try {
    const doc = await task.promise;
    const texts: string[] = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      texts.push(
        content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
      );
      page.cleanup();
    }
    return texts;
  } finally {
    await task.destroy();
  }
}

export interface PageGeometry {
  width: number;
  height: number;
  rotation: number;
}

export async function pageGeometry(bytes: Uint8Array): Promise<PageGeometry[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => ({
    width: Math.round(page.getWidth()),
    height: Math.round(page.getHeight()),
    rotation: page.getRotation().angle,
  }));
}

export const pdfHeader = (bytes: Uint8Array): string => new TextDecoder().decode(bytes.slice(0, 8));
