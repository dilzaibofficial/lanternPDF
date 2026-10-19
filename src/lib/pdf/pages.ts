import { PDFDocument } from "@cantoo/pdf-lib";
import { AppError } from "../errors";
import { baseName, plural } from "../format";
import { type PageRange, expandRanges, formatPageList } from "../ranges";
import { countPagesIn } from "./inspect";
import { type QpdfSession, passwordArg, runChecked, withQpdf } from "./qpdf";
import { type JobContext, MIME, type OutputFile, type PdfInput, type Rotation, reportProgress } from "./types";

/**
 * Structural page operations, implemented with qpdf. qpdf keeps annotations, links, form fields,
 * page labels and metadata intact and recovers from many kinds of damage, which is why it does the
 * page-level work. (Drawing on pages is done with pdf-lib, see watermark.ts and friends.)
 *
 * Every operation re-opens its own output and checks the page count before returning, so a result
 * is only ever offered when it has been verified.
 */

/** Reads a finished output back and confirms it has exactly the expected number of pages. */
function verified(qpdf: QpdfSession, path: string, expectedPages: number, name: string): OutputFile {
  const bytes = qpdf.read(path);
  let actual: number;
  try {
    actual = countPagesIn(qpdf, path, undefined, name);
  } catch (error) {
    throw new AppError("VERIFICATION_FAILED", `The result "${name}" could not be re-opened, so it was discarded.`, {
      details: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  }
  if (actual !== expectedPages) {
    throw new AppError(
      "VERIFICATION_FAILED",
      `The result "${name}" has ${plural(actual, "page")} instead of the expected ${expectedPages}, so it was discarded.`,
    );
  }
  // Copy out of the WASM heap: the session is freed when the job ends.
  return { name, bytes: bytes.slice(), mime: MIME.pdf, pageCount: actual };
}

function requireInputs(inputs: readonly PdfInput[], minimum: number, what: string): void {
  if (inputs.length < minimum) {
    throw new AppError("INVALID_INPUT", what);
  }
}

// ---------------------------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------------------------

export async function mergePdfs(inputs: readonly PdfInput[], ctx?: JobContext): Promise<OutputFile> {
  requireInputs(inputs, 2, "Add at least two PDF files to merge.");
  return withQpdf((qpdf) => {
    const sources: { path: string; password?: string; pages: number; name: string }[] = [];
    inputs.forEach((input, index) => {
      reportProgress(ctx, (index / inputs.length) * 0.4, `Reading ${input.name}`);
      const path = qpdf.put(input.bytes);
      const pages = countPagesIn(qpdf, path, input.password, input.name);
      if (pages < 1) throw new AppError("INVALID_FILE", `"${input.name}" has no pages.`, { fileName: input.name });
      sources.push({ path, password: input.password, pages, name: input.name });
    });

    reportProgress(ctx, 0.5, "Combining pages");
    const out = qpdf.path();
    const pagesArgs = sources.flatMap((s) => [s.path, ...passwordArg(s.password), "1-z"]);
    runChecked(qpdf, ["--empty", "--pages", ...pagesArgs, "--", out]);

    reportProgress(ctx, 0.9, "Checking the result");
    const expected = sources.reduce((sum, s) => sum + s.pages, 0);
    const result = verified(qpdf, out, expected, "merged.pdf");
    reportProgress(ctx, 1);
    return result;
  });
}

// ---------------------------------------------------------------------------------------------
// Select pages (extract, delete, reorder, duplicate)
// ---------------------------------------------------------------------------------------------

export interface SelectPagesOptions {
  /** 1-based page numbers in the order they should appear. Repeats are allowed. */
  pages: readonly number[];
  outputName?: string;
}

export async function selectPages(input: PdfInput, options: SelectPagesOptions, ctx?: JobContext): Promise<OutputFile> {
  if (options.pages.length === 0) {
    throw new AppError("INVALID_INPUT", "No pages are selected, so there would be nothing left in the new PDF.");
  }
  return withQpdf((qpdf) => {
    reportProgress(ctx, 0.1, "Reading the PDF");
    const path = qpdf.put(input.bytes);
    const total = countPagesIn(qpdf, path, input.password, input.name);
    for (const page of options.pages) {
      if (!Number.isInteger(page) || page < 1 || page > total) {
        throw new AppError("INVALID_INPUT", `Page ${page} is out of range: this document has ${plural(total, "page")}.`);
      }
    }

    reportProgress(ctx, 0.4, "Building the new PDF");
    const out = qpdf.path();
    runChecked(
      qpdf,
      [
        ...passwordArg(input.password),
        // The user authenticated, so the output is not password-protected (the UI says so).
        ...(input.password ? ["--decrypt"] : []),
        path,
        "--pages",
        ".",
        formatPageList(options.pages),
        "--",
        out,
      ],
      { fileName: input.name, passwordSupplied: Boolean(input.password) },
    );

    reportProgress(ctx, 0.9, "Checking the result");
    const result = verified(qpdf, out, options.pages.length, options.outputName ?? `${baseName(input.name)}_pages.pdf`);
    reportProgress(ctx, 1);
    return result;
  });
}

// ---------------------------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------------------------

export type SplitPlan =
  /** One file per range, or all ranges combined into one file when `mergeAll` is true. */
  | { mode: "ranges"; ranges: readonly PageRange[]; mergeAll?: boolean }
  /** A new file every `n` pages. */
  | { mode: "every"; n: number };

const rangeLabel = (r: PageRange): string => (r.start === r.end ? `page-${r.start}` : `pages-${r.start}-${r.end}`);

export async function splitPdf(input: PdfInput, plan: SplitPlan, ctx?: JobContext): Promise<OutputFile[]> {
  return withQpdf((qpdf) => {
    reportProgress(ctx, 0.05, "Reading the PDF");
    const path = qpdf.put(input.bytes);
    const total = countPagesIn(qpdf, path, input.password, input.name);
    const stem = baseName(input.name);
    const common = [...passwordArg(input.password), ...(input.password ? ["--decrypt"] : [])];
    const context = { fileName: input.name, passwordSupplied: Boolean(input.password) };
    const outputs: OutputFile[] = [];

    if (plan.mode === "every") {
      if (!Number.isInteger(plan.n) || plan.n < 1) {
        throw new AppError("INVALID_INPUT", "Enter a whole number of pages per file, such as 2.");
      }
      if (plan.n >= total) {
        throw new AppError(
          "INVALID_INPUT",
          `This document has only ${plural(total, "page")}, so splitting every ${plan.n} would not produce more than one file.`,
        );
      }
      reportProgress(ctx, 0.3, "Splitting");
      runChecked(qpdf, [...common, path, `--split-pages=${plan.n}`, "/part.pdf"], context);
      // qpdf names parts like part-1-2.pdf, part-3-4.pdf (zero-padded for large documents).
      const parts = qpdf
        .list()
        .map((name) => ({ name, match: /^part-(\d+)(?:-(\d+))?\.pdf$/.exec(name) }))
        .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
        .map((entry) => ({
          fileName: entry.name,
          start: Number.parseInt(entry.match[1] as string, 10),
          end: Number.parseInt((entry.match[2] ?? entry.match[1]) as string, 10),
        }))
        .sort((a, b) => a.start - b.start);

      const expectedParts = Math.ceil(total / plan.n);
      if (parts.length !== expectedParts) {
        throw new AppError(
          "VERIFICATION_FAILED",
          `Expected ${expectedParts} files but the engine produced ${parts.length}, so the split was discarded.`,
        );
      }
      parts.forEach((part, index) => {
        reportProgress(ctx, 0.5 + (index / parts.length) * 0.45, `Checking part ${index + 1} of ${parts.length}`);
        outputs.push(verified(qpdf, `/${part.fileName}`, part.end - part.start + 1, `${stem}_${rangeLabel(part)}.pdf`));
      });
      reportProgress(ctx, 1);
      return outputs;
    }

    // plan.mode === "ranges"
    if (plan.ranges.length === 0) {
      throw new AppError("INVALID_INPUT", "Enter at least one page range, for example 1-3.");
    }
    for (const range of plan.ranges) {
      if (range.start < 1 || range.end > total || range.start > range.end) {
        throw new AppError("INVALID_INPUT", `Pages ${range.start}-${range.end} are not valid for a ${plural(total, "page")} document.`);
      }
    }

    if (plan.mergeAll) {
      reportProgress(ctx, 0.3, "Building the new PDF");
      const out = qpdf.path();
      const pages = expandRanges(plan.ranges);
      runChecked(qpdf, [...common, path, "--pages", ".", formatPageList(pages), "--", out], context);
      outputs.push(verified(qpdf, out, pages.length, `${stem}_extracted.pdf`));
      reportProgress(ctx, 1);
      return outputs;
    }

    plan.ranges.forEach((range, index) => {
      reportProgress(ctx, 0.1 + (index / plan.ranges.length) * 0.8, `Creating file ${index + 1} of ${plan.ranges.length}`);
      const out = qpdf.path();
      runChecked(qpdf, [...common, path, "--pages", ".", `${range.start}-${range.end}`, "--", out], context);
      outputs.push(verified(qpdf, out, range.end - range.start + 1, `${stem}_${rangeLabel(range)}.pdf`));
    });
    reportProgress(ctx, 1);
    return outputs;
  });
}

// ---------------------------------------------------------------------------------------------
// Arrange (organize): reorder, rotate, delete, duplicate, insert blank pages, mix several files
// ---------------------------------------------------------------------------------------------

export type PageItem =
  | { kind: "page"; source: number; page: number; rotate: Rotation }
  | { kind: "blank"; width: number; height: number; rotate: Rotation };

export interface ArrangeOptions {
  outputName?: string;
}

/** qpdf arguments needed to rotate output pages: one `--rotate=+angle:positions` per angle. */
function rotationArgs(items: readonly PageItem[]): string[] {
  const byAngle = new Map<number, number[]>();
  items.forEach((item, index) => {
    if (item.rotate === 0) return;
    const list = byAngle.get(item.rotate) ?? [];
    list.push(index + 1);
    byAngle.set(item.rotate, list);
  });
  return [...byAngle.entries()].map(([angle, positions]) => `--rotate=+${angle}:${formatPageList(positions)}`);
}

export async function arrangePages(
  sources: readonly PdfInput[],
  items: readonly PageItem[],
  options: ArrangeOptions = {},
  ctx?: JobContext,
): Promise<OutputFile> {
  if (items.length === 0) {
    throw new AppError("INVALID_INPUT", "There are no pages left, so there would be nothing to save.");
  }
  const name = options.outputName ?? `${baseName(sources[0]?.name ?? "document")}_organized.pdf`;

  // A single source with no blank pages keeps the document's own metadata, bookmarks and so on.
  const singleSource = sources.length === 1 && items.every((item) => item.kind === "page" && item.source === 0);

  return withQpdf(async (qpdf) => {
    reportProgress(ctx, 0.05, "Reading the PDFs");
    const sourcePaths: { path: string; password?: string; pages: number; name: string }[] = [];
    sources.forEach((input, index) => {
      const path = qpdf.put(input.bytes);
      const pages = countPagesIn(qpdf, path, input.password, input.name);
      sourcePaths.push({ path, password: input.password, pages, name: input.name });
      reportProgress(ctx, 0.05 + ((index + 1) / sources.length) * 0.25);
    });

    // Blank pages live in a small helper PDF that is treated like any other source.
    const blanks = items.filter((item): item is Extract<PageItem, { kind: "blank" }> => item.kind === "blank");
    let blankPath: string | null = null;
    if (blanks.length > 0) {
      const doc = await PDFDocument.create();
      for (const blank of blanks) doc.addPage([blank.width, blank.height]);
      blankPath = qpdf.put(await doc.save());
    }

    // Group consecutive items that come from the same file so qpdf gets a short argument list.
    const groups: { path: string; password?: string; pages: number[] }[] = [];
    let blankIndex = 0;
    for (const item of items) {
      let path: string;
      let password: string | undefined;
      let page: number;
      if (item.kind === "blank") {
        path = blankPath as string;
        page = (blankIndex += 1);
      } else {
        const source = sourcePaths[item.source];
        if (!source) throw new AppError("INVALID_INPUT", "A page refers to a file that is no longer loaded.");
        if (!Number.isInteger(item.page) || item.page < 1 || item.page > source.pages) {
          throw new AppError("INVALID_INPUT", `Page ${item.page} does not exist in "${source.name}" (${plural(source.pages, "page")}).`);
        }
        path = source.path;
        password = source.password;
        page = item.page;
      }
      const last = groups[groups.length - 1];
      if (last && last.path === path) last.pages.push(page);
      else groups.push({ path, password, pages: [page] });
    }

    reportProgress(ctx, 0.45, "Building the new PDF");
    const out = qpdf.path();
    const args: string[] = [];
    if (singleSource) {
      const only = sourcePaths[0] as { path: string };
      // The user authenticated, so the output is not password-protected (the UI says so).
      args.push(...passwordArg(sources[0]?.password), ...(sources[0]?.password ? ["--decrypt"] : []), only.path);
      args.push("--pages", ".", formatPageList(groups.flatMap((g) => g.pages)));
    } else {
      args.push("--empty", "--pages");
      for (const group of groups) args.push(group.path, ...passwordArg(group.password), formatPageList(group.pages));
    }
    args.push("--", ...rotationArgs(items), out);
    runChecked(qpdf, args, { passwordSupplied: sources.some((s) => Boolean(s.password)) });

    reportProgress(ctx, 0.9, "Checking the result");
    const result = verified(qpdf, out, items.length, name);
    reportProgress(ctx, 1);
    return result;
  });
}

// ---------------------------------------------------------------------------------------------
// Rotate
// ---------------------------------------------------------------------------------------------

export interface RotateOptions {
  /** Clockwise degrees added to each selected page's current rotation. */
  angle: 90 | 180 | 270;
  /** 1-based pages to rotate; `null` rotates every page. */
  pages: readonly number[] | null;
  outputName?: string;
}

export async function rotatePdf(input: PdfInput, options: RotateOptions, ctx?: JobContext): Promise<OutputFile> {
  return withQpdf((qpdf) => {
    reportProgress(ctx, 0.1, "Reading the PDF");
    const path = qpdf.put(input.bytes);
    const total = countPagesIn(qpdf, path, input.password, input.name);
    if (options.pages && options.pages.length === 0) {
      throw new AppError("INVALID_INPUT", "Select at least one page to rotate.");
    }
    for (const page of options.pages ?? []) {
      if (!Number.isInteger(page) || page < 1 || page > total) {
        throw new AppError("INVALID_INPUT", `Page ${page} is out of range: this document has ${plural(total, "page")}.`);
      }
    }
    reportProgress(ctx, 0.4, "Rotating");
    const out = qpdf.path();
    const target = options.pages ? formatPageList([...options.pages].sort((a, b) => a - b)) : "1-z";
    runChecked(
      qpdf,
      [
        ...passwordArg(input.password),
        ...(input.password ? ["--decrypt"] : []),
        `--rotate=+${options.angle}:${target}`,
        path,
        out,
      ],
      { fileName: input.name, passwordSupplied: Boolean(input.password) },
    );
    reportProgress(ctx, 0.9, "Checking the result");
    const result = verified(qpdf, out, total, options.outputName ?? `${baseName(input.name)}_rotated.pdf`);
    reportProgress(ctx, 1);
    return result;
  });
}
