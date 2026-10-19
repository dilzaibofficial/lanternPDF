import { PDFName } from "@cantoo/pdf-lib";
import { AppError } from "../errors";
import { baseName } from "../format";
import { finishEdit, loadForEdit, selectedPages } from "./document";
import { displayRectToUser, frameOf } from "./draw";
import { type JobContext, type OutputFile, type PdfInput, reportProgress } from "./types";

export interface CropMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface CropOptions {
  /** How much to remove from each edge of the page *as displayed*. */
  margins: CropMargins;
  /** `pt` = PDF points (1/72 inch); `percent` = a share of each page's own width and height. */
  unit: "pt" | "percent";
  /** 1-based pages, or `null` for all. */
  pages: readonly number[] | null;
}

/** The smallest page a crop may leave, so the result is still usable. */
const MIN_SIDE_PT = 10;

function validate(options: CropOptions): void {
  const values = Object.values(options.margins);
  if (!values.every((v) => Number.isFinite(v) && v >= 0)) {
    throw new AppError("INVALID_INPUT", "Crop margins must be numbers that are zero or more.");
  }
  if (values.every((v) => v === 0)) {
    throw new AppError("INVALID_INPUT", "All the margins are zero, so nothing would be cropped. Drag the crop box or enter a margin.");
  }
  if (options.unit === "percent" && (options.margins.left + options.margins.right >= 100 || options.margins.top + options.margins.bottom >= 100)) {
    throw new AppError("INVALID_INPUT", "The margins add up to the whole page. Leave some of it.");
  }
}

/**
 * Crops pages by setting their visible area (CropBox and MediaBox). Content outside the new area is
 * hidden, not deleted: the file still contains it. The margins are applied to the page as it is
 * displayed, so rotated pages crop the way they look.
 */
export async function cropPdf(input: PdfInput, options: CropOptions, ctx?: JobContext): Promise<OutputFile> {
  validate(options);
  reportProgress(ctx, 0.05, "Opening the PDF");
  const doc = await loadForEdit(input);
  const pages = doc.getPages();
  const targets = selectedPages(pages.length, options.pages);

  for (const [index, pageNumber] of targets.entries()) {
    const page = pages[pageNumber - 1];
    if (!page) continue;
    const frame = frameOf(page);
    const scaleX = options.unit === "percent" ? frame.displayWidth / 100 : 1;
    const scaleY = options.unit === "percent" ? frame.displayHeight / 100 : 1;
    const left = options.margins.left * scaleX;
    const right = options.margins.right * scaleX;
    const top = options.margins.top * scaleY;
    const bottom = options.margins.bottom * scaleY;

    const keep = { x: left, y: bottom, width: frame.displayWidth - left - right, height: frame.displayHeight - top - bottom };
    if (keep.width < MIN_SIDE_PT || keep.height < MIN_SIDE_PT) {
      throw new AppError("INVALID_INPUT", `Cropping would leave almost nothing of page ${pageNumber}. Use smaller margins.`);
    }

    const box = displayRectToUser(frame, keep);
    page.setCropBox(box.x, box.y, box.width, box.height);
    page.setMediaBox(box.x, box.y, box.width, box.height);
    // Other boxes could now stick out of the page; drop them so every viewer agrees on the visible area.
    for (const name of ["TrimBox", "BleedBox", "ArtBox"]) page.node.delete(PDFName.of(name));
    if (index % 20 === 0) reportProgress(ctx, 0.1 + (index / targets.length) * 0.8, `Cropping page ${pageNumber}`);
  }

  reportProgress(ctx, 0.92, "Saving and checking the result");
  const result = await finishEdit(doc, `${baseName(input.name)}_cropped.pdf`, pages.length);
  reportProgress(ctx, 1);
  return result;
}
