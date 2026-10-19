/** Table styles: the banded rows, header colours and borders that PowerPoint applies to a table by style name. */
import type { OfficePackage, Relationship } from "../package";
import { type XNode, kid, kids, num, parseXml } from "../xml";
import { type ColorContext, applyLine, parseColor, parseFill, parseLinePartial, themeLine } from "./dml";
import type { FillDef, LineDef } from "./model";

type Side = "left" | "right" | "top" | "bottom" | "insideH" | "insideV";
const SIDES: Side[] = ["left", "right", "top", "bottom", "insideH", "insideV"];
const PART_NAMES = ["wholeTbl", "band1H", "band2H", "band1V", "band2V", "lastCol", "firstCol", "lastRow", "firstRow"] as const;
type PartName = (typeof PART_NAMES)[number];

interface StylePart {
  bold?: boolean;
  italic?: boolean;
  color?: string;
  fill?: FillDef;
  borders: Partial<Record<Side, LineDef | null>>;
}

export type TableStyle = Partial<Record<PartName, StylePart>>;

export interface TableFlags {
  firstRow: boolean;
  lastRow: boolean;
  firstCol: boolean;
  lastCol: boolean;
  bandRow: boolean;
  bandCol: boolean;
}

/** What the style gives one cell. Edges are `undefined` when the style says nothing about them. */
export interface CellLook {
  bold?: boolean;
  italic?: boolean;
  color?: string;
  fill?: FillDef;
  edges: { l?: LineDef | null; r?: LineDef | null; t?: LineDef | null; b?: LineDef | null };
}

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

/** PowerPoint's "Medium Style 2": the style new tables get. Files made by other tools refer to it by id without defining it. */
function mediumStyle2(id: string, accent: string): string {
  const edge = (side: string, width = 12700) => `<a:${side}><a:ln w="${width}" cmpd="sng"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln></a:${side}>`;
  const fill = (tint?: number) => `<a:fill><a:solidFill><a:schemeClr val="${accent}">${tint ? `<a:tint val="${tint}"/>` : ""}</a:schemeClr></a:solidFill></a:fill>`;
  const header = `<a:tcTxStyle b="on"><a:schemeClr val="lt1"/></a:tcTxStyle>`;
  return (
    `<a:tblStyle ${NS} styleId="${id}" styleName="Medium Style 2">` +
    `<a:wholeTbl><a:tcTxStyle><a:schemeClr val="dk1"/></a:tcTxStyle><a:tcStyle><a:tcBdr>${["left", "right", "top", "bottom", "insideH", "insideV"].map((side) => edge(side)).join("")}</a:tcBdr>${fill(20000)}</a:tcStyle></a:wholeTbl>` +
    `<a:band1H><a:tcStyle><a:tcBdr/>${fill(40000)}</a:tcStyle></a:band1H>` +
    `<a:band1V><a:tcStyle><a:tcBdr/>${fill(40000)}</a:tcStyle></a:band1V>` +
    `<a:lastCol>${header}<a:tcStyle><a:tcBdr/>${fill()}</a:tcStyle></a:lastCol>` +
    `<a:firstCol>${header}<a:tcStyle><a:tcBdr/>${fill()}</a:tcStyle></a:firstCol>` +
    `<a:lastRow>${header}<a:tcStyle><a:tcBdr>${edge("top", 38100)}</a:tcBdr>${fill()}</a:tcStyle></a:lastRow>` +
    `<a:firstRow>${header}<a:tcStyle><a:tcBdr>${edge("bottom", 38100)}</a:tcBdr>${fill()}</a:tcStyle></a:firstRow>` +
    `</a:tblStyle>`
  );
}

const NO_GRID = (id: string, name: string) => `<a:tblStyle ${NS} styleId="${id}" styleName="${name}"><a:wholeTbl><a:tcTxStyle><a:schemeClr val="tx1"/></a:tcTxStyle><a:tcStyle><a:tcBdr/><a:fill><a:noFill/></a:fill></a:tcStyle></a:wholeTbl></a:tblStyle>`;

const GRID = (id: string) => {
  const edge = (side: string) => `<a:${side}><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:ln></a:${side}>`;
  return `<a:tblStyle ${NS} styleId="${id}" styleName="No Style, Table Grid"><a:wholeTbl><a:tcTxStyle><a:schemeClr val="tx1"/></a:tcTxStyle><a:tcStyle><a:tcBdr>${["left", "right", "top", "bottom", "insideH", "insideV"].map(edge).join("")}</a:tcBdr><a:fill><a:noFill/></a:fill></a:tcStyle></a:wholeTbl></a:tblStyle>`;
};

const BUILTIN: Record<string, string> = {
  "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}": mediumStyle2("{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}", "accent1"),
  "{21E4AEA4-8DFA-4A89-87EB-49C32662AFE0}": mediumStyle2("{21E4AEA4-8DFA-4A89-87EB-49C32662AFE0}", "accent2"),
  "{F5AB1C69-6EDB-4FF4-983F-18BD219EF322}": mediumStyle2("{F5AB1C69-6EDB-4FF4-983F-18BD219EF322}", "accent3"),
  "{00A15C55-8517-42AA-B614-E9B94910E393}": mediumStyle2("{00A15C55-8517-42AA-B614-E9B94910E393}", "accent4"),
  "{7DF18680-E054-41AD-8BC1-D1AEF772440D}": mediumStyle2("{7DF18680-E054-41AD-8BC1-D1AEF772440D}", "accent5"),
  "{93296810-A885-4BE3-A3E7-6D5BEEA58F35}": mediumStyle2("{93296810-A885-4BE3-A3E7-6D5BEEA58F35}", "accent6"),
  "{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}": mediumStyle2("{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}", "dk1"),
  "{2D5ABB26-0587-4C30-8999-92F81FD0307C}": NO_GRID("{2D5ABB26-0587-4C30-8999-92F81FD0307C}", "No Style, No Grid"),
  "{5940675A-B579-460E-94D1-54222C63F5DA}": GRID("{5940675A-B579-460E-94D1-54222C63F5DA}"),
};

/** The table styles a file defines, plus the built-in ones it may refer to by id. */
export class TableStyles {
  private readonly defined = new Map<string, XNode>();
  private readonly builtin = new Map<string, XNode>();
  readonly defaultId?: string;

  constructor(pack: OfficePackage) {
    const root = pack.xml("ppt/tableStyles.xml");
    this.defaultId = root?.attrs.def;
    for (const style of kids(root, "a:tblStyle")) if (style.attrs.styleId) this.defined.set(style.attrs.styleId, style);
  }

  /** The style node for an id, or undefined when it is neither defined in the file nor one we know. */
  find(id: string | undefined): XNode | undefined {
    if (!id) return undefined;
    const own = this.defined.get(id);
    if (own) return own;
    const cached = this.builtin.get(id.toUpperCase());
    if (cached) return cached;
    const source = BUILTIN[id.toUpperCase()];
    if (!source) return undefined;
    const node = parseXml(source);
    this.builtin.set(id.toUpperCase(), node);
    return node;
  }
}

export function parseTableStyle(node: XNode, ctx: ColorContext, rels: Map<string, Relationship>): TableStyle {
  const style: TableStyle = {};
  for (const name of PART_NAMES) {
    const part = kid(node, `a:${name}`);
    if (!part) continue;
    const text = kid(part, "a:tcTxStyle");
    const cell = kid(part, "a:tcStyle");
    const result: StylePart = { borders: {} };
    if (text) {
      if (text.attrs.b) result.bold = text.attrs.b === "on";
      if (text.attrs.i) result.italic = text.attrs.i === "on";
      result.color = parseColor(text, ctx)?.color;
    }
    const fill = parseFill(kid(cell, "a:fill"), ctx, rels);
    if (fill) result.fill = fill;
    const borders = kid(cell, "a:tcBdr");
    for (const side of SIDES) {
      const edge = kid(borders, `a:${side}`);
      if (!edge) continue;
      const ln = kid(edge, "a:ln");
      const ref = kid(edge, "a:lnRef");
      if (ln) result.borders[side] = applyLine(null, parseLinePartial(ln, ctx, rels));
      else if (ref) result.borders[side] = themeLine(ctx, num(ref, "idx", 0), rels, parseColor(ref, ctx)?.color);
    }
    style[name] = result;
  }
  return style;
}

/** What a style gives the cell in row `row`, column `col` of a table with the given size and options. */
export function cellLook(style: TableStyle, flags: TableFlags, row: number, col: number, rows: number, cols: number): CellLook {
  const chain: StylePart[] = [];
  const add = (name: PartName) => {
    const part = style[name];
    if (part) chain.push(part);
  };
  add("wholeTbl");
  if (flags.bandRow) {
    // Banding starts after the header row, if there is one.
    const index = row - (flags.firstRow ? 1 : 0);
    const bodyRow = !(flags.firstRow && row === 0) && !(flags.lastRow && row === rows - 1);
    if (bodyRow) add(index % 2 === 0 ? "band1H" : "band2H");
  }
  if (flags.bandCol) {
    const index = col - (flags.firstCol ? 1 : 0);
    const bodyCol = !(flags.firstCol && col === 0) && !(flags.lastCol && col === cols - 1);
    if (bodyCol) add(index % 2 === 0 ? "band1V" : "band2V");
  }
  if (flags.firstCol && col === 0) add("firstCol");
  if (flags.lastCol && col === cols - 1) add("lastCol");
  if (flags.firstRow && row === 0) add("firstRow");
  if (flags.lastRow && row === rows - 1) add("lastRow");

  const look: CellLook = { edges: {} };
  for (const part of chain) {
    if (part.bold !== undefined) look.bold = part.bold;
    if (part.italic !== undefined) look.italic = part.italic;
    if (part.color) look.color = part.color;
    if (part.fill) look.fill = part.fill;
  }
  // Borders: each part speaks for the edges of its own region; "inside" lines are those between two cells of the region.
  const apply = (part: StylePart, region: "table" | "row" | "col") => {
    const b = part.borders;
    const leftEdge = region === "row" || region === "table" ? col === 0 : true;
    const rightEdge = region === "row" || region === "table" ? col === cols - 1 : true;
    const topEdge = region === "col" || region === "table" ? row === 0 : true;
    const bottomEdge = region === "col" || region === "table" ? row === rows - 1 : true;
    const pick = (outer: Side, inner: Side, isEdge: boolean): LineDef | null | undefined => (isEdge ? b[outer] : b[inner]);
    const l = pick("left", "insideV", leftEdge);
    const r = pick("right", "insideV", rightEdge);
    const t = pick("top", "insideH", topEdge);
    const bt = pick("bottom", "insideH", bottomEdge);
    if (l !== undefined) look.edges.l = l;
    if (r !== undefined) look.edges.r = r;
    if (t !== undefined) look.edges.t = t;
    if (bt !== undefined) look.edges.b = bt;
  };
  for (const name of PART_NAMES) {
    const part = style[name];
    if (!part || !chain.includes(part)) continue;
    // A row region runs across the whole table width; a column region down its whole height.
    const region = name === "wholeTbl" ? "table" : name === "firstRow" || name === "lastRow" || name === "band1H" || name === "band2H" ? "row" : "col";
    apply(part, region);
  }
  return look;
}
