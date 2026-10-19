import { PDFDocument } from "@cantoo/pdf-lib";
import { BRAND } from "../../config/brand";
import { AppError } from "../errors";
import { type JobContext, MIME, type OutputFile, reportProgress } from "./types";
import { verifyPdf } from "./verify";

/** One rendered page: the JPEG, and the size of the page it stands for in PDF points. */
export interface PageImage {
  jpeg: Uint8Array;
  width: number;
  height: number;
}

/**
 * Builds a PDF whose pages are pictures, each placed at the size of the page it was rendered from.
 * Used by "convert pages to pictures" compression, where text and vector art are flattened.
 */
export async function assemblePageImages(pages: readonly PageImage[], name: string, ctx?: JobContext): Promise<OutputFile> {
  if (pages.length === 0) throw new AppError("INVALID_INPUT", "There are no pages to assemble.");
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setProducer(BRAND.name);
  for (const [index, entry] of pages.entries()) {
    reportProgress(ctx, (index / pages.length) * 0.9, `Adding page ${index + 1} of ${pages.length}`);
    if (!(entry.width > 0 && entry.height > 0)) throw new AppError("INVALID_INPUT", `Page ${index + 1} has no size.`);
    const image = await doc.embedJpg(entry.jpeg);
    doc.addPage([entry.width, entry.height]).drawImage(image, { x: 0, y: 0, width: entry.width, height: entry.height });
  }
  reportProgress(ctx, 0.92, "Saving and checking the result");
  const bytes = await doc.save();
  const pageCount = await verifyPdf(bytes, pages.length, name);
  reportProgress(ctx, 1);
  return { name, bytes, mime: MIME.pdf, pageCount };
}
