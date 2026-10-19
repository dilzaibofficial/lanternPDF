import { AppError } from "./errors";

/** Inclusive, 1-based page range. `start > end` means "descending" (e.g. 5-2 is 5,4,3,2). */
export interface PageRange {
  start: number;
  end: number;
}

export interface ParseRangeOptions {
  /** Allow descending ranges such as "5-2". Default false. */
  allowDescending?: boolean;
  /** Allow the same page to be listed more than once. Default true. */
  allowOverlap?: boolean;
}

const KEYWORDS = new Set(["last", "end", "z"]);

function parsePageToken(token: string, pageCount: number, original: string): number {
  const lower = token.toLowerCase();
  if (KEYWORDS.has(lower)) return pageCount;
  if (!/^\d+$/.test(token)) {
    throw new AppError(
      "INVALID_INPUT",
      `"${original}" is not a valid page range. Use numbers like 1-3, 5, 8- (commas separate parts).`,
    );
  }
  const value = Number.parseInt(token, 10);
  if (value < 1) {
    throw new AppError("INVALID_INPUT", `Page numbers start at 1 (got ${value}).`);
  }
  if (value > pageCount) {
    throw new AppError(
      "INVALID_INPUT",
      `Page ${value} is out of range: this document has ${pageCount} ${pageCount === 1 ? "page" : "pages"}.`,
    );
  }
  return value;
}

/**
 * Parses "1-3, 5, 8-, last, odd, even" into ranges.
 *  - `8-` means page 8 through the last page; `-3` means pages 1 through 3
 *  - `last` / `end` mean the final page
 *  - `odd` / `even` expand to every odd / even page
 */
export function parsePageRanges(input: string, pageCount: number, options: ParseRangeOptions = {}): PageRange[] {
  const { allowDescending = false, allowOverlap = true } = options;
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new AppError("INVALID_INPUT", "The document has no pages.");
  }
  const text = input.trim();
  if (text === "") {
    throw new AppError("INVALID_INPUT", "Enter at least one page or page range, for example 1-3, 5.");
  }

  const ranges: PageRange[] = [];
  for (const raw of text.split(/[,;]+/)) {
    const part = raw.trim().replace(/\s+/g, "");
    if (part === "") continue;
    const lower = part.toLowerCase();

    if (lower === "odd" || lower === "even") {
      const first = lower === "odd" ? 1 : 2;
      for (let page = first; page <= pageCount; page += 2) ranges.push({ start: page, end: page });
      continue;
    }

    const dash = part.indexOf("-");
    if (dash === -1) {
      const page = parsePageToken(part, pageCount, part);
      ranges.push({ start: page, end: page });
      continue;
    }

    const left = part.slice(0, dash);
    const right = part.slice(dash + 1);
    if (right.includes("-")) {
      throw new AppError("INVALID_INPUT", `"${part}" is not a valid page range. Use one dash, like 3-7.`);
    }
    const start = left === "" ? 1 : parsePageToken(left, pageCount, part);
    const end = right === "" ? pageCount : parsePageToken(right, pageCount, part);
    if (start > end && !allowDescending) {
      throw new AppError("INVALID_INPUT", `"${part}" goes backwards. Write it as ${end}-${start}.`);
    }
    ranges.push({ start, end });
  }

  if (ranges.length === 0) {
    throw new AppError("INVALID_INPUT", "Enter at least one page or page range, for example 1-3, 5.");
  }

  if (!allowOverlap) {
    const seen = new Set<number>();
    for (const page of expandRanges(ranges)) {
      if (seen.has(page)) {
        throw new AppError("INVALID_INPUT", `Page ${page} appears in more than one range.`);
      }
      seen.add(page);
    }
  }
  return ranges;
}

/** Flattens ranges into the ordered list of page numbers they select. */
export function expandRanges(ranges: readonly PageRange[]): number[] {
  const pages: number[] = [];
  for (const { start, end } of ranges) {
    if (start <= end) for (let p = start; p <= end; p += 1) pages.push(p);
    else for (let p = start; p >= end; p -= 1) pages.push(p);
  }
  return pages;
}

/** Collapses an ordered page list into "1-3,5,7-9" (ascending runs only; keeps the given order). */
export function formatPageList(pages: readonly number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < pages.length) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === (pages[j] as number) + 1) j += 1;
    const first = pages[i] as number;
    const last = pages[j] as number;
    parts.push(first === last ? String(first) : `${first}-${last}`);
    i = j + 1;
  }
  return parts.join(",");
}

/** The pages NOT selected, ascending. Used by "delete pages". */
export function complementPages(selected: Iterable<number>, pageCount: number): number[] {
  const chosen = new Set(selected);
  const rest: number[] = [];
  for (let p = 1; p <= pageCount; p += 1) if (!chosen.has(p)) rest.push(p);
  return rest;
}
