import { PDFDocument } from "@cantoo/pdf-lib";
import { AppError } from "../errors";
import { baseName } from "../format";
import { countPagesIn } from "./inspect";
import { classifyQpdfFailure, passwordArg, withQpdf } from "./qpdf";
import { type JobContext, MIME, type OutputFile, type PdfInput, reportProgress } from "./types";

export interface RepairResult {
  file: OutputFile;
  /** What was found and done, in plain language. Empty when the file was already sound. */
  notes: string[];
  /** How the file was rebuilt. */
  method: "rewrite" | "rebuild";
}

/**
 * Repairs a damaged PDF.
 *
 * 1. If qpdf can already read the file, it is simply rewritten (cleaning up minor problems).
 * 2. Otherwise pdf-lib's parser, which scans for objects instead of trusting the cross-reference
 *    table, loads whatever it can find and the document is saved again with a fresh index.
 *    (The qpdf build we ship does not attempt its own recovery, so this fallback does the real work.)
 *
 * Either way the output is re-opened with qpdf and must have a page. What cannot be recovered
 * (content that is physically missing from a truncated file) stays missing, which the notes say.
 */
export async function repairPdf(input: PdfInput, ctx?: JobContext): Promise<RepairResult> {
  reportProgress(ctx, 0.05, "Analysing the PDF");
  const label = baseName(input.name);

  const rewritten = await withQpdf((qpdf) => {
    const path = qpdf.put(input.bytes);
    const out = qpdf.path();
    const result = qpdf.run([...passwordArg(input.password), ...(input.password ? ["--decrypt"] : []), path, out]);
    if (result.code === 0 || result.code === 3) {
      const pages = countPagesIn(qpdf, out, undefined, input.name);
      return {
        ok: true as const,
        pages,
        bytes: qpdf.read(out).slice(),
        warnings: result.code === 3 ? result.output.map((l) => l.trim()).filter(Boolean) : [],
      };
    }
    return { ok: false as const, failure: classifyQpdfFailure(result.output, { fileName: input.name, passwordSupplied: Boolean(input.password) }) };
  });

  if (rewritten.ok) {
    reportProgress(ctx, 1);
    if (rewritten.pages < 1) throw new AppError("DAMAGED_PDF", "No pages could be found in this file.", { fileName: input.name });
    return {
      file: { name: `${label}_repaired.pdf`, bytes: rewritten.bytes, mime: MIME.pdf, pageCount: rewritten.pages },
      method: "rewrite",
      notes:
        rewritten.warnings.length > 0
          ? ["The file had minor structural problems that were corrected.", ...rewritten.warnings]
          : ["No structural problems were found; the file was rewritten cleanly."],
    };
  }

  // Passwords are a different problem from damage: pdf-lib cannot read encrypted data.
  if (rewritten.failure.code !== "DAMAGED_PDF" && rewritten.failure.code !== "ENGINE_FAILED") throw rewritten.failure;

  reportProgress(ctx, 0.4, "Rebuilding the file's index");
  let rebuilt: Uint8Array;
  try {
    const doc = await PDFDocument.load(input.bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
    if (doc.getPageCount() < 1) throw new Error("no pages found");
    rebuilt = await doc.save();
  } catch (error) {
    throw new AppError(
      "DAMAGED_PDF",
      `"${input.name}" is too damaged to recover: its page structure could not be found.`,
      { fileName: input.name, details: error instanceof Error ? error.message : String(error), cause: error },
    );
  }

  reportProgress(ctx, 0.8, "Checking the result");
  const checked = await withQpdf((qpdf) => {
    const path = qpdf.put(rebuilt);
    try {
      return { pages: countPagesIn(qpdf, path, undefined, input.name) };
    } catch (error) {
      return { error };
    }
  });
  if ("error" in checked || checked.pages < 1) {
    throw new AppError("VERIFICATION_FAILED", "The rebuilt file did not pass validation, so it was discarded.", {
      fileName: input.name,
    });
  }

  reportProgress(ctx, 1);
  return {
    file: { name: `${label}_repaired.pdf`, bytes: rebuilt, mime: MIME.pdf, pageCount: checked.pages },
    method: "rebuild",
    notes: [
      "The file's internal index was damaged. It was rebuilt by scanning the file for its pages.",
      `${checked.pages} ${checked.pages === 1 ? "page was" : "pages were"} recovered. Content that is missing from the original file cannot be restored, so check the result.`,
    ],
  };
}
