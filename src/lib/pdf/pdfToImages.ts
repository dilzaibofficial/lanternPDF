import { AppError } from "../errors";
import { baseName } from "../format";
import { type PdfSource, acquireDocument, renderPageToBlob } from "./pdfjs";
import { type JobContext, MIME, type OutputFile, reportProgress } from "./types";

export interface PdfToImagesOptions {
  format: "jpeg" | "png";
  /** Output resolution in dots per inch (a PDF point is 1/72 inch). */
  dpi: number;
  /** JPEG quality, 0 to 1. */
  quality: number;
  /** 1-based pages to export, ascending. */
  pages: readonly number[];
  signal?: AbortSignal;
}

/** The longest side of an exported image. Larger pages are scaled down to stay renderable. */
export const MAX_IMAGE_SIDE = 8000;

export interface PdfToImagesResult {
  files: OutputFile[];
  /** Pages whose resolution had to be reduced to fit MAX_IMAGE_SIDE. */
  capped: number[];
}

const startsWith = (bytes: Uint8Array, signature: readonly number[]) => signature.every((byte, i) => bytes[i] === byte);

/**
 * Renders PDF pages to JPG or PNG files. This runs on the page (not in the background worker)
 * because it needs real canvases, but pdf.js does the heavy parsing in its own worker.
 */
export async function pdfToImages(source: PdfSource, options: PdfToImagesOptions, ctx?: JobContext): Promise<PdfToImagesResult> {
  if (options.pages.length === 0) throw new AppError("INVALID_INPUT", "Choose at least one page to convert.");
  const lease = acquireDocument(source);
  try {
    const doc = await lease.promise;
    const stem = baseName(source.name ?? "document");
    const digits = String(doc.numPages).length;
    const extension = options.format === "jpeg" ? "jpg" : "png";
    const files: OutputFile[] = [];
    const capped: number[] = [];

    for (const [index, pageNumber] of options.pages.entries()) {
      if (options.signal?.aborted) throw new AppError("CANCELLED", "The operation was cancelled.");
      reportProgress(ctx, index / options.pages.length, `Rendering page ${pageNumber} of ${doc.numPages}`);
      const page = await doc.getPage(pageNumber);

      // Keep the biggest side within MAX_IMAGE_SIDE, whatever the page size and requested dpi.
      const view = page.getViewport({ scale: 1 });
      const longest = Math.max(view.width, view.height) * (options.dpi / 72);
      let dpi = options.dpi;
      if (longest > MAX_IMAGE_SIDE) {
        dpi = (MAX_IMAGE_SIDE / Math.max(view.width, view.height)) * 72;
        capped.push(pageNumber);
      }

      const blob = await renderPageToBlob(page, { dpi, format: options.format, quality: options.quality, signal: options.signal });
      page.cleanup();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const valid = options.format === "jpeg" ? startsWith(bytes, [0xff, 0xd8, 0xff]) : startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]);
      if (bytes.length === 0 || !valid) {
        throw new AppError("VERIFICATION_FAILED", `Page ${pageNumber} could not be turned into an image, so nothing was produced.`);
      }
      files.push({
        name: `${stem}_page-${String(pageNumber).padStart(digits, "0")}.${extension}`,
        bytes,
        mime: options.format === "jpeg" ? MIME.jpeg : MIME.png,
      });
    }
    reportProgress(ctx, 1);
    return { files, capped };
  } finally {
    lease.release();
  }
}
