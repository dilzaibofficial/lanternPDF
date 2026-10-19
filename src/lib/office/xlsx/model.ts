export interface FontDef {
  name: string;
  size: number;
  bold: boolean;
  italic: boolean;
  underline?: "single" | "double";
  strike: boolean;
  /** Hex colour; undefined means automatic (black). */
  color?: string;
}

export interface BorderSide {
  style: "thin" | "medium" | "thick" | "dashed" | "dotted" | "double" | "hair";
  color: string;
}

export interface BorderDef {
  left?: BorderSide;
  right?: BorderSide;
  top?: BorderSide;
  bottom?: BorderSide;
}

export type HAlign = "general" | "left" | "center" | "right" | "fill" | "justify" | "centerContinuous" | "distributed";
export type VAlign = "top" | "center" | "bottom" | "justify" | "distributed";

/** Everything that decides how one kind of cell looks (an entry of the workbook's cell formats). */
export interface CellFormat {
  font: FontDef;
  fill?: string;
  border: BorderDef;
  /** A format code ("0.00", "yyyy-mm-dd"...) or a built-in format number. */
  numFmt: string | number;
  halign: HAlign;
  valign: VAlign;
  wrap: boolean;
  indent: number;
  rotation: number;
  shrink: boolean;
}

export interface RichRun {
  text: string;
  font?: Partial<FontDef>;
}

export interface Cell {
  type: "number" | "string" | "boolean" | "error" | "blank";
  value: number | string | boolean | null;
  format: number;
  rich?: RichRun[];
  /** The cell has a formula but no stored result. */
  uncached?: boolean;
}

export interface MergeRange {
  row: number;
  col: number;
  rows: number;
  cols: number;
}

export interface SheetPageSetup {
  landscape?: boolean;
  paperSize?: number;
  scale?: number;
  fitToPage: boolean;
  fitToWidth: number;
  fitToHeight: number;
  margins: { left: number; right: number; top: number; bottom: number; header: number; footer: number };
  gridLines: boolean;
  horizontalCentered: boolean;
  verticalCentered: boolean;
  overThenDown: boolean;
  firstPageNumber?: number;
}

export interface SheetImage {
  part: string;
  /** Top-left and bottom-right corners as a cell plus an offset in points inside it. */
  from: { col: number; row: number; dx: number; dy: number };
  to?: { col: number; row: number; dx: number; dy: number };
  /** For one-cell anchors: the size in points. */
  size?: { width: number; height: number };
}

export interface Sheet {
  name: string;
  visible: boolean;
  /** Cells by row then column (zero-based). */
  cells: Map<number, Map<number, Cell>>;
  rowCount: number;
  columnCount: number;
  defaultColumnWidth: number;
  defaultRowHeight: number;
  /** Column widths in points; undefined for columns that use the default. */
  columnWidths: Map<number, number>;
  hiddenColumns: Set<number>;
  rowHeights: Map<number, number>;
  hiddenRows: Set<number>;
  merges: MergeRange[];
  setup: SheetPageSetup;
  header: string;
  footer: string;
  rowBreaks: number[];
  columnBreaks: number[];
  printArea?: { row: number; col: number; rows: number; cols: number };
  printTitleRows?: { first: number; last: number };
  printTitleColumns?: { first: number; last: number };
  images: SheetImage[];
  hyperlinks: { row: number; col: number; rows: number; cols: number; uri: string }[];
  rowFormats: Map<number, number>;
  columnFormats: Map<number, number>;
}

export interface Workbook {
  sheets: Sheet[];
  formats: CellFormat[];
  date1904: boolean;
  defaultFont: FontDef;
  media: Map<string, { bytes: Uint8Array }>;
  title?: string;
  author?: string;
}
