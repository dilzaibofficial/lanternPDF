/** What a slide is made of once layouts, masters and themes have been applied. Lengths are in points. */

export interface Transform {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees, clockwise. */
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

export type FillDef =
  | { kind: "none" }
  | { kind: "solid"; color: string; alpha: number }
  | { kind: "gradient"; stops: { position: number; color: string }[]; angle: number; radial: boolean; focus: { x: number; y: number }; alpha: number }
  | { kind: "picture"; part: string; crop?: Crop; alpha: number };

export interface Crop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface LineDef {
  width: number;
  fill: FillDef;
  /** Dash and gap lengths as multiples of the line width. */
  dash?: number[];
  cap?: "butt" | "round" | "square";
  headArrow?: boolean;
  tailArrow?: boolean;
}

export interface RunStyle {
  fontName?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: "single" | "double";
  strike?: boolean;
  caps?: "all" | "small";
  /** Percent of the size the text is raised (positive) or lowered. */
  baseline?: number;
  spacing?: number;
  color?: string;
  link?: string;
  /** The part name of a slide this text jumps to. */
  linkSlide?: string;
}

export interface BulletDef {
  /** "inherit" only changes the colour, font or size of a bullet defined further up. */
  kind: "char" | "auto" | "none" | "inherit";
  char?: string;
  autoType?: string;
  startAt?: number;
  font?: string;
  color?: string;
  sizePct?: number;
}

export interface ParaStyle {
  align?: "l" | "ctr" | "r" | "just" | "dist";
  marL?: number;
  marR?: number;
  indent?: number;
  spcBefPct?: number;
  spcBefPts?: number;
  spcAftPct?: number;
  spcAftPts?: number;
  lnPct?: number;
  lnPts?: number;
  defTab?: number;
  bullet?: BulletDef;
}

export interface LevelStyle {
  para: ParaStyle;
  run: RunStyle;
}

export type ParagraphItem =
  | { kind: "run"; text: string; style: RunStyle }
  | { kind: "break"; style: RunStyle }
  /** A field (slide number, date): `text` is what the file saved, `slideNumber` is true when it should show this slide's number. */
  | { kind: "field"; slideNumber: boolean; text: string; style: RunStyle };

export interface ParagraphM {
  items: ParagraphItem[];
  style: ParaStyle;
  /** Style for an empty paragraph, and the base of the bullet. */
  run: RunStyle;
  level: number;
  /** The number to show for an automatically numbered paragraph. */
  number?: number;
}

export interface TextBodyM {
  paragraphs: ParagraphM[];
  insets: { l: number; t: number; r: number; b: number };
  anchor: "t" | "ctr" | "b";
  wrap: boolean;
  autofit: "none" | "norm" | "shape";
  fontScale: number;
  lnReduction: number;
  vert: "horz" | "vert" | "vert270";
}

export type GeometryM = { kind: "preset"; name: string; adjust: Record<string, number> } | { kind: "custom"; paths: CustomPath[] };

export interface CustomPath {
  w: number;
  h: number;
  fill: boolean;
  stroke: boolean;
  commands: ("M" | "L" | "C" | "Z")[];
  points: number[];
}

export interface LinkInfo {
  uri?: string;
  /** The part name of the slide this jumps to. */
  slide?: string;
}

export type ShapeM =
  | { kind: "shape"; xf: Transform; geometry: GeometryM; fill: FillDef; line: LineDef | null; text?: TextBodyM; link?: LinkInfo; textXf?: Transform }
  | { kind: "picture"; xf: Transform; part: string; crop?: Crop; geometry?: GeometryM; line: LineDef | null; alpha: number; link?: LinkInfo }
  | { kind: "table"; xf: Transform; columns: number[]; rows: TableRowM[] };

export interface TableCellM {
  gridSpan: number;
  rowSpan: number;
  /** Covered by a cell to its left (hMerge) or above (vMerge): nothing of its own is drawn. */
  covered: boolean;
  text: TextBodyM;
  fill: FillDef;
  borders: { l: LineDef | null; r: LineDef | null; t: LineDef | null; b: LineDef | null };
}

export interface TableRowM {
  height: number;
  cells: TableCellM[];
}

export interface SlideM {
  /** The slide's number in the deck, counting hidden slides. */
  number: number;
  part: string;
  background: FillDef | null;
  /** Shapes from the master and layout first, then the slide's own, in painting order. */
  shapes: ShapeM[];
  hidden: boolean;
}

export interface PresentationM {
  width: number;
  height: number;
  slides: SlideM[];
  media: Map<string, { bytes: Uint8Array }>;
  title?: string;
  author?: string;
}
