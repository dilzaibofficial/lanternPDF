/** Text bodies of slides: the paragraphs, their inherited styles, bullets and numbering. */
import type { Relationship } from "../package";
import type { Warnings } from "../warnings";
import { type XNode, elements, kid, kids, num, textOf } from "../xml";
import { type ColorContext, mergeLevel, mergeRunStyle, parseLevelStyle, parseRunStyle } from "./dml";
import type { LevelStyle, ParagraphItem, ParagraphM, RunStyle, TextBodyM } from "./model";

/** Everything needed to read the XML of one part. */
export interface Env {
  part: string;
  rels: Map<string, Relationship>;
  ctx: ColorContext;
}

/** What a <a:bodyPr> sets; anything it leaves out is inherited from the layout or master. */
export interface BodyPartial {
  l?: number;
  t?: number;
  r?: number;
  b?: number;
  anchor?: TextBodyM["anchor"];
  wrap?: boolean;
  autofit?: TextBodyM["autofit"];
  fontScale?: number;
  lnReduction?: number;
  vert?: TextBodyM["vert"];
}

export function parseBodyProps(bodyPr: XNode | undefined, warnings: Warnings): BodyPartial {
  const out: BodyPartial = {};
  if (!bodyPr) return out;
  if (bodyPr.attrs.lIns !== undefined) out.l = Number(bodyPr.attrs.lIns) / 12700;
  if (bodyPr.attrs.tIns !== undefined) out.t = Number(bodyPr.attrs.tIns) / 12700;
  if (bodyPr.attrs.rIns !== undefined) out.r = Number(bodyPr.attrs.rIns) / 12700;
  if (bodyPr.attrs.bIns !== undefined) out.b = Number(bodyPr.attrs.bIns) / 12700;
  if (bodyPr.attrs.anchor) out.anchor = bodyPr.attrs.anchor === "ctr" ? "ctr" : bodyPr.attrs.anchor === "b" ? "b" : "t";
  if (bodyPr.attrs.wrap) out.wrap = bodyPr.attrs.wrap !== "none";
  const vert = bodyPr.attrs.vert;
  if (vert === "vert") out.vert = "vert";
  else if (vert === "vert270") out.vert = "vert270";
  else if (vert === "horz") out.vert = "horz";
  else if (vert === "eaVert" || vert === "wordArtVert" || vert === "wordArtVertRtl" || vert === "mongolianVert") {
    out.vert = "horz";
    warnings.add("vertical-text");
  }
  if (kid(bodyPr, "a:noAutofit")) out.autofit = "none";
  const normal = kid(bodyPr, "a:normAutofit");
  if (normal) {
    out.autofit = "norm";
    out.fontScale = num(normal, "fontScale", 100000) / 100000;
    out.lnReduction = num(normal, "lnSpcReduction", 0) / 100000;
  }
  if (kid(bodyPr, "a:spAutoFit")) out.autofit = "shape";
  if (num(bodyPr, "numCol", 1) > 1) warnings.add("columns");
  const warp = kid(bodyPr, "a:prstTxWarp")?.attrs.prst;
  if (warp && warp !== "textNoShape") warnings.add("wordart");
  return out;
}

/** Puts body properties from the master, layout and slide on top of each other (later ones win). */
export function resolveBody(...parts: (BodyPartial | undefined)[]): Omit<TextBodyM, "paragraphs"> {
  const merged: BodyPartial = {};
  for (const part of parts) {
    if (!part) continue;
    for (const [key, value] of Object.entries(part)) if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return {
    insets: { l: merged.l ?? 7.2, t: merged.t ?? 3.6, r: merged.r ?? 7.2, b: merged.b ?? 3.6 },
    anchor: merged.anchor ?? "t",
    wrap: merged.wrap ?? true,
    autofit: merged.autofit ?? "none",
    fontScale: merged.fontScale ?? 1,
    lnReduction: merged.lnReduction ?? 0,
    vert: merged.vert ?? "horz",
  };
}

/** Nine level styles from several sources, each laid over the one before. */
export function mergeLevels(...sources: ((LevelStyle | undefined)[] | undefined)[]): LevelStyle[] {
  const out: LevelStyle[] = [];
  for (let level = 0; level < 9; level += 1) {
    let acc: LevelStyle = { para: {}, run: {} };
    for (const source of sources) acc = mergeLevel(acc, source?.[level]);
    out.push(acc);
  }
  return out;
}

const ROMAN: [number, string][] = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

function roman(value: number): string {
  let rest = Math.max(1, Math.min(3999, value));
  let out = "";
  for (const [size, letters] of ROMAN) {
    while (rest >= size) {
      out += letters;
      rest -= size;
    }
  }
  return out;
}

/** The text of an automatic number, such as "3.", "(b)" or "IV)". */
export function formatNumber(type: string, value: number): string {
  let body: string;
  if (type.startsWith("roman")) body = roman(value);
  else if (type.startsWith("alpha")) body = String.fromCharCode(97 + ((value - 1) % 26)).repeat(Math.floor((value - 1) / 26) + 1);
  else if (type.startsWith("circleNum")) body = value >= 1 && value <= 20 ? String.fromCodePoint(0x2460 + value - 1) : String(value);
  else body = String(value);
  if (type.includes("Uc")) body = body.toUpperCase();
  if (type.endsWith("ParenBoth")) return `(${body})`;
  if (type.endsWith("ParenR")) return `${body})`;
  if (type.endsWith("Plain") || type.startsWith("circleNum")) return body;
  return `${body}.`;
}

/** Reads the paragraphs of a text body. `levels` are the nine inherited level styles for this shape. */
export function parseParagraphs(txBody: XNode | undefined, env: Env, levels: readonly LevelStyle[]): ParagraphM[] {
  const paragraphs: ParagraphM[] = [];
  const hyperlink = env.ctx.theme.colors[env.ctx.colorMap.hlink ?? "hlink"];
  for (const p of kids(txBody, "a:p")) {
    const pPr = kid(p, "a:pPr");
    const level = Math.min(8, Math.max(0, num(pPr, "lvl", 0)));
    const base = levels[level] ?? { para: {}, run: {} };
    const own = parseLevelStyle(pPr, env.ctx, env.rels);
    const style = mergeLevel(base, own);
    const withLinkColor = (run: RunStyle): RunStyle => (run.link || run.linkSlide ? { ...run, color: hyperlink ?? run.color, underline: run.underline ?? "single" } : run);
    const items: ParagraphItem[] = [];
    for (const child of elements(p)) {
      if (child.name === "a:r") {
        const text = textOf(kid(child, "a:t"));
        const run = withLinkColor(mergeRunStyle(style.run, parseRunStyle(kid(child, "a:rPr"), env.ctx, env.rels)));
        if (text !== "") items.push({ kind: "run", text, style: run });
      } else if (child.name === "a:br") {
        items.push({ kind: "break", style: mergeRunStyle(style.run, parseRunStyle(kid(child, "a:rPr"), env.ctx, env.rels)) });
      } else if (child.name === "a:fld") {
        const run = withLinkColor(mergeRunStyle(style.run, parseRunStyle(kid(child, "a:rPr"), env.ctx, env.rels)));
        items.push({ kind: "field", slideNumber: child.attrs.type === "slidenum", text: textOf(kid(child, "a:t")), style: run });
      }
    }
    const endRun = mergeRunStyle(style.run, parseRunStyle(kid(p, "a:endParaRPr"), env.ctx, env.rels));
    paragraphs.push({ items, style: style.para, run: endRun, level });
  }

  // Automatic numbers count up over consecutive paragraphs of the same level.
  const counters: (number | undefined)[] = Array.from({ length: 9 }, () => undefined);
  for (const paragraph of paragraphs) {
    const hasText = paragraph.items.some((item) => item.kind !== "run" || item.text.trim() !== "");
    for (let deeper = paragraph.level + 1; deeper < 9; deeper += 1) counters[deeper] = undefined;
    const bullet = paragraph.style.bullet;
    if (bullet?.kind === "auto") {
      const next = counters[paragraph.level] === undefined ? (bullet.startAt ?? 1) : (counters[paragraph.level] as number) + 1;
      counters[paragraph.level] = next;
      paragraph.number = next;
    } else if (hasText) {
      counters[paragraph.level] = undefined;
    }
  }
  return paragraphs;
}
