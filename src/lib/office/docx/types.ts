import type { FontClass } from "../fontLibrary";
import type { Align, LinkRef, TabStop, UnderlineStyle } from "../textflow";

/** Run (character) properties, already in points and hex colours. */
export interface RunProps {
  bold?: boolean;
  italic?: boolean;
  underline?: UnderlineStyle | "none";
  underlineColor?: string;
  strike?: boolean;
  dstrike?: boolean;
  /** Hex colour; undefined means "automatic" (black, or white on a dark background). */
  color?: string;
  size?: number;
  fontName?: string;
  fontClass?: FontClass;
  highlight?: string;
  shade?: string;
  caps?: boolean;
  smallCaps?: boolean;
  vertAlign?: "superscript" | "subscript" | "baseline";
  spacing?: number;
  /** Raise (positive) or lower (negative) in points. */
  position?: number;
  hidden?: boolean;
  symbolFont?: boolean;
  rtl?: boolean;
}

export interface Border {
  style: "single" | "double" | "dotted" | "dashed" | "thick" | "none";
  width: number;
  color: string;
  space: number;
}

export interface Borders {
  top?: Border;
  left?: Border;
  bottom?: Border;
  right?: Border;
  between?: Border;
  insideH?: Border;
  insideV?: Border;
}

export interface ParaProps {
  align?: Align;
  /** All in points. */
  indent?: { left?: number; right?: number; firstLine?: number; hanging?: number };
  spacing?: { before?: number; after?: number; line?: number; lineRule?: "auto" | "exact" | "atLeast"; beforeAuto?: boolean; afterAuto?: boolean };
  keepNext?: boolean;
  keepLines?: boolean;
  pageBreakBefore?: boolean;
  widowControl?: boolean;
  contextualSpacing?: boolean;
  numId?: number;
  numLevel?: number;
  tabs?: TabStop[];
  clearedTabs?: number[];
  borders?: Borders;
  shading?: string;
  bidi?: boolean;
}

export interface ThemeInfo {
  major?: string;
  minor?: string;
  colors: Record<string, string>;
}

export interface NumberingLevel {
  start: number;
  format: string;
  text: string;
  suffix: "tab" | "space" | "nothing";
  align: "left" | "center" | "right";
  para: ParaProps;
  run: RunProps;
  legal: boolean;
  restart?: number;
}

export interface AbstractNumbering {
  id: number;
  levels: NumberingLevel[];
}

export interface NumberingInstance {
  numId: number;
  abstractId: number;
  overrides: Map<number, { start?: number }>;
}

export interface StyleDef {
  id: string;
  type: "paragraph" | "character" | "table" | "numbering";
  basedOn?: string;
  isDefault: boolean;
  para: ParaProps;
  run: RunProps;
  /** Table styles: the parts that apply under conditions ("firstRow", "band1Horz"...). */
  conditions: Map<string, { para: ParaProps; run: RunProps; cell: CellProps }>;
  table?: TableProps;
  cell?: CellProps;
}

export interface CellProps {
  shading?: string;
  borders?: Borders;
  margins?: { top?: number; left?: number; bottom?: number; right?: number };
  vAlign?: "top" | "center" | "bottom";
}

export interface TableProps {
  borders?: Borders;
  cellMargins?: { top?: number; left?: number; bottom?: number; right?: number };
  /** Width: points, or a percentage of the text width. */
  width?: { type: "pt" | "pct" | "auto"; value: number };
  align?: "left" | "center" | "right";
  indent?: number;
  fixed?: boolean;
  look?: { firstRow: boolean; lastRow: boolean; firstCol: boolean; lastCol: boolean; bandedRows: boolean; bandedCols: boolean };
  styleId?: string;
  rowBandSize?: number;
  colBandSize?: number;
}

// ---- document model -----------------------------------------------------------------------------------

export interface AnchorInfo {
  hFrom: string;
  hOffset: number;
  hAlign?: string;
  vFrom: string;
  vOffset: number;
  vAlign?: string;
  wrap: "none" | "square" | "tight" | "through" | "topAndBottom";
  behind: boolean;
}

export type Inline =
  | { kind: "text"; text: string; run: RunProps; link?: LinkRef }
  | { kind: "tab"; run: RunProps }
  | { kind: "break"; type: "line" | "page" | "column"; run: RunProps }
  | { kind: "field"; field: "page" | "pages"; run: RunProps }
  | { kind: "image"; part: string; width: number; height: number; rise?: number; run: RunProps; link?: LinkRef; crop?: { left: number; top: number; right: number; bottom: number }; anchor?: AnchorInfo }
  | { kind: "bookmark"; name: string }
  | { kind: "note"; noteId: number; label: string; run: RunProps };

export interface ParagraphBlock {
  type: "p";
  props: ParaProps;
  styleId?: string;
  /** Style of the paragraph mark (gives an empty paragraph its height). */
  markRun: RunProps;
  items: Inline[];
  /** Set when this paragraph carries the properties of the section that ends with it. */
  section?: SectionProps;
}

export interface CellModel {
  gridSpan: number;
  vMerge: "restart" | "continue" | null;
  props: CellProps;
  width?: number;
  blocks: Block[];
  noWrap?: boolean;
}

export interface RowModel {
  cells: CellModel[];
  height?: { value: number; rule: "atLeast" | "exact" };
  header: boolean;
  cantSplit: boolean;
}

export interface TableBlock {
  type: "tbl";
  props: TableProps;
  grid: number[];
  rows: RowModel[];
}

export type Block = ParagraphBlock | TableBlock;

export interface HeaderFooterRef {
  default?: string;
  first?: string;
  even?: string;
}

export interface SectionProps {
  pageWidth: number;
  pageHeight: number;
  landscape: boolean;
  margins: { top: number; right: number; bottom: number; left: number; header: number; footer: number };
  columns: number;
  columnGap: number;
  titlePage: boolean;
  type: "nextPage" | "continuous" | "evenPage" | "oddPage";
  headers: HeaderFooterRef;
  footers: HeaderFooterRef;
  pageNumberStart?: number;
}

export interface Section {
  props: SectionProps;
  blocks: Block[];
}

export interface DocxModel {
  sections: Section[];
  /** Parsed header and footer parts by part path. */
  parts: Map<string, Block[]>;
  evenAndOddHeaders: boolean;
  /** Footnote and endnote bodies by id. */
  notes: Map<number, Block[]>;
  media: Map<string, { bytes: Uint8Array }>;
  info: { title?: string; author?: string; subject?: string; keywords?: string };
  defaultTabStop: number;
}
