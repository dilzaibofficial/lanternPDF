/** The Word style sheet: defaults, style inheritance, the theme, table styles and list numbering. */
import type { OfficePackage } from "../package";
import { type XNode, kid, kids, num } from "../xml";
import { type PropContext, mergePara, mergeRun, onOff, parseBorders, parseCellProps, parseParaProps, parseRunProps, parseTableProps } from "./props";
import type { AbstractNumbering, CellProps, NumberingInstance, NumberingLevel, ParaProps, RunProps, StyleDef, TableProps, ThemeInfo } from "./types";

const EMPTY_PARA: ParaProps = {};
const EMPTY_RUN: RunProps = {};

function parseTheme(pack: OfficePackage): ThemeInfo {
  const theme: ThemeInfo = { colors: {} };
  const part = pack.list("word/theme/").find((name) => name.endsWith(".xml"));
  const root = part ? pack.xml(part) : undefined;
  const elements = kid(root, "a:themeElements");
  const scheme = kid(elements, "a:clrScheme");
  for (const child of scheme?.children ?? []) {
    if (typeof child === "string") continue;
    const key = child.name.replace("a:", "");
    const srgb = kid(child, "a:srgbClr");
    const sys = kid(child, "a:sysClr");
    const value = srgb?.attrs.val ?? sys?.attrs.lastClr;
    if (value && /^[0-9a-fA-F]{6}$/.test(value)) theme.colors[key] = `#${value.toLowerCase()}`;
  }
  const fonts = kid(elements, "a:fontScheme");
  theme.major = kid(kid(fonts, "a:majorFont"), "a:latin")?.attrs.typeface || undefined;
  theme.minor = kid(kid(fonts, "a:minorFont"), "a:latin")?.attrs.typeface || undefined;
  return theme;
}

interface ConditionStyle {
  para: ParaProps;
  run: RunProps;
  cell: CellProps;
}

export interface ResolvedTableStyle {
  table: TableProps;
  cell: CellProps;
  para: ParaProps;
  run: RunProps;
  conditions: Map<string, ConditionStyle>;
}

function mergeCell(base: CellProps, over: CellProps): CellProps {
  const out: CellProps = { ...base };
  if (over.shading !== undefined) out.shading = over.shading;
  if (over.vAlign) out.vAlign = over.vAlign;
  if (over.borders) out.borders = { ...(base.borders ?? {}), ...over.borders };
  if (over.margins) out.margins = { ...(base.margins ?? {}), ...over.margins };
  return out;
}

export class Stylesheet {
  readonly ctx: PropContext;
  private readonly styles = new Map<string, StyleDef>();
  private docRun: RunProps = EMPTY_RUN;
  private docPara: ParaProps = EMPTY_PARA;
  private defaultParagraph?: string;
  private defaultTable?: string;
  readonly abstractNumbering = new Map<number, AbstractNumbering>();
  readonly numbering = new Map<number, NumberingInstance>();
  private readonly paragraphCache = new Map<string, { para: ParaProps; run: RunProps }>();
  private readonly characterCache = new Map<string, RunProps>();
  private readonly tableCache = new Map<string, ResolvedTableStyle>();

  private constructor(readonly theme: ThemeInfo) {
    this.ctx = { theme };
  }

  static load(pack: OfficePackage): Stylesheet {
    const sheet = new Stylesheet(parseTheme(pack));
    const root = pack.xml("word/styles.xml");
    if (root) sheet.readStyles(root);
    const numbering = pack.xml("word/numbering.xml");
    if (numbering) sheet.readNumbering(numbering);
    return sheet;
  }

  private readStyles(root: XNode): void {
    const defaults = kid(root, "w:docDefaults");
    this.docRun = parseRunProps(kid(kid(defaults, "w:rPrDefault"), "w:rPr"), this.ctx);
    this.docPara = parseParaProps(kid(kid(defaults, "w:pPrDefault"), "w:pPr"), this.ctx);
    for (const node of kids(root, "w:style")) {
      const id = node.attrs["w:styleId"];
      const type = node.attrs["w:type"];
      if (!id || (type !== "paragraph" && type !== "character" && type !== "table" && type !== "numbering")) continue;
      const style: StyleDef = {
        id,
        type,
        basedOn: kid(node, "w:basedOn")?.attrs["w:val"],
        isDefault: node.attrs["w:default"] === "1" || node.attrs["w:default"] === "true",
        para: parseParaProps(kid(node, "w:pPr"), this.ctx),
        run: parseRunProps(kid(node, "w:rPr"), this.ctx),
        conditions: new Map(),
      };
      if (type === "table") {
        style.table = parseTableProps(kid(node, "w:tblPr"), this.ctx);
        style.cell = parseCellProps(kid(node, "w:tcPr"), this.ctx);
        for (const conditional of kids(node, "w:tblStylePr")) {
          const kind = conditional.attrs["w:type"];
          if (!kind) continue;
          style.conditions.set(kind, {
            para: parseParaProps(kid(conditional, "w:pPr"), this.ctx),
            run: parseRunProps(kid(conditional, "w:rPr"), this.ctx),
            cell: parseCellProps(kid(conditional, "w:tcPr"), this.ctx),
          });
          // Borders can also sit in the conditional table properties.
          const tblBorders = parseBorders(kid(kid(conditional, "w:tblPr"), "w:tblBorders"), this.ctx);
          if (tblBorders) {
            const existing = style.conditions.get(kind) as ConditionStyle;
            existing.cell = mergeCell(existing.cell, { borders: tblBorders });
          }
        }
      }
      this.styles.set(id, style);
      if (style.isDefault && type === "paragraph") this.defaultParagraph = id;
      if (style.isDefault && type === "table") this.defaultTable = id;
    }
  }

  private chain(id: string | undefined, type: StyleDef["type"]): StyleDef[] {
    const out: StyleDef[] = [];
    const seen = new Set<string>();
    let current = id ? this.styles.get(id) : undefined;
    while (current && !seen.has(current.id) && current.type === type) {
      seen.add(current.id);
      out.unshift(current);
      current = current.basedOn ? this.styles.get(current.basedOn) : undefined;
    }
    return out;
  }

  /**
   * Document defaults, then (inside a table) the table style's own text formatting, then the paragraph style and
   * everything it is based on. That is the order Word applies them in.
   */
  paragraphStyle(id?: string, below?: { para: ParaProps; run: RunProps }): { para: ParaProps; run: RunProps } {
    const key = id ?? this.defaultParagraph ?? "";
    const cached = below ? undefined : this.paragraphCache.get(key);
    if (cached) return cached;
    let para = this.docPara;
    let run = this.docRun;
    if (below) {
      para = mergePara(para, below.para);
      run = mergeRun(run, below.run);
    }
    for (const style of this.chain(key || undefined, "paragraph")) {
      para = mergePara(para, style.para);
      run = mergeRun(run, style.run);
    }
    const result = { para, run };
    if (!below) this.paragraphCache.set(key, result);
    return result;
  }

  characterStyle(id: string): RunProps {
    const cached = this.characterCache.get(id);
    if (cached) return cached;
    let run: RunProps = {};
    for (const style of this.chain(id, "character")) run = mergeRun(run, style.run);
    this.characterCache.set(id, run);
    return run;
  }

  defaultRun(): RunProps {
    return this.docRun;
  }

  tableStyle(id?: string): ResolvedTableStyle {
    const key = id ?? this.defaultTable ?? "";
    const cached = this.tableCache.get(key);
    if (cached) return cached;
    let table: TableProps = {};
    let cell: CellProps = {};
    let para: ParaProps = {};
    let run: RunProps = {};
    const conditions = new Map<string, ConditionStyle>();
    for (const style of this.chain(key || undefined, "table")) {
      if (style.table) {
        table = { ...table, ...style.table, borders: { ...(table.borders ?? {}), ...(style.table.borders ?? {}) }, cellMargins: { ...(table.cellMargins ?? {}), ...(style.table.cellMargins ?? {}) } };
      }
      if (style.cell) cell = mergeCell(cell, style.cell);
      para = mergePara(para, style.para);
      run = mergeRun(run, style.run);
      for (const [kind, condition] of style.conditions) {
        const existing = conditions.get(kind);
        conditions.set(kind, existing ? { para: mergePara(existing.para, condition.para), run: mergeRun(existing.run, condition.run), cell: mergeCell(existing.cell, condition.cell) } : condition);
      }
    }
    const result: ResolvedTableStyle = { table, cell, para, run, conditions };
    this.tableCache.set(key, result);
    return result;
  }

  // ---- numbering ----------------------------------------------------------------------------------------

  private readNumbering(root: XNode): void {
    for (const abstract of kids(root, "w:abstractNum")) {
      const id = num(abstract, "w:abstractNumId", -1);
      if (id < 0) continue;
      const levels: NumberingLevel[] = [];
      for (const lvl of kids(abstract, "w:lvl")) {
        const index = num(lvl, "w:ilvl", levels.length);
        levels[index] = this.readLevel(lvl);
      }
      this.abstractNumbering.set(id, { id, levels });
    }
    for (const instance of kids(root, "w:num")) {
      const numId = num(instance, "w:numId", -1);
      const abstractId = num(kid(instance, "w:abstractNumId"), "w:val", -1);
      if (numId < 0 || abstractId < 0) continue;
      const overrides = new Map<number, { start?: number }>();
      for (const override of kids(instance, "w:lvlOverride")) {
        const level = num(override, "w:ilvl", 0);
        const start = kid(override, "w:startOverride");
        overrides.set(level, { start: start ? num(start, "w:val", 1) : undefined });
        const replacement = kid(override, "w:lvl");
        if (replacement) {
          const abstract = this.abstractNumbering.get(abstractId);
          if (abstract) abstract.levels[level] = this.readLevel(replacement);
        }
      }
      this.numbering.set(numId, { numId, abstractId, overrides });
    }
  }

  private readLevel(lvl: XNode): NumberingLevel {
    const justify = kid(lvl, "w:lvlJc")?.attrs["w:val"];
    const suffix = kid(lvl, "w:suff")?.attrs["w:val"];
    return {
      start: num(kid(lvl, "w:start"), "w:val", 1),
      format: kid(lvl, "w:numFmt")?.attrs["w:val"] ?? "decimal",
      text: kid(lvl, "w:lvlText")?.attrs["w:val"] ?? "",
      suffix: suffix === "space" ? "space" : suffix === "nothing" ? "nothing" : "tab",
      align: justify === "right" ? "right" : justify === "center" ? "center" : "left",
      para: parseParaProps(kid(lvl, "w:pPr"), this.ctx),
      run: parseRunProps(kid(lvl, "w:rPr"), this.ctx),
      legal: onOff(kid(lvl, "w:isLgl")) === true,
      restart: kid(lvl, "w:lvlRestart") ? num(kid(lvl, "w:lvlRestart"), "w:val", 0) : undefined,
    };
  }

  level(numId: number, level: number): { level: NumberingLevel; key: string } | undefined {
    const instance = this.numbering.get(numId);
    if (!instance) return undefined;
    const abstract = this.abstractNumbering.get(instance.abstractId);
    const found = abstract?.levels[level];
    if (!found) return undefined;
    // An instance that restarts a level gets its own counters; the others share their abstract list.
    const own = instance.overrides.size > 0;
    return { level: found, key: own ? `n${numId}` : `a${instance.abstractId}` };
  }

  startFor(numId: number, level: number, fallback: number): number {
    return this.numbering.get(numId)?.overrides.get(level)?.start ?? fallback;
  }
}

// ---- list numbering text ---------------------------------------------------------------------------------

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
  for (const [size, text] of ROMAN) {
    while (rest >= size) {
      out += text;
      rest -= size;
    }
  }
  return out;
}

function letters(value: number): string {
  let rest = Math.max(1, value);
  let out = "";
  while (rest > 0) {
    rest -= 1;
    out = String.fromCharCode(97 + (rest % 26)) + out;
    rest = Math.floor(rest / 26);
  }
  return out;
}

export function formatNumber(value: number, format: string): string {
  switch (format) {
    case "decimalZero":
      return String(value).padStart(2, "0");
    case "lowerLetter":
      return letters(value);
    case "upperLetter":
      return letters(value).toUpperCase();
    case "lowerRoman":
      return roman(value);
    case "upperRoman":
      return roman(value).toUpperCase();
    case "ordinal": {
      const tail = value % 100;
      const suffix = tail >= 11 && tail <= 13 ? "th" : ["th", "st", "nd", "rd"][value % 10 > 3 ? 0 : value % 10];
      return `${value}${suffix}`;
    }
    case "decimalEnclosedCircle":
      return value >= 1 && value <= 20 ? String.fromCodePoint(0x2460 + value - 1) : String(value);
    case "none":
      return "";
    default:
      return String(value);
  }
}

/** Counters for every list in a document, so that "1.", "2." and "a)" come out as Word shows them. */
export class NumberingCounters {
  private readonly counters = new Map<string, (number | undefined)[]>();

  constructor(private readonly sheet: Stylesheet) {}

  /** Advances a list at a level and returns the text of its marker, or undefined when the list is unknown. */
  marker(numId: number, level: number): { text: string; level: NumberingLevel } | undefined {
    const found = this.sheet.level(numId, level);
    if (!found) return undefined;
    const { level: definition, key } = found;
    if (definition.format === "bullet") return { text: definition.text || "•", level: definition };
    const counts = this.counters.get(key) ?? [];
    this.counters.set(key, counts);
    const start = this.sheet.startFor(numId, level, definition.start);
    counts[level] = counts[level] === undefined ? start : (counts[level] as number) + 1;
    for (let deeper = level + 1; deeper < 9; deeper += 1) counts[deeper] = undefined;
    const text = definition.text.replace(/%([1-9])/g, (_, digit: string) => {
      const index = Number(digit) - 1;
      const levelDefinition = this.sheet.level(numId, index)?.level;
      const value = counts[index] ?? levelDefinition?.start ?? 1;
      return formatNumber(value, definition.legal ? "decimal" : (levelDefinition?.format ?? "decimal"));
    });
    return { text, level: definition };
  }
}
