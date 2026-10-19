import { AppError } from "../errors";
import { baseName } from "../format";
import { inDisplaySpace, parseColor } from "./draw";
import { finishEdit, loadForEdit, selectedPages } from "./document";
import { type FontChoice, type FontFamily, resolveFont } from "./fonts";
import { type JobContext, type OutputFile, type PdfInput, reportProgress } from "./types";

export type NumberPosition = "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";
export type NumberStyle = "decimal" | "roman" | "upper-roman";

export interface PageNumberOptions {
  position: NumberPosition;
  /** Text for each page. `{n}` is the page's number, `{total}` the last number used. */
  format: string;
  /** The number shown on the first numbered page. */
  startAt: number;
  style: NumberStyle;
  /** 1-based pages to number, or `null` for all of them. Numbering counts only these pages. */
  pages: readonly number[] | null;
  fontSize: number;
  /** "#rrggbb" */
  color: string;
  family: FontFamily;
  bold: boolean;
  italic: boolean;
  /** Distance from the page edge, in points. */
  margin: number;
  /** For books: swap left and right on even pages so numbers sit on the outer edge. */
  facing: boolean;
  /** Bytes of a TrueType/OpenType font for scripts the built-in fonts lack. */
  customFont?: Uint8Array;
  /**
   * For previews of one page taken out of a larger document: the value `{total}` should show, and the
   * page parity used for `facing`, as they would be in the full result.
   */
  preview?: { total: number; pageNumber: number };
}

export const DEFAULT_PAGE_NUMBER_OPTIONS: PageNumberOptions = {
  position: "bottom-center",
  format: "{n}",
  startAt: 1,
  style: "decimal",
  pages: null,
  fontSize: 11,
  color: "#333333",
  family: "sans",
  bold: false,
  italic: false,
  margin: 28,
  facing: false,
};

export function toRoman(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > 3999) return String(value);
  const table: [number, string][] = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let rest = value;
  let out = "";
  for (const [size, symbol] of table) {
    while (rest >= size) {
      out += symbol;
      rest -= size;
    }
  }
  return out;
}

function formatNumber(value: number, style: NumberStyle): string {
  if (style === "roman") return toRoman(value);
  if (style === "upper-roman") return toRoman(value).toUpperCase();
  return String(value);
}

/** Fills in `{n}` and `{total}`. Anything else in braces is left as typed. */
export function formatPageLabel(format: string, n: number, total: number, style: NumberStyle = "decimal"): string {
  return format.replaceAll("{n}", formatNumber(n, style)).replaceAll("{total}", formatNumber(total, style));
}

function validate(options: PageNumberOptions): void {
  if (!options.format.includes("{n}") && !options.format.includes("{total}")) {
    throw new AppError("INVALID_INPUT", "Include {n} in the text so every page gets its own number, for example “Page {n} of {total}”.");
  }
  if (!Number.isFinite(options.fontSize) || options.fontSize < 4 || options.fontSize > 96) {
    throw new AppError("INVALID_INPUT", "Choose a font size between 4 and 96 points.");
  }
  if (!Number.isFinite(options.margin) || options.margin < 0 || options.margin > 300) {
    throw new AppError("INVALID_INPUT", "Choose a margin between 0 and 300 points.");
  }
  if (!Number.isInteger(options.startAt) || options.startAt < 0 || options.startAt > 99_999) {
    throw new AppError("INVALID_INPUT", "The first number must be a whole number from 0 to 99999.");
  }
}

export async function addPageNumbers(input: PdfInput, options: PageNumberOptions, ctx?: JobContext): Promise<OutputFile> {
  validate(options);
  reportProgress(ctx, 0.05, "Opening the PDF");
  const doc = await loadForEdit(input);
  const pages = doc.getPages();
  const targets = selectedPages(pages.length, options.pages);
  const lastNumber = options.preview?.total ?? options.startAt + targets.length - 1;
  const color = parseColor(options.color);
  const choice: FontChoice = { family: options.family, bold: options.bold, italic: options.italic };
  const [vertical, horizontal] = options.position.split("-") as ["top" | "bottom", "left" | "center" | "right"];

  for (const [index, pageNumber] of targets.entries()) {
    const page = pages[pageNumber - 1];
    if (!page) continue;
    const label = formatPageLabel(options.format, options.startAt + index, lastNumber, options.style);
    const font = await resolveFont(doc, choice, label, options.customFont);
    const width = font.widthOfTextAtSize(label, options.fontSize);
    const ascent = font.heightAtSize(options.fontSize, { descender: false });

    // On facing pages the even (left-hand) pages mirror the position.
    const parityPage = options.preview?.pageNumber ?? pageNumber;
    const side = options.facing && parityPage % 2 === 0 && horizontal !== "center" ? (horizontal === "left" ? "right" : "left") : horizontal;

    inDisplaySpace(page, (frame) => {
      const x = side === "left" ? options.margin : side === "right" ? frame.displayWidth - options.margin - width : (frame.displayWidth - width) / 2;
      const y = vertical === "bottom" ? options.margin : frame.displayHeight - options.margin - ascent;
      page.drawText(label, { x, y, size: options.fontSize, font, color });
    });
    if (index % 10 === 0) reportProgress(ctx, 0.1 + (index / targets.length) * 0.8, `Numbering page ${pageNumber}`);
  }

  reportProgress(ctx, 0.92, "Saving and checking the result");
  const result = await finishEdit(doc, `${baseName(input.name)}_numbered.pdf`, pages.length);
  reportProgress(ctx, 1);
  return result;
}
