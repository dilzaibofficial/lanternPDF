/**
 * What the converters could not reproduce. A conversion that quietly leaves things out looks like a success but is not
 * one, so every skipped or approximated feature is counted here and shown to the person with the result.
 */
export type WarningKind =
  | "textbox"
  | "shape"
  | "chart"
  | "smartart"
  | "equation"
  | "ole"
  | "image-format"
  | "image-broken"
  | "floating"
  | "columns"
  | "footnotes"
  | "rtl"
  | "watermark"
  | "tall-row"
  | "missing-glyphs"
  | "conditional-formatting"
  | "formulas-uncached"
  | "sheet-hidden"
  | "gradient"
  | "video"
  | "vertical-text"
  | "table-style"
  | "wordart"
  | "frames"
  | "effects"
  | "slide-hidden";

const TEXT: Record<WarningKind, (count: number, detail?: string) => string> = {
  textbox: (n) => `${n} text ${n === 1 ? "box was" : "boxes were"} left out.`,
  shape: (n) => `${n} drawn ${n === 1 ? "shape was" : "shapes were"} left out or simplified.`,
  chart: (n) => `${n} ${n === 1 ? "chart was" : "charts were"} left out.`,
  smartart: (n) => `${n} SmartArt ${n === 1 ? "graphic was" : "graphics were"} left out.`,
  equation: (n) => `${n} ${n === 1 ? "equation was" : "equations were"} left out.`,
  ole: (n) => `${n} embedded ${n === 1 ? "object was" : "objects were"} left out.`,
  "image-format": (n, detail) => `${n} ${n === 1 ? "picture" : "pictures"} in a format that cannot be shown here${detail ? ` (${detail})` : ""} ${n === 1 ? "was" : "were"} left out.`,
  "image-broken": (n) => `${n} ${n === 1 ? "picture" : "pictures"} could not be read and ${n === 1 ? "was" : "were"} left out.`,
  floating: (n) => `${n} ${n === 1 ? "picture that text wraps around was" : "pictures that text wraps around were"} placed in the line of text instead.`,
  columns: () => "Text in multiple columns is shown in a single column.",
  footnotes: () => "Footnotes and endnotes are shown at the end of the document, not at the bottom of each page.",
  rtl: () => "Right-to-left text (Arabic, Hebrew) is not laid out right to left.",
  watermark: (n) => `${n} ${n === 1 ? "watermark was" : "watermarks were"} left out.`,
  "tall-row": (n) => `${n} table ${n === 1 ? "row is" : "rows are"} taller than a page and ${n === 1 ? "was" : "were"} cut off.`,
  "missing-glyphs": (_n, detail) => `Some characters could not be drawn with the built-in fonts and show as “?”${detail ? `: ${detail}` : ""}.`,
  "conditional-formatting": () => "Conditional formatting (colour scales, data bars, icons) is not applied.",
  "formulas-uncached": (n) => `${n} ${n === 1 ? "formula has" : "formulas have"} no saved result, so ${n === 1 ? "its cell is" : "their cells are"} blank. Open and save the file in Excel to store the results.`,
  "sheet-hidden": (n) => `${n} hidden ${n === 1 ? "sheet was" : "sheets were"} not included.`,
  gradient: () => "Gradient fills are shown as a single colour.",
  video: (n) => `${n} ${n === 1 ? "video or audio clip is" : "video and audio clips are"} not included.`,
  "vertical-text": () => "Vertical or rotated text is shown horizontally.",
  "table-style": () => "Some table style details may differ from the original.",
  wordart: (n) => `${n} WordArt ${n === 1 ? "item was" : "items were"} left out.`,
  effects: (n) => `${n} ${n === 1 ? "shape has" : "shapes have"} shadows, glows or other effects that are not drawn.`,
  "slide-hidden": (n) => `${n} hidden ${n === 1 ? "slide was" : "slides were"} not included.`,
  frames: (n) => `${n} text ${n === 1 ? "frame was" : "frames were"} placed in the normal text flow.`,
};

export class Warnings {
  private readonly counts = new Map<WarningKind, { count: number; detail?: string }>();

  add(kind: WarningKind, count = 1, detail?: string): void {
    const current = this.counts.get(kind);
    this.counts.set(kind, { count: (current?.count ?? 0) + count, detail: detail ?? current?.detail });
  }

  has(kind: WarningKind): boolean {
    return this.counts.has(kind);
  }

  /** One sentence per kind, for the person who asked for the conversion. */
  messages(): string[] {
    return [...this.counts.entries()].map(([kind, { count, detail }]) => TEXT[kind](count, detail));
  }
}
