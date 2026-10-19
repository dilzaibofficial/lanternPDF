import { PDFDocument } from "@cantoo/pdf-lib";
import { BRAND } from "../../config/brand";
import { AppError } from "../errors";
import { plural } from "../format";
import { passwordArg, runChecked, withQpdf } from "./qpdf";
import { MIME, type OutputFile, type PdfInput } from "./types";
import { verifyPdf } from "./verify";

/**
 * Opens a PDF for editing with pdf-lib. Encrypted or unusual files are first rewritten by qpdf (which
 * decrypts with the supplied password and flattens the file structure), then loaded.
 */
export async function loadForEdit(input: PdfInput): Promise<PDFDocument> {
  if (!input.password) {
    try {
      return await PDFDocument.load(input.bytes, { updateMetadata: false });
    } catch {
      // Encrypted, or something pdf-lib's parser dislikes: let qpdf normalise it below.
    }
  }

  const normalized = await withQpdf((qpdf) => {
    const path = qpdf.put(input.bytes);
    const out = qpdf.path();
    runChecked(qpdf, [...passwordArg(input.password), "--decrypt", "--object-streams=disable", path, out], {
      fileName: input.name,
      passwordSupplied: Boolean(input.password),
    });
    return qpdf.read(out).slice();
  });

  try {
    return await PDFDocument.load(normalized, { updateMetadata: false });
  } catch (error) {
    throw new AppError("DAMAGED_PDF", `“${input.name}” could not be opened for editing. It may be damaged; try Repair PDF first.`, {
      fileName: input.name,
      details: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  }
}

/**
 * Saves, re-opens the result to verify it, and wraps it as an output file. By default the Producer and
 * modification date are stamped; the metadata editor turns that off because the user controls them.
 */
export async function finishEdit(doc: PDFDocument, name: string, expectedPages: number, options: { stamp?: boolean } = {}): Promise<OutputFile> {
  if (options.stamp !== false) {
    doc.setProducer(BRAND.name);
    doc.setModificationDate(new Date());
  }
  const bytes = await doc.save();
  const pageCount = await verifyPdf(bytes, expectedPages, name);
  return { name, bytes, mime: MIME.pdf, pageCount };
}

/** Validates a 1-based page list (or `null` for every page) and returns it ascending and without repeats. */
export function selectedPages(total: number, pages: readonly number[] | null): number[] {
  if (pages === null) return Array.from({ length: total }, (_, i) => i + 1);
  const unique = [...new Set(pages)].sort((a, b) => a - b);
  for (const page of unique) {
    if (!Number.isInteger(page) || page < 1 || page > total) {
      throw new AppError("INVALID_INPUT", `Page ${page} is out of range: this document has ${plural(total, "page")}.`);
    }
  }
  if (unique.length === 0) throw new AppError("INVALID_INPUT", "Choose at least one page.");
  return unique;
}
