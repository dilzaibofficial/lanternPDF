/**
 * Turns the positioned text pdf.js reports into structure: lines, columns, paragraphs, headings, lists
 * and tables. Everything here is pure geometry on plain objects, so it is easy to test and has no
 * dependency on the PDF library or the DOM.
 *
 * Coordinates are in points as the page is displayed: x grows to the right, y grows *down*, and an
 * item's y is its text baseline.
 */

export type FontKind = "sans" | "serif" | "mono";

export interface RawItem {
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  font: FontKind;
}

/** A run of text on one line with no big gap inside it. */
export interface Segment {
  /** The text of all its runs together. */
  text: string;
  /** The same text split where bold or italic starts or stops. */
  runs: Run[];
  x: number;
  right: number;
  fontSize: number;
  /** True only when every run is bold (or italic). */
  bold: boolean;
  italic: boolean;
  font: FontKind;
}

export interface Line {
  /** Baseline. */
  y: number;
  fontSize: number;
  segments: Segment[];
}

export const lineLeft = (line: Line): number => line.segments[0]?.x ?? 0;
export const lineRight = (line: Line): number => line.segments[line.segments.length - 1]?.right ?? 0;
export const lineText = (line: Line, separator = " "): string => line.segments.map((segment) => segment.text).join(separator);

/** Builds a string from character codes, so no invisible or look-alike character has to be typed into the source. */
const chars = (...codes: number[]) => String.fromCharCode(...codes);

/** XML 1.0 forbids most control characters; U+FFFE and U+FFFF are not characters; U+FFFD marks text that failed to decode. */
const INVALID_XML = new RegExp(`[${chars(0x00)}-${chars(0x08)}${chars(0x0b, 0x0c)}${chars(0x0e)}-${chars(0x1f)}${chars(0xfffe, 0xffff, 0xfffd)}]`, "g");
const SOFT_HYPHEN = new RegExp(chars(0xad), "g");
const NO_BREAK_SPACES = new RegExp(`[${chars(0xa0, 0x2007, 0x202f)}]`, "g");

/** Removes what cannot appear in the XML inside Office files, the soft hyphen, and turns no-break spaces into spaces. */
export function sanitize(text: string): string {
  return text.replace(INVALID_XML, "").replace(SOFT_HYPHEN, "").replace(NO_BREAK_SPACES, " ");
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
};

const lowQuartile = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * 0.25)] as number;
};

export interface LineOptions {
  /** A gap wider than this many em (font sizes) starts a new segment. Word wants it large, tables small. */
  segmentGap: number;
}

/** Groups items into lines (items sharing a baseline) and cuts each line into segments at wide gaps. */
export function buildLines(items: readonly RawItem[], options: LineOptions): Line[] {
  const usable = items.filter((item) => item.text.trim() !== "" && item.fontSize > 0 && Number.isFinite(item.x) && Number.isFinite(item.y));
  const sorted = [...usable].sort((a, b) => a.y - b.y || a.x - b.x);

  const rows: { y: number; items: RawItem[] }[] = [];
  for (const item of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(item.y - row.y) <= 0.45 * Math.min(item.fontSize, ...row.items.map((member) => member.fontSize))) {
      row.items.push(item);
      row.y = (row.y * (row.items.length - 1) + item.y) / row.items.length;
    } else {
      rows.push({ y: item.y, items: [item] });
    }
  }

  return rows.map((row) => {
    const ordered = [...row.items].sort((a, b) => a.x - b.x);
    const segments: Segment[] = [];
    let previous: RawItem | null = null;
    for (const item of ordered) {
      const gap = previous ? item.x - (previous.x + previous.width) : 0;
      // Fake bold is drawn by printing the same text twice, a hair apart: keep one copy.
      if (previous && item.text === previous.text && Math.abs(item.x - previous.x) < 0.15 * item.fontSize) continue;
      const current = segments[segments.length - 1];
      if (!previous || !current || gap > options.segmentGap * Math.max(item.fontSize, previous.fontSize)) {
        segments.push({ text: item.text, runs: [{ text: item.text, bold: item.bold, italic: item.italic }], x: item.x, right: item.x + item.width, fontSize: item.fontSize, bold: item.bold, italic: item.italic, font: item.font });
      } else {
        const glue = gap > 0.15 * item.fontSize && !/\s$/.test(current.text) && !/^\s/.test(item.text) ? " " : "";
        const tail = current.runs[current.runs.length - 1] as Run;
        tail.text += glue; // the space belongs to the text before it
        if (tail.bold === item.bold && tail.italic === item.italic) tail.text += item.text;
        else current.runs.push({ text: item.text, bold: item.bold, italic: item.italic });
        current.text += glue + item.text;
        current.right = Math.max(current.right, item.x + item.width);
        current.fontSize = Math.max(current.fontSize, item.fontSize);
      }
      previous = item;
    }
    for (const segment of segments) {
      segment.runs = tidyRuns(segment.runs);
      segment.text = segment.runs.map((run) => run.text).join("");
      segment.bold = segment.runs.length > 0 && segment.runs.every((run) => run.bold);
      segment.italic = segment.runs.length > 0 && segment.runs.every((run) => run.italic);
    }
    return { y: row.y, fontSize: Math.max(...segments.map((segment) => segment.fontSize)), segments: segments.filter((segment) => segment.text !== "") };
  }).filter((line) => line.segments.length > 0);
}

/** Collapses runs of white space and trims the ends of the segment, keeping the style boundaries. */
function tidyRuns(runs: Run[]): Run[] {
  const tidy = runs.map((run) => ({ ...run, text: run.text.replace(/\s+/g, " ") }));
  const first = tidy[0];
  const last = tidy[tidy.length - 1];
  if (first) first.text = first.text.replace(/^\s+/, "");
  if (last) last.text = last.text.replace(/\s+$/, "");
  return mergeRuns(tidy);
}

/** The font size most of the text is set in: the "body" size, against which headings are judged. */
export function bodyFontSize(lines: readonly Line[]): number {
  const weight = new Map<number, number>();
  for (const line of lines) {
    for (const segment of line.segments) {
      const size = Math.round(segment.fontSize * 2) / 2;
      weight.set(size, (weight.get(size) ?? 0) + segment.text.length);
    }
  }
  let best = 12;
  let bestWeight = -1;
  for (const [size, amount] of weight) {
    if (amount > bestWeight) {
      best = size;
      bestWeight = amount;
    }
  }
  return best;
}

/**
 * The distinct font sizes the document uses for headings (clearly bigger than the body), biggest first.
 * A heading's level is its rank among them, so the document's largest type is Heading 1, the next is Heading 2.
 */
export function headingSizes(lines: readonly Line[], body: number): number[] {
  const sizes = new Set<number>();
  for (const line of lines) {
    const size = Math.round(line.fontSize * 2) / 2;
    if (size >= body * 1.18 && lineText(line).length <= 160) sizes.add(size);
  }
  return [...sizes].sort((a, b) => b - a);
}

type Lane = "full" | "left" | "right" | "both";

/**
 * Puts the lines of a page into reading order. In a two-column layout the lines of the two columns share
 * baselines, so reading straight across would interleave them; instead each run of consecutive two-column
 * lines is emitted left column first, then right. A line that spans both columns (a title, a figure
 * caption) ends a run. Pages without real columns come back untouched.
 */
export function readingOrder(lines: readonly Line[], pageWidth: number): Line[] {
  const text = lines.filter((line) => line.segments.length > 0);
  if (text.length < 6) return [...text];
  const left = Math.min(...text.map(lineLeft));
  const right = Math.max(...text.map(lineRight));
  const middle = (left + right) / 2;
  const slack = 0.04 * pageWidth;

  // Real text columns hold substantial runs of text. Short cells that happen to sit on both sides of the middle
  // (the rows of a table) are not columns, so such lines are treated like full-width ones and left alone.
  const minColumnText = 0.18 * (right - left);
  const lanes = text.map((line): Lane => {
    if (line.segments.some((segment) => segment.x < middle - slack && segment.right > middle + slack)) return "full";
    const hasLeft = line.segments.some((segment) => segment.right <= middle + slack);
    const hasRight = line.segments.some((segment) => segment.x >= middle - slack);
    if (hasLeft && hasRight) return line.segments.length === 2 && line.segments.every((segment) => segment.right - segment.x >= minColumnText) ? "both" : "full";
    return hasLeft ? "left" : "right";
  });

  const out: Line[] = [];
  let index = 0;
  while (index < text.length) {
    if (lanes[index] === "full") {
      out.push(text[index] as Line);
      index += 1;
      continue;
    }
    let end = index;
    while (end < text.length && lanes[end] !== "full") end += 1;
    const run = text.slice(index, end);
    const bothCount = lanes.slice(index, end).filter((lane) => lane === "both").length;
    if (bothCount >= 3) {
      const leftHalf: Line[] = [];
      const rightHalf: Line[] = [];
      for (const line of run) {
        const l = line.segments.filter((segment) => segment.right <= middle + slack);
        const r = line.segments.filter((segment) => segment.x >= middle - slack);
        if (l.length > 0) leftHalf.push({ ...line, segments: l });
        if (r.length > 0) rightHalf.push({ ...line, segments: r });
      }
      out.push(...leftHalf, ...rightHalf);
    } else {
      out.push(...run);
    }
    index = end;
  }
  return out;
}

// ---- paragraphs -------------------------------------------------------------------------------------------

export interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
}

export interface Paragraph {
  kind: "heading" | "body" | "bullet" | "tabular";
  /** 1 to 3 for headings. */
  level?: 1 | 2 | 3;
  runs: Run[];
  align: "left" | "center" | "right";
  /** Left indent in points, relative to the page's text margin. */
  indent: number;
  /** Where the parts of a "tabular" paragraph start, in points from the text margin, so Word can line them up. */
  tabs: number[];
  fontSize: number;
  font: FontKind;
}

const BULLET = /^\s*([•◦▪▫●○■□‣⁃·*]|[-–—](?=\s))\s*/;

const plainText = (runs: readonly Run[]): string => runs.map((run) => run.text).join("");

function mergeRuns(runs: Run[]): Run[] {
  const merged: Run[] = [];
  for (const run of runs) {
    if (run.text === "") continue;
    const last = merged[merged.length - 1];
    if (last && last.bold === run.bold && last.italic === run.italic) last.text += run.text;
    else merged.push({ ...run });
  }
  return merged;
}

/** Joins the lines of a paragraph, undoing a hyphen that only exists because the line broke there. */
function joinLines(lines: readonly Line[]): Run[] {
  const runs: Run[] = [];
  lines.forEach((line, index) => {
    line.segments.forEach((segment, position) => {
      const parts = segment.runs.map((run) => ({ ...run }));
      const tail = parts[parts.length - 1];
      const last = position === line.segments.length - 1;
      const next = lines[index + 1]?.segments[0]?.text ?? "";
      if (tail) {
        // A hyphen before a line break is usually just the break ("inter-" / "national"). A compound word that
        // happens to be split there ("well-" / "known") loses its hyphen too: the file does not say which it was.
        if (last && /[a-zà-ÿ]-$/.test(segment.text) && /^[a-zà-ÿ]/.test(next)) tail.text = tail.text.slice(0, -1);
        else if (!(last && index === lines.length - 1)) tail.text += position < line.segments.length - 1 ? "\t" : " ";
      }
      runs.push(...parts);
    });
  });
  const merged = mergeRuns(runs);
  const tail = merged[merged.length - 1];
  if (tail) tail.text = tail.text.replace(/\s+$/, "");
  return merged;
}

export interface PageGeometry {
  width: number;
  /** Left edge of the page's text, used to work out indentation and alignment. */
  textLeft: number;
  textRight: number;
}

/**
 * Builds paragraphs from ordered lines. A new paragraph starts at a bigger-than-usual gap, at a change of
 * font size, at a list marker, after a short closing line, and around lines that are laid out in several
 * parts (those are kept whole, with tabs between the parts).
 */
export function buildParagraphs(lines: readonly Line[], geometry: PageGeometry, body: number, headings: readonly number[] = []): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const textWidth = Math.max(1, geometry.textRight - geometry.textLeft);
  let group: Line[] = [];

  const flush = () => {
    if (group.length === 0) return;
    const first = group[0] as Line;
    const runs = joinLines(group);
    const text = plainText(runs);
    const size = Math.max(...group.map((line) => line.fontSize));
    const seg = first.segments[0] as Segment;
    const allBold = runs.length > 0 && runs.every((run) => run.bold);
    const left = lineLeft(first);
    const right = Math.max(...group.map(lineRight));
    const center = (left + right) / 2;
    const pageCenter = (geometry.textLeft + geometry.textRight) / 2;
    const narrow = right - left < 0.8 * textWidth;
    // Centred on the page, or on the block of text (whose right edge is ragged, so the page's middle is the better guide).
    const centred = Math.abs(center - geometry.width / 2) < 0.04 * geometry.width || Math.abs(center - pageCenter) < 0.04 * geometry.width;
    const align: Paragraph["align"] = narrow && group.length <= 3 && centred && left - geometry.textLeft > 0.08 * textWidth ? "center" : narrow && group.length === 1 && geometry.textRight - right < 0.03 * geometry.width && left - geometry.textLeft > 0.25 * textWidth ? "right" : "left";

    let kind: Paragraph["kind"] = first.segments.length > 1 ? "tabular" : "body";
    let level: Paragraph["level"];
    if (kind === "body" && group.length <= 3 && text.length <= 160) {
      const rank = headings.findIndex((candidate) => size >= candidate - 0.25);
      if (size >= body * 1.18 && rank >= 0) level = Math.min(3, rank + 1) as 1 | 2 | 3;
      else if (size >= body * 1.35) level = 1;
      else if (size >= body * 1.18 || (allBold && size >= body * 1.05 && group.length === 1)) level = 2;
      else if (allBold && group.length === 1 && text.length <= 80 && size >= body * 0.98) level = 3;
      if (level) kind = "heading";
    }
    if (kind === "body" && BULLET.test(text)) {
      kind = "bullet";
      const stripped = runs[0] ? { ...runs[0], text: runs[0].text.replace(BULLET, "") } : null;
      if (stripped) runs[0] = stripped;
    }
    const tabs = kind === "tabular" ? first.segments.slice(1).map((segment) => Math.round((segment.x - geometry.textLeft) * 10) / 10) : [];
    paragraphs.push({ kind, level, runs, align, indent: Math.max(0, Math.round((left - geometry.textLeft) * 10) / 10), tabs, fontSize: size, font: seg.font });
    group = [];
  };

  // The ordinary line pitch is the small gap most lines are separated by (the low quartile), not the median:
  // on a sparse page, where blocks are far apart, the median would be a block gap.
  const typical = lowQuartile(lines.slice(1).map((line, i) => line.y - (lines[i] as Line).y).filter((gap) => gap > 0));

  for (const line of lines) {
    const previous = group[group.length - 1];
    if (!previous) {
      group.push(line);
      continue;
    }
    const gap = line.y - previous.y;
    const lineHeight = Math.max(previous.fontSize, line.fontSize) * 1.2;
    const sizeChange = Math.abs(line.fontSize - previous.fontSize) > Math.max(0.8, 0.1 * previous.fontSize);
    const multipart = line.segments.length > 1 || previous.segments.length > 1;
    const marker = BULLET.test(lineText(line)) || /^\s*(\d{1,3}[.)]|\([0-9a-z]{1,3}\))\s/.test(lineText(line));
    const shortClose = lineRight(previous) < geometry.textLeft + 0.62 * textWidth && /[.!?:;]["')\]]?$/.test(lineText(previous));
    const openGap = gap > Math.max(lineHeight * 1.45, typical * 1.6);
    const indented = lineLeft(line) - lineLeft(previous) > 1.2 * line.fontSize && lineRight(previous) - lineLeft(previous) > 0.5 * textWidth;
    if (multipart || openGap || sizeChange || marker || shortClose || indented) flush();
    group.push(line);
  }
  flush();
  return paragraphs;
}

// ---- tables ---------------------------------------------------------------------------------------------------

export interface TableBlock {
  type: "table";
  /** Rows of cells; every row has `columns` entries. */
  rows: string[][];
  columns: number;
  /** The segment style of the first row, to tell whether it is a header. */
  headerBold: boolean;
  /** The table's horizontal extent on the page and the x positions between its columns, in points. */
  left: number;
  right: number;
  boundaries: number[];
  fontSize: number;
}

export interface TextBlock {
  type: "text";
  line: Line;
}

export type Block = TableBlock | TextBlock;

/**
 * Finds the vertical gutters (x ranges no text crosses) in a group of lines and returns the column
 * boundaries they imply. Works for left-, right- and centre-aligned cells alike, because it looks at where
 * the text is not rather than where it starts.
 */
export function columnBoundaries(lines: readonly Line[], minGutter: number): number[] {
  const spans = lines.flatMap((line) => line.segments.map((segment) => [segment.x, segment.right] as const)).sort((a, b) => a[0] - b[0]);
  if (spans.length === 0) return [];
  const boundaries: number[] = [];
  let reach = (spans[0] as readonly [number, number])[1];
  for (const [start, end] of spans.slice(1)) {
    if (start - reach >= minGutter) boundaries.push((start + reach) / 2);
    reach = Math.max(reach, end);
  }
  return boundaries;
}

const columnOf = (boundaries: readonly number[], x: number): number => boundaries.filter((boundary) => boundary < x).length;

/**
 * Splits a page's lines into tables and ordinary text. A table is a run of at least two consecutive lines
 * that each have two or more segments and whose parts line up in at least two columns.
 */
export function findTables(lines: readonly Line[], minGutter: number): Block[] {
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as Line;
    if (line.segments.length < 2) {
      blocks.push({ type: "text", line });
      index += 1;
      continue;
    }
    let end = index;
    while (end < lines.length && (lines[end] as Line).segments.length >= 2) end += 1;
    const run = lines.slice(index, end);
    const boundaries = columnBoundaries(run, minGutter);
    if (run.length >= 2 && boundaries.length >= 1) {
      const columns = boundaries.length + 1;
      const rows = run.map((row) => {
        const cells = new Array<string>(columns).fill("");
        for (const segment of row.segments) {
          const column = columnOf(boundaries, (segment.x + segment.right) / 2);
          cells[column] = cells[column] ? `${cells[column]} ${segment.text}` : segment.text;
        }
        return cells;
      });
      blocks.push({
        type: "table",
        rows,
        columns,
        headerBold: run[0]?.segments.every((segment) => segment.bold) ?? false,
        left: Math.min(...run.map(lineLeft)),
        right: Math.max(...run.map(lineRight)),
        boundaries,
        fontSize: median(run.map((row) => row.fontSize)),
      });
    } else {
      for (const member of run) blocks.push({ type: "text", line: member });
    }
    index = end;
  }
  return blocks;
}

// ---- numbers --------------------------------------------------------------------------------------------------

export interface ParsedNumber {
  value: number;
  /** An Excel number format, when the text carried one ("0.00%", "$#,##0.00"). */
  format?: string;
}

/**
 * Reads text that is unmistakably a number: optional sign or accounting brackets, optional currency symbol,
 * digits with comma thousands separators, optional decimals, optional percent. Anything ambiguous (leading
 * zeros as in IDs, 1.234 which could be either style, dates, phone numbers) stays text.
 */
export function parseNumber(text: string): ParsedNumber | null {
  const trimmed = text.trim();
  const match = /^(\()?([-+−])?([$€£¥])?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(%)?(\))?$/.exec(trimmed);
  if (!match) return null;
  const [, open, sign, currency, whole, fraction, percent, close] = match as unknown as [string, string | undefined, string | undefined, string | undefined, string, string | undefined, string | undefined, string | undefined];
  if ((open === undefined) !== (close === undefined)) return null;
  if (!whole.includes(",") && whole.length > 1 && whole.startsWith("0")) return null; // 007: an identifier, not a number
  const digits = whole.replaceAll(",", "") + (fraction ?? "");
  let value = Number(digits);
  if (!Number.isFinite(value)) return null;
  if (sign === "-" || sign === "−" || open !== undefined) value = -value;
  const decimals = fraction ? `.${"0".repeat(fraction.length - 1)}` : "";
  if (percent) return { value: value / 100, format: `0${decimals}%` };
  if (currency) return { value, format: `${currency}#,##0${decimals}` };
  if (whole.includes(",")) return { value, format: `#,##0${decimals}` };
  return fraction ? { value, format: `0${decimals}` } : { value };
}
