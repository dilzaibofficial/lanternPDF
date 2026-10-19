import { AppError } from "../errors";
import { MAX_IMAGE_SIDE } from "./pdfToImages";
import { type PdfSource, acquireDocument, renderPageToBlob } from "./pdfjs";
import type { PageImage } from "./assemble";
import { type JobContext, reportProgress } from "./types";

export interface FlattenOptions {
  /** Resolution of the page pictures. */
  dpi: number;
  /** JPEG quality, 0 to 1. */
  quality: number;
  signal?: AbortSignal;
}

/** The "convert pages to pictures" setting: small, readable on screen, no longer text. */
export const FLATTEN_SETTINGS = { dpi: 110, quality: 0.6 } as const;

/**
 * Renders every page to a JPEG with pdf.js, remembering each page's size in points. This runs on the
 * page (it needs real canvases); the pictures are then assembled into a PDF in the background worker.
 */
export async function renderPagesAsJpeg(source: PdfSource, options: FlattenOptions, ctx?: JobContext): Promise<PageImage[]> {
  const lease = acquireDocument(source);
  try {
    const doc = await lease.promise;
    const pages: PageImage[] = [];
    for (let number = 1; number <= doc.numPages; number += 1) {
      if (options.signal?.aborted) throw new AppError("CANCELLED", "The operation was cancelled.");
      reportProgress(ctx, (number - 1) / doc.numPages, `Rendering page ${number} of ${doc.numPages}`);
      const page = await doc.getPage(number);
      const view = page.getViewport({ scale: 1 }); // in points, with the page's own rotation applied
      // Very large pages are rendered at a lower resolution so the canvas stays within what browsers allow.
      const dpi = Math.min(options.dpi, (MAX_IMAGE_SIDE / Math.max(view.width, view.height)) * 72);
      const blob = await renderPageToBlob(page, { dpi, format: "jpeg", quality: options.quality, signal: options.signal });
      page.cleanup();
      const jpeg = new Uint8Array(await blob.arrayBuffer());
      if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
        throw new AppError("VERIFICATION_FAILED", `Page ${number} could not be turned into a picture, so nothing was produced.`);
      }
      pages.push({ jpeg, width: view.width, height: view.height });
    }
    return pages;
  } finally {
    lease.release();
  }
}
