import { PDFDocument } from "@cantoo/pdf-lib";
import { AppError } from "../errors";
import { plural } from "../format";

/** Re-opens finished output and checks it has the expected number of pages. Throws VERIFICATION_FAILED otherwise. */
export async function verifyPdf(bytes: Uint8Array, expectedPages: number, name: string): Promise<number> {
  try {
    const reopened = await PDFDocument.load(bytes, { updateMetadata: false });
    const pages = reopened.getPageCount();
    if (pages !== expectedPages) {
      throw new AppError("VERIFICATION_FAILED", `The result “${name}” has ${plural(pages, "page")} instead of ${expectedPages}, so it was discarded.`);
    }
    return pages;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("VERIFICATION_FAILED", `The result “${name}” could not be re-opened, so it was discarded.`, { cause: error });
  }
}
