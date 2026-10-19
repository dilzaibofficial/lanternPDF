/** Reads Word's formatting elements (w:rPr, w:pPr, borders, cell and table properties) into plain objects. */
import { type XNode, attr, elements, kid, kids, num } from "../xml";
import { twipsToPt } from "../units";
import type { Align, TabStop, UnderlineStyle } from "../textflow";
import type { Border, Borders, CellProps, ParaProps, RunProps, TableProps, ThemeInfo } from "./types";

export interface PropContext {
  theme: ThemeInfo;
}

/** `<w:b/>` is on, `<w:b w:val="0"/>` is off, a missing element means "not said". */
export function onOff(node: XNode | undefined): boolean | undefined {
  if (!node) return undefined;
  const value = node.attrs["w:val"] ?? node.attrs.val;
  if (value === undefined) return true;
  return !["0", "false", "off", "none"].includes(value.toLowerCase());
}

const HIGHLIGHT: Record<string, string> = {
  yellow: "#ffff00",
  green: "#00ff00",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  blue: "#0000ff",
  red: "#ff0000",
  darkBlue: "#000080",
  darkCyan: "#008080",
  darkGreen: "#008000",
  darkMagenta: "#800080",
  darkRed: "#800000",
  darkYellow: "#808000",
  darkGray: "#808080",
  lightGray: "#c0c0c0",
  black: "#000000",
  white: "#ffffff",
};

const THEME_COLOR_NAME: Record<string, string> = {
  dark1: "dk1",
  light1: "lt1",
  dark2: "dk2",
  light2: "lt2",
  text1: "dk1",
  text2: "dk2",
  background1: "lt1",
  background2: "lt2",
  accent1: "accent1",
  accent2: "accent2",
  accent3: "accent3",
  accent4: "accent4",
  accent5: "accent5",
  accent6: "accent6",
  hyperlink: "hlink",
  followedHyperlink: "folHlink",
};

function hexChannel(hex: string, start: number): number {
  return Number.parseInt(hex.slice(start, start + 2), 16);
}

/** Lightens (tint) or darkens (shade) a colour the way theme colours are adjusted. Both are 0..255. */
export function adjustColor(hex: string, tint?: number, shade?: number): string {
  const clean = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return `#${clean}`;
  let channels = [hexChannel(clean, 0), hexChannel(clean, 2), hexChannel(clean, 4)];
  if (tint !== undefined) channels = channels.map((c) => Math.round(c * (tint / 255) + 255 * (1 - tint / 255)));
  if (shade !== undefined) channels = channels.map((c) => Math.round(c * (shade / 255)));
  return `#${channels.map((c) => Math.min(255, Math.max(0, c)).toString(16).padStart(2, "0")).join("")}`;
}

/** The colour of a w:color / w:shd-style element: an explicit value, or a theme colour with its tint or shade. */
export function parseColor(node: XNode | undefined, ctx: PropContext, valueAttr = "w:val"): string | undefined {
  if (!node) return undefined;
  const value = node.attrs[valueAttr];
  const themeName = node.attrs["w:themeColor"];
  if (themeName) {
    const base = ctx.theme.colors[THEME_COLOR_NAME[themeName] ?? themeName];
    if (base) {
      const tint = node.attrs["w:themeTint"] ? Number.parseInt(node.attrs["w:themeTint"], 16) : undefined;
      const shade = node.attrs["w:themeShade"] ? Number.parseInt(node.attrs["w:themeShade"], 16) : undefined;
      return adjustColor(base, tint, shade);
    }
  }
  if (!value || value === "auto") return undefined;
  return /^[0-9a-fA-F]{6}$/.test(value) ? `#${value.toLowerCase()}` : undefined;
}

const UNDERLINES: Record<string, UnderlineStyle | "none"> = {
  none: "none",
  single: "single",
  words: "single",
  double: "double",
  thick: "thick",
  dotted: "dotted",
  dottedHeavy: "dotted",
  dash: "dash",
  dashedHeavy: "dash",
  dashLong: "dash",
  dashLongHeavy: "dash",
  dotDash: "dash",
  dotDashHeavy: "dash",
  dotDotDash: "dash",
  dotDotDashHeavy: "dash",
  wave: "wave",
  wavyHeavy: "wave",
  wavyDouble: "wave",
};

const SYMBOL_FONTS = new Set(["symbol", "wingdings", "wingdings 2", "wingdings 3", "webdings"]);

export function parseRunProps(rPr: XNode | undefined, ctx: PropContext): RunProps {
  const out: RunProps = {};
  if (!rPr) return out;
  const bold = onOff(kid(rPr, "w:b"));
  if (bold !== undefined) out.bold = bold;
  const italic = onOff(kid(rPr, "w:i"));
  if (italic !== undefined) out.italic = italic;
  const strike = onOff(kid(rPr, "w:strike"));
  if (strike !== undefined) out.strike = strike;
  const dstrike = onOff(kid(rPr, "w:dstrike"));
  if (dstrike !== undefined) out.dstrike = dstrike;
  const caps = onOff(kid(rPr, "w:caps"));
  if (caps !== undefined) out.caps = caps;
  const smallCaps = onOff(kid(rPr, "w:smallCaps"));
  if (smallCaps !== undefined) out.smallCaps = smallCaps;
  const hidden = onOff(kid(rPr, "w:vanish"));
  if (hidden !== undefined) out.hidden = hidden;
  const rtl = onOff(kid(rPr, "w:rtl"));
  if (rtl !== undefined) out.rtl = rtl;

  const underline = kid(rPr, "w:u");
  if (underline) {
    const style = UNDERLINES[underline.attrs["w:val"] ?? "single"] ?? "single";
    out.underline = style;
    const color = parseColor(underline, ctx);
    if (color) out.underlineColor = color;
  }
  const color = kid(rPr, "w:color");
  if (color) {
    const parsed = parseColor(color, ctx);
    if (parsed) out.color = parsed;
    else if (color.attrs["w:val"] === "auto") out.color = undefined;
  }
  const size = kid(rPr, "w:sz");
  if (size) {
    const value = num(size, "w:val", 0);
    if (value > 0) out.size = value / 2;
  }
  const highlight = kid(rPr, "w:highlight");
  if (highlight) {
    const name = highlight.attrs["w:val"];
    if (name && name !== "none") out.highlight = HIGHLIGHT[name];
  }
  const shade = kid(rPr, "w:shd");
  if (shade) {
    const fill = shade.attrs["w:fill"];
    if (fill && fill !== "auto" && /^[0-9a-fA-F]{6}$/.test(fill)) out.shade = `#${fill.toLowerCase()}`;
  }
  const vert = kid(rPr, "w:vertAlign");
  if (vert) {
    const value = vert.attrs["w:val"];
    if (value === "superscript" || value === "subscript" || value === "baseline") out.vertAlign = value;
  }
  const spacing = kid(rPr, "w:spacing");
  if (spacing) out.spacing = twipsToPt(num(spacing, "w:val", 0));
  const position = kid(rPr, "w:position");
  if (position) out.position = num(position, "w:val", 0) / 2;

  const fonts = kid(rPr, "w:rFonts");
  if (fonts) {
    let name = fonts.attrs["w:ascii"] ?? fonts.attrs["w:hAnsi"];
    const themed = fonts.attrs["w:asciiTheme"] ?? fonts.attrs["w:hAnsiTheme"];
    if (themed) {
      const themeFont = themed.startsWith("major") ? ctx.theme.major : ctx.theme.minor;
      if (themeFont) name = themeFont;
    }
    if (name) out.fontName = name;
  }
  if (out.fontName && SYMBOL_FONTS.has(out.fontName.toLowerCase())) out.symbolFont = true;
  return out;
}

export function mergeRun(base: RunProps, over: RunProps): RunProps {
  const out: RunProps = { ...base };
  for (const [key, value] of Object.entries(over) as [keyof RunProps, unknown][]) {
    if (value !== undefined || key === "color") (out as Record<string, unknown>)[key] = value;
  }
  if (over.fontName !== undefined) out.symbolFont = over.symbolFont ?? SYMBOL_FONTS.has(over.fontName.toLowerCase());
  return out;
}

export function mergePara(base: ParaProps, over: ParaProps): ParaProps {
  const out: ParaProps = { ...base };
  for (const [key, value] of Object.entries(over) as [keyof ParaProps, unknown][]) {
    if (value === undefined) continue;
    if (key === "indent" || key === "spacing" || key === "borders") (out as Record<string, unknown>)[key] = { ...((base[key] as object | undefined) ?? {}), ...(value as object) };
    else if (key === "tabs") out.tabs = [...(base.tabs ?? []), ...(over.tabs ?? [])];
    else (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

export function parseBorder(node: XNode | undefined, ctx: PropContext): Border | undefined {
  if (!node) return undefined;
  const value = node.attrs["w:val"] ?? "none";
  if (value === "nil" || value === "none") return { style: "none", width: 0, color: "#000000", space: 0 };
  const eighths = num(node, "w:sz", 4);
  const style: Border["style"] = value.includes("double") ? "double" : value.includes("dot") && !value.includes("dash") ? "dotted" : value.includes("dash") || value.includes("Dash") ? "dashed" : value.includes("thick") ? "thick" : "single";
  return { style, width: Math.max(0.25, eighths / 8), color: parseColor(node, ctx) ?? "#000000", space: num(node, "w:space", 0) };
}

export function parseBorders(node: XNode | undefined, ctx: PropContext): Borders | undefined {
  if (!node) return undefined;
  const out: Borders = {};
  const set = (key: keyof Borders, ...names: string[]) => {
    for (const name of names) {
      const border = parseBorder(kid(node, name), ctx);
      if (border) {
        out[key] = border;
        return;
      }
    }
  };
  set("top", "w:top");
  set("left", "w:left", "w:start");
  set("bottom", "w:bottom");
  set("right", "w:right", "w:end");
  set("between", "w:between");
  set("insideH", "w:insideH");
  set("insideV", "w:insideV");
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseAlign(value: string | undefined): Align | undefined {
  switch (value) {
    case "left":
    case "start":
      return "left";
    case "center":
      return "center";
    case "right":
    case "end":
      return "right";
    case "both":
    case "justify":
      return "justify";
    case "distribute":
    case "thaiDistribute":
      return "distribute";
    default:
      return undefined;
  }
}

export function parseParaProps(pPr: XNode | undefined, ctx: PropContext): ParaProps {
  const out: ParaProps = {};
  if (!pPr) return out;
  const jc = parseAlign(kid(pPr, "w:jc")?.attrs["w:val"]);
  if (jc) out.align = jc;
  const ind = kid(pPr, "w:ind");
  if (ind) {
    const indent: NonNullable<ParaProps["indent"]> = {};
    const left = ind.attrs["w:left"] ?? ind.attrs["w:start"];
    const right = ind.attrs["w:right"] ?? ind.attrs["w:end"];
    if (left !== undefined) indent.left = twipsToPt(Number(left) || 0);
    if (right !== undefined) indent.right = twipsToPt(Number(right) || 0);
    if (ind.attrs["w:firstLine"] !== undefined) indent.firstLine = twipsToPt(Number(ind.attrs["w:firstLine"]) || 0);
    if (ind.attrs["w:hanging"] !== undefined) indent.hanging = twipsToPt(Number(ind.attrs["w:hanging"]) || 0);
    out.indent = indent;
  }
  const spacing = kid(pPr, "w:spacing");
  if (spacing) {
    const value: NonNullable<ParaProps["spacing"]> = {};
    if (spacing.attrs["w:before"] !== undefined) value.before = twipsToPt(Number(spacing.attrs["w:before"]) || 0);
    if (spacing.attrs["w:after"] !== undefined) value.after = twipsToPt(Number(spacing.attrs["w:after"]) || 0);
    const rule = spacing.attrs["w:lineRule"];
    if (spacing.attrs["w:line"] !== undefined) {
      const raw = Number(spacing.attrs["w:line"]) || 240;
      value.lineRule = rule === "exact" ? "exact" : rule === "atLeast" ? "atLeast" : "auto";
      value.line = value.lineRule === "auto" ? raw / 240 : twipsToPt(raw);
    }
    if (spacing.attrs["w:beforeAutospacing"] === "1" || spacing.attrs["w:beforeAutospacing"] === "true") value.beforeAuto = true;
    if (spacing.attrs["w:afterAutospacing"] === "1" || spacing.attrs["w:afterAutospacing"] === "true") value.afterAuto = true;
    out.spacing = value;
  }
  const keepNext = onOff(kid(pPr, "w:keepNext"));
  if (keepNext !== undefined) out.keepNext = keepNext;
  const keepLines = onOff(kid(pPr, "w:keepLines"));
  if (keepLines !== undefined) out.keepLines = keepLines;
  const pageBreakBefore = onOff(kid(pPr, "w:pageBreakBefore"));
  if (pageBreakBefore !== undefined) out.pageBreakBefore = pageBreakBefore;
  const widow = onOff(kid(pPr, "w:widowControl"));
  if (widow !== undefined) out.widowControl = widow;
  const contextual = onOff(kid(pPr, "w:contextualSpacing"));
  if (contextual !== undefined) out.contextualSpacing = contextual;
  const bidi = onOff(kid(pPr, "w:bidi"));
  if (bidi !== undefined) out.bidi = bidi;

  const numPr = kid(pPr, "w:numPr");
  if (numPr) {
    const numId = kid(numPr, "w:numId");
    const level = kid(numPr, "w:ilvl");
    if (numId) out.numId = num(numId, "w:val", 0);
    if (level) out.numLevel = num(level, "w:val", 0);
  }
  const tabs = kid(pPr, "w:tabs");
  if (tabs) {
    const stops: TabStop[] = [];
    const cleared: number[] = [];
    for (const tab of kids(tabs, "w:tab")) {
      const position = twipsToPt(num(tab, "w:pos", 0));
      const kind = tab.attrs["w:val"] ?? "left";
      if (kind === "clear") {
        cleared.push(position);
        continue;
      }
      if (kind === "bar") continue;
      const leaderName = tab.attrs["w:leader"];
      const leader = leaderName === "dot" ? "dot" : leaderName === "hyphen" ? "hyphen" : leaderName === "underscore" || leaderName === "heavy" ? "underscore" : leaderName === "middleDot" ? "middleDot" : undefined;
      stops.push({ position, align: kind === "center" ? "center" : kind === "right" || kind === "end" ? "right" : kind === "decimal" ? "decimal" : "left", leader });
    }
    out.tabs = stops;
    if (cleared.length > 0) out.clearedTabs = cleared;
  }
  const borders = parseBorders(kid(pPr, "w:pBdr"), ctx);
  if (borders) out.borders = borders;
  const shd = kid(pPr, "w:shd");
  if (shd) {
    const fill = shd.attrs["w:fill"];
    if (fill && fill !== "auto" && /^[0-9a-fA-F]{6}$/.test(fill)) out.shading = `#${fill.toLowerCase()}`;
  }
  return out;
}

function margin(node: XNode | undefined, ...names: string[]): number | undefined {
  for (const name of names) {
    const child = kid(node, name);
    if (child) return twipsToPt(num(child, "w:w", 0));
  }
  return undefined;
}

function margins(node: XNode | undefined): CellProps["margins"] | undefined {
  if (!node) return undefined;
  const out: NonNullable<CellProps["margins"]> = {};
  const top = margin(node, "w:top");
  const left = margin(node, "w:left", "w:start");
  const bottom = margin(node, "w:bottom");
  const right = margin(node, "w:right", "w:end");
  if (top !== undefined) out.top = top;
  if (left !== undefined) out.left = left;
  if (bottom !== undefined) out.bottom = bottom;
  if (right !== undefined) out.right = right;
  return out;
}

export function parseCellProps(tcPr: XNode | undefined, ctx: PropContext): CellProps {
  const out: CellProps = {};
  if (!tcPr) return out;
  const shd = kid(tcPr, "w:shd");
  if (shd) {
    const fill = shd.attrs["w:fill"];
    if (fill && fill !== "auto" && /^[0-9a-fA-F]{6}$/.test(fill)) out.shading = `#${fill.toLowerCase()}`;
    else if (fill === "auto" && shd.attrs["w:val"] === "clear") out.shading = undefined;
  }
  const borders = parseBorders(kid(tcPr, "w:tcBorders"), ctx);
  if (borders) out.borders = borders;
  const mar = margins(kid(tcPr, "w:tcMar"));
  if (mar && Object.keys(mar).length > 0) out.margins = mar;
  const vAlign = kid(tcPr, "w:vAlign")?.attrs["w:val"];
  if (vAlign === "center" || vAlign === "bottom" || vAlign === "top") out.vAlign = vAlign;
  return out;
}

export function parseTableWidth(node: XNode | undefined): { type: "pt" | "pct" | "auto"; value: number } | undefined {
  if (!node) return undefined;
  const type = node.attrs["w:type"] ?? "dxa";
  const raw = node.attrs["w:w"] ?? "0";
  if (type === "auto" || type === "nil") return { type: "auto", value: 0 };
  if (type === "pct") return { type: "pct", value: raw.endsWith("%") ? Number.parseFloat(raw) : (Number(raw) || 0) / 50 };
  return { type: "pt", value: twipsToPt(Number(raw) || 0) };
}

export function parseTableProps(tblPr: XNode | undefined, ctx: PropContext): TableProps {
  const out: TableProps = {};
  if (!tblPr) return out;
  const style = kid(tblPr, "w:tblStyle")?.attrs["w:val"];
  if (style) out.styleId = style;
  const width = parseTableWidth(kid(tblPr, "w:tblW"));
  if (width) out.width = width;
  const jc = kid(tblPr, "w:jc")?.attrs["w:val"];
  if (jc === "center") out.align = "center";
  else if (jc === "right" || jc === "end") out.align = "right";
  else if (jc === "left" || jc === "start") out.align = "left";
  const ind = kid(tblPr, "w:tblInd");
  if (ind) out.indent = twipsToPt(num(ind, "w:w", 0));
  const layout = kid(tblPr, "w:tblLayout")?.attrs["w:type"];
  if (layout === "fixed") out.fixed = true;
  const borders = parseBorders(kid(tblPr, "w:tblBorders"), ctx);
  if (borders) out.borders = borders;
  const mar = margins(kid(tblPr, "w:tblCellMar"));
  if (mar && Object.keys(mar).length > 0) out.cellMargins = mar;
  const look = kid(tblPr, "w:tblLook");
  if (look) {
    const mask = look.attrs["w:val"] ? Number.parseInt(look.attrs["w:val"], 16) : undefined;
    const flag = (name: string, bit: number, fallback: boolean): boolean => {
      const direct = look.attrs[`w:${name}`];
      if (direct !== undefined) return direct === "1" || direct === "true";
      return mask !== undefined ? (mask & bit) !== 0 : fallback;
    };
    out.look = {
      firstRow: flag("firstRow", 0x20, true),
      lastRow: flag("lastRow", 0x40, false),
      firstCol: flag("firstColumn", 0x80, true),
      lastCol: flag("lastColumn", 0x100, false),
      bandedRows: !flag("noHBand", 0x200, false),
      bandedCols: !flag("noVBand", 0x400, true),
    };
  }
  const rowBand = kid(tblPr, "w:tblStyleRowBandSize");
  if (rowBand) out.rowBandSize = num(rowBand, "w:val", 1);
  const colBand = kid(tblPr, "w:tblStyleColBandSize");
  if (colBand) out.colBandSize = num(colBand, "w:val", 1);
  return out;
}

/** All the elements below `node` whose names are in `names` (non-recursive helper for mixed content). */
export function childrenNamed(node: XNode | undefined, names: readonly string[]): XNode[] {
  return elements(node).filter((child) => names.includes(child.name));
}

export { attr };
