/** DrawingML (the drawing language PowerPoint uses): colours, fills, lines and text properties. */
import type { Relationship } from "../package";
import type { Theme } from "../theme";
import { hundredthsToPt } from "../units";
import { type XNode, elements, kid, kids, num } from "../xml";
import type { BulletDef, Crop, FillDef, LevelStyle, LineDef, ParaStyle, RunStyle } from "./model";

export interface ColorContext {
  theme: Theme;
  /** Maps "bg1", "tx1"... to theme colour names ("lt1", "dk1"...). */
  colorMap: Record<string, string>;
}

const PRESET_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  gray: "#808080",
  grey: "#808080",
  orange: "#ffa500",
  purple: "#800080",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  darkBlue: "#00008b",
  darkRed: "#8b0000",
  darkGreen: "#006400",
  lightGray: "#d3d3d3",
  dkGray: "#a9a9a9",
  ltGray: "#d3d3d3",
};

const DEFAULT_COLOR_MAP: Record<string, string> = { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2", accent1: "accent1", accent2: "accent2", accent3: "accent3", accent4: "accent4", accent5: "accent5", accent6: "accent6", hlink: "hlink", folHlink: "folHlink" };

export function defaultColorMap(): Record<string, string> {
  return { ...DEFAULT_COLOR_MAP };
}

type Rgb = [number, number, number];
type Hsl = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const clean = hex.replace("#", "");
  return [Number.parseInt(clean.slice(0, 2), 16), Number.parseInt(clean.slice(2, 4), 16), Number.parseInt(clean.slice(4, 6), 16)];
}

const toHex = (value: number): string => Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, "0");
const rgbToHex = ([r, g, b]: Rgb): string => `#${toHex(r)}${toHex(g)}${toHex(b)}`;

/** sRGB (0-255) to linear light (0-1) and back. Tints and shades are mixed in linear light, as PowerPoint does. */
const toLinear = (value: number): number => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (value: number): number => {
  const c = Math.min(1, Math.max(0, value));
  return (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255;
};

function rgbToHsl([r0, g0, b0]: Rgb): Hsl {
  const r = r0 / 255;
  const g = g0 / 255;
  const b = b0 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]: Hsl): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0: number) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255];
}

const COLOR_ELEMENTS = ["a:srgbClr", "a:schemeClr", "a:sysClr", "a:prstClr", "a:hslClr", "a:scrgbClr"];

/** The colour element (srgbClr, schemeClr...) among the children of `parent`, with its transforms applied. */
export function parseColor(parent: XNode | undefined, ctx: ColorContext, phClr?: string): { color: string; alpha: number } | undefined {
  const element = elements(parent).find((child) => COLOR_ELEMENTS.includes(child.name));
  if (!element) return undefined;
  let base: string | undefined;
  switch (element.name) {
    case "a:srgbClr":
      base = /^[0-9a-fA-F]{6}$/.test(element.attrs.val ?? "") ? `#${(element.attrs.val as string).toLowerCase()}` : undefined;
      break;
    case "a:sysClr":
      base = element.attrs.lastClr ? `#${element.attrs.lastClr.toLowerCase()}` : element.attrs.val === "window" ? "#ffffff" : "#000000";
      break;
    case "a:prstClr":
      base = PRESET_COLORS[element.attrs.val ?? ""] ?? "#000000";
      break;
    case "a:schemeClr": {
      const name = element.attrs.val ?? "";
      if (name === "phClr") {
        base = phClr;
      } else {
        const mapped = ctx.colorMap[name] ?? name;
        base = ctx.theme.colors[mapped];
        if (!base && (mapped === "dk1" || mapped === "tx1")) base = "#000000";
        if (!base && (mapped === "lt1" || mapped === "bg1")) base = "#ffffff";
      }
      break;
    }
    case "a:scrgbClr":
      base = rgbToHex([fromLinear(num(element, "r", 0) / 100000), fromLinear(num(element, "g", 0) / 100000), fromLinear(num(element, "b", 0) / 100000)]);
      break;
    case "a:hslClr":
      base = rgbToHex(hslToRgb([num(element, "hue", 0) / 21600000, num(element, "sat", 0) / 100000, num(element, "lum", 0) / 100000]));
      break;
    default:
      break;
  }
  if (!base) return undefined;
  let color = base;
  let alpha = 1;
  for (const modifier of elements(element)) {
    const value = num(modifier, "val", 0) / 100000;
    switch (modifier.name) {
      case "a:lumMod": {
        const [h, s, l] = rgbToHsl(hexToRgb(color));
        color = rgbToHex(hslToRgb([h, s, Math.min(1, l * value)]));
        break;
      }
      case "a:lumOff": {
        const [h, s, l] = rgbToHsl(hexToRgb(color));
        color = rgbToHex(hslToRgb([h, s, Math.min(1, Math.max(0, l + value))]));
        break;
      }
      case "a:satMod": {
        const [h, s, l] = rgbToHsl(hexToRgb(color));
        color = rgbToHex(hslToRgb([h, Math.min(1, s * value), l]));
        break;
      }
      case "a:satOff": {
        const [h, s, l] = rgbToHsl(hexToRgb(color));
        color = rgbToHex(hslToRgb([h, Math.min(1, Math.max(0, s + value)), l]));
        break;
      }
      case "a:tint": {
        const mixed = hexToRgb(color).map((channel) => fromLinear(1 - (1 - toLinear(channel)) * value));
        color = rgbToHex(mixed as Rgb);
        break;
      }
      case "a:shade": {
        const mixed = hexToRgb(color).map((channel) => fromLinear(toLinear(channel) * value));
        color = rgbToHex(mixed as Rgb);
        break;
      }
      case "a:alpha":
        alpha = value;
        break;
      case "a:alphaMod":
        alpha *= value;
        break;
      default:
        break;
    }
  }
  return { color, alpha };
}

export function parseCrop(node: XNode | undefined): Crop | undefined {
  if (!node) return undefined;
  return { left: num(node, "l", 0) / 100000, top: num(node, "t", 0) / 100000, right: num(node, "r", 0) / 100000, bottom: num(node, "b", 0) / 100000 };
}

/** The fill described by a shape's properties: none, a colour, a gradient or a picture. Undefined when the element names none. */
export function parseFill(parent: XNode | undefined, ctx: ColorContext, rels: Map<string, Relationship>, phClr?: string): FillDef | undefined {
  for (const child of elements(parent)) {
    switch (child.name) {
      case "a:noFill":
        return { kind: "none" };
      case "a:solidFill": {
        const color = parseColor(child, ctx, phClr);
        return color ? { kind: "solid", color: color.color, alpha: color.alpha } : undefined;
      }
      case "a:gradFill": {
        const stops = kids(kid(child, "a:gsLst"), "a:gs").flatMap((stop) => {
          const color = parseColor(stop, ctx, phClr);
          return color ? [{ position: num(stop, "pos", 0) / 100000, color: color.color, alpha: color.alpha }] : [];
        });
        if (stops.length === 0) return undefined;
        const linear = kid(child, "a:lin");
        const path = kid(child, "a:path");
        const focusRect = kid(path, "a:fillToRect");
        const focus = focusRect ? { x: (num(focusRect, "l", 50000) + (100000 - num(focusRect, "r", 50000))) / 200000, y: (num(focusRect, "t", 50000) + (100000 - num(focusRect, "b", 50000))) / 200000 } : { x: 0.5, y: 0.5 };
        return { kind: "gradient", stops: stops.map(({ position, color }) => ({ position, color })), angle: num(linear, "ang", 0) / 60000, radial: path !== undefined, focus, alpha: stops.reduce((sum, stop) => sum + stop.alpha, 0) / stops.length };
      }
      case "a:blipFill": {
        const blip = kid(child, "a:blip");
        const rel = blip?.attrs["r:embed"] ? rels.get(blip.attrs["r:embed"]) : undefined;
        if (!rel || rel.external) return undefined;
        const alpha = num(kid(blip, "a:alphaModFix"), "amt", 100000) / 100000;
        return { kind: "picture", part: rel.target, crop: parseCrop(kid(child, "a:srcRect")), alpha };
      }
      case "a:pattFill": {
        const color = parseColor(kid(child, "a:fgClr"), ctx, phClr);
        return color ? { kind: "solid", color: color.color, alpha: color.alpha } : undefined;
      }
      default:
        break;
    }
  }
  return undefined;
}

/** A fill taken from the theme's list of fill styles. `index` is 1-based; 1001 and up are the background fill styles. */
export function themeFill(ctx: ColorContext, index: number, rels: Map<string, Relationship>, phClr?: string): FillDef | undefined {
  const list = index >= 1001 ? ctx.theme.backgroundFillStyles : ctx.theme.fillStyles;
  const style = list[index >= 1001 ? index - 1001 : index - 1];
  if (!style) return undefined;
  return parseFill({ name: "holder", attrs: {}, children: [style] }, ctx, rels, phClr);
}

// ---- lines ---------------------------------------------------------------------------------------------------

const DASHES: Record<string, number[]> = {
  dot: [1, 2],
  sysDot: [1, 1],
  dash: [4, 3],
  sysDash: [3, 1],
  lgDash: [8, 3],
  dashDot: [4, 3, 1, 3],
  lgDashDot: [8, 3, 1, 3],
  lgDashDotDot: [8, 3, 1, 3, 1, 3],
  sysDashDot: [3, 1, 1, 1],
  sysDashDotDot: [3, 1, 1, 1, 1, 1],
};

/** What an <a:ln> element sets. Anything it leaves out is inherited from the style it overrides. */
export interface LinePartial {
  width?: number;
  fill?: FillDef;
  dash?: number[];
  solidDash?: boolean;
  cap?: LineDef["cap"];
  headArrow?: boolean;
  tailArrow?: boolean;
}

export function parseLinePartial(ln: XNode | undefined, ctx: ColorContext, rels: Map<string, Relationship>, phClr?: string): LinePartial | undefined {
  if (!ln) return undefined;
  const out: LinePartial = {};
  if (ln.attrs.w !== undefined) out.width = Number(ln.attrs.w) / 12700;
  const fill = parseFill(ln, ctx, rels, phClr);
  if (fill) out.fill = fill;
  const dashName = kid(ln, "a:prstDash")?.attrs.val;
  if (dashName === "solid") out.solidDash = true;
  else if (dashName) out.dash = DASHES[dashName];
  const custom = kid(ln, "a:custDash");
  if (custom) {
    const pattern = kids(custom, "a:ds").flatMap((part) => [num(part, "d", 100000) / 100000, num(part, "sp", 100000) / 100000]);
    if (pattern.length > 0) out.dash = pattern;
  }
  if (ln.attrs.cap) out.cap = ln.attrs.cap === "rnd" ? "round" : ln.attrs.cap === "sq" ? "square" : "butt";
  const head = kid(ln, "a:headEnd")?.attrs.type;
  const tail = kid(ln, "a:tailEnd")?.attrs.type;
  if (head !== undefined) out.headArrow = head !== "none";
  if (tail !== undefined) out.tailArrow = tail !== "none";
  return out;
}

/** A line from the theme's list of line styles; `index` is 1-based and 0 means no line. */
export function themeLine(ctx: ColorContext, index: number, rels: Map<string, Relationship>, phClr?: string): LineDef | null {
  if (index <= 0) return null;
  const style = ctx.theme.lineStyles[index - 1];
  if (!style) return null;
  return applyLine(null, parseLinePartial(style, ctx, rels, phClr));
}

/** Puts a line's own settings over the line it inherits. `base` null means the style above draws no line. */
export function applyLine(base: LineDef | null | undefined, over: LinePartial | undefined): LineDef | null {
  if (over?.fill?.kind === "none") return null;
  if (!over) return base ?? null;
  if (!base) {
    // Without a colour of its own or an inherited one there is nothing to draw.
    if (!over.fill) return null;
    return { width: over.width ?? 0.75, fill: over.fill, dash: over.dash, cap: over.cap, headArrow: over.headArrow, tailArrow: over.tailArrow };
  }
  return {
    width: over.width ?? base.width,
    fill: over.fill ?? base.fill,
    dash: over.solidDash ? undefined : (over.dash ?? base.dash),
    cap: over.cap ?? base.cap,
    headArrow: over.headArrow ?? base.headArrow,
    tailArrow: over.tailArrow ?? base.tailArrow,
  };
}

// ---- text ----------------------------------------------------------------------------------------------------

export function parseRunStyle(rPr: XNode | undefined, ctx: ColorContext, rels: Map<string, Relationship>): RunStyle {
  const out: RunStyle = {};
  if (!rPr) return out;
  if (rPr.attrs.sz !== undefined) out.size = hundredthsToPt(Number(rPr.attrs.sz));
  if (rPr.attrs.b !== undefined) out.bold = rPr.attrs.b === "1" || rPr.attrs.b === "true";
  if (rPr.attrs.i !== undefined) out.italic = rPr.attrs.i === "1" || rPr.attrs.i === "true";
  if (rPr.attrs.u !== undefined && rPr.attrs.u !== "none") out.underline = rPr.attrs.u.startsWith("dbl") ? "double" : "single";
  if (rPr.attrs.strike !== undefined) out.strike = rPr.attrs.strike !== "noStrike";
  if (rPr.attrs.cap !== undefined && rPr.attrs.cap !== "none") out.caps = rPr.attrs.cap === "small" ? "small" : "all";
  if (rPr.attrs.baseline !== undefined) out.baseline = Number(rPr.attrs.baseline) / 1000;
  if (rPr.attrs.spc !== undefined) out.spacing = hundredthsToPt(Number(rPr.attrs.spc));
  const color = parseColor(kid(rPr, "a:solidFill"), ctx);
  if (color) out.color = color.color;
  const face = kid(rPr, "a:latin")?.attrs.typeface;
  if (face) out.fontName = face === "+mj-lt" ? ctx.theme.major : face === "+mn-lt" ? ctx.theme.minor : face.startsWith("+") ? undefined : face;
  const hyperlink = kid(rPr, "a:hlinkClick");
  const rel = hyperlink?.attrs["r:id"] ? rels.get(hyperlink.attrs["r:id"]) : undefined;
  if (rel?.external) out.link = rel.target;
  else if (rel && rel.type.endsWith("/slide")) out.linkSlide = rel.target;
  return out;
}

const defined = <T extends object>(value: T): Partial<T> => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;

export function mergeRunStyle(base: RunStyle, over: RunStyle): RunStyle {
  return { ...base, ...defined(over) };
}

function mergeBullet(base: BulletDef | undefined, over: BulletDef | undefined): BulletDef | undefined {
  if (!over) return base;
  if (over.kind === "inherit") return base ? { ...base, ...defined({ font: over.font, color: over.color, sizePct: over.sizePct }) } : undefined;
  return { ...over, font: over.font ?? base?.font, color: over.color ?? base?.color, sizePct: over.sizePct ?? base?.sizePct };
}

export function mergeParaStyle(base: ParaStyle, over: ParaStyle): ParaStyle {
  const { bullet, ...rest } = over;
  const merged: ParaStyle = { ...base, ...defined(rest) };
  const mergedBullet = mergeBullet(base.bullet, bullet);
  if (mergedBullet) merged.bullet = mergedBullet;
  return merged;
}

export function mergeLevel(base: LevelStyle, over: LevelStyle | undefined): LevelStyle {
  if (!over) return base;
  return { para: mergeParaStyle(base.para, over.para), run: mergeRunStyle(base.run, over.run) };
}

function spacing(node: XNode | undefined): { pct?: number; pts?: number } {
  if (!node) return {};
  const pct = kid(node, "a:spcPct");
  const pts = kid(node, "a:spcPts");
  return { pct: pct ? num(pct, "val", 0) / 100000 : undefined, pts: pts ? num(pts, "val", 0) / 100 : undefined };
}

/** The paragraph and run defaults of one level (an <a:lvl1pPr>, or a paragraph's own <a:pPr>). */
export function parseLevelStyle(node: XNode | undefined, ctx: ColorContext, rels: Map<string, Relationship>): LevelStyle {
  const para: ParaStyle = {};
  if (!node) return { para, run: {} };
  if (node.attrs.algn) para.align = node.attrs.algn === "ctr" || node.attrs.algn === "r" || node.attrs.algn === "just" || node.attrs.algn === "dist" ? node.attrs.algn : "l";
  if (node.attrs.marL !== undefined) para.marL = Number(node.attrs.marL) / 12700;
  if (node.attrs.marR !== undefined) para.marR = Number(node.attrs.marR) / 12700;
  if (node.attrs.indent !== undefined) para.indent = Number(node.attrs.indent) / 12700;
  if (node.attrs.defTabSz !== undefined) para.defTab = Number(node.attrs.defTabSz) / 12700;
  const line = spacing(kid(node, "a:lnSpc"));
  if (line.pct !== undefined) para.lnPct = line.pct;
  if (line.pts !== undefined) para.lnPts = line.pts;
  const before = spacing(kid(node, "a:spcBef"));
  if (before.pct !== undefined) para.spcBefPct = before.pct;
  if (before.pts !== undefined) para.spcBefPts = before.pts;
  const after = spacing(kid(node, "a:spcAft"));
  if (after.pct !== undefined) para.spcAftPct = after.pct;
  if (after.pts !== undefined) para.spcAftPts = after.pts;

  const bulletColor = parseColor(kid(node, "a:buClr"), ctx)?.color;
  const bulletFont = kid(node, "a:buFont")?.attrs.typeface;
  const sizeNode = kid(node, "a:buSzPct");
  const bulletSize = sizeNode ? num(sizeNode, "val", 100000) / 100000 : undefined;
  const common = { font: bulletFont, color: bulletColor, sizePct: bulletSize };
  const autoNumber = kid(node, "a:buAutoNum");
  const character = kid(node, "a:buChar");
  if (kid(node, "a:buNone")) para.bullet = { kind: "none" };
  else if (character) para.bullet = { kind: "char", char: character.attrs.char ?? "•", ...common };
  else if (autoNumber) para.bullet = { kind: "auto", autoType: autoNumber.attrs.type ?? "arabicPeriod", startAt: num(autoNumber, "startAt", 1), ...common };
  else if (bulletColor || bulletFont || bulletSize !== undefined) para.bullet = { kind: "inherit", ...common };
  return { para, run: parseRunStyle(kid(node, "a:defRPr"), ctx, rels) };
}

/** The nine level styles of a list-style element (<a:lstStyle>, a master's titleStyle...). */
export function parseListStyle(node: XNode | undefined, ctx: ColorContext, rels: Map<string, Relationship>): (LevelStyle | undefined)[] {
  const out: (LevelStyle | undefined)[] = [];
  for (let level = 1; level <= 9; level += 1) {
    const found = kid(node, `a:lvl${level}pPr`);
    out.push(found ? parseLevelStyle(found, ctx, rels) : undefined);
  }
  return out;
}
