import type { FontFamilyChoice, TextBoxObject } from "./types";

/**
 * Where the lines of a text box go. The editor draws the box from this and the export draws the PDF from this, so
 * they agree on where lines break and where each baseline sits. How wide a string is comes from a callback: the
 * browser measures with a canvas, the export measures with the font it is about to draw with.
 */

export type Measure = (text: string, size: number, font: { family: FontFamilyChoice; bold: boolean; italic: boolean }, letterSpacing: number) => number;

export interface LaidLine {
  text: string;
  /** Left edge of the text, in the box's own coordinates (0 = the box's left edge). */
  x: number;
  /** Baseline, measured from the top of the box. */
  baseline: number;
  width: number;
}

export interface TextLayout {
  lines: LaidLine[];
  /** Height needed by the text and the padding. */
  contentHeight: number;
}

/** Position of the first baseline below the top of the text area, as a multiple of the font size. */
export const FIRST_BASELINE = 0.9;

/** Splits text into lines that fit `maxWidth`: at the line breaks that were typed, then at spaces, then inside long words. */
export function wrapText(text: string, maxWidth: number, widthOf: (s: string) => number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    if (paragraph === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/(?<= )/)) {
      const candidate = line + word;
      if (line === "" || widthOf(candidate.trimEnd()) <= maxWidth) {
        line = candidate;
        continue;
      }
      out.push(line.trimEnd());
      line = word;
    }
    // A single word wider than the box is broken between letters.
    let rest = line.trimEnd();
    while (widthOf(rest) > maxWidth && Array.from(rest).length > 1) {
      let take = Array.from(rest);
      let head = "";
      for (const ch of take) {
        if (head !== "" && widthOf(head + ch) > maxWidth) break;
        head += ch;
      }
      out.push(head);
      take = Array.from(rest.slice(head.length));
      rest = take.join("");
    }
    out.push(rest);
  }
  return out;
}

export function layoutTextBox(box: Pick<TextBoxObject, "text" | "width" | "size" | "family" | "bold" | "italic" | "align" | "lineHeight" | "letterSpacing" | "padding">, measure: Measure): TextLayout {
  const inner = Math.max(1, box.width - box.padding * 2);
  const font = { family: box.family, bold: box.bold, italic: box.italic };
  const widthOf = (s: string) => measure(s, box.size, font, box.letterSpacing);
  const wrapped = wrapText(box.text, inner, widthOf);
  const lines: LaidLine[] = wrapped.map((text, index) => {
    const width = widthOf(text);
    const x = box.align === "center" ? box.padding + (inner - width) / 2 : box.align === "right" ? box.padding + inner - width : box.padding;
    return { text, x, baseline: box.padding + box.size * FIRST_BASELINE + index * box.size * box.lineHeight, width };
  });
  const last = lines.length > 0 ? box.padding + box.size * FIRST_BASELINE + (lines.length - 1) * box.size * box.lineHeight + box.size * 0.3 : box.padding * 2 + box.size;
  return { lines, contentHeight: Math.max(last + box.padding, box.size + box.padding * 2) };
}
