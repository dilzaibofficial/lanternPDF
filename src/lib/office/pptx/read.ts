/** Reads a PowerPoint (.pptx) file into slides whose shapes already carry what their layout, master and theme give them. */
import { AppError } from "../../errors";
import type { OfficePackage, Relationship } from "../package";
import { type Theme, readThemePart } from "../theme";
import { Warnings } from "../warnings";
import { type XNode, descendants, dig, elements, kid, kids, num, textOf } from "../xml";
import { type ColorContext, type LinePartial, applyLine, defaultColorMap, parseColor, parseCrop, parseFill, parseLinePartial, parseListStyle, themeFill, themeLine } from "./dml";
import { appendArcTo, isKnownPreset } from "./geometry";
import type { CustomPath, FillDef, GeometryM, LevelStyle, LineDef, LinkInfo, PresentationM, RunStyle, ShapeM, SlideM, TableCellM, TableRowM, TextBodyM, Transform } from "./model";
import { type CellLook, type TableFlags, TableStyles, cellLook, parseTableStyle } from "./tablestyles";
import { type BodyPartial, type Env, mergeLevels, parseBodyProps, parseParagraphs, resolveBody } from "./text";

type Compose = (t: Transform) => Transform;
const identity: Compose = (t) => t;

const local = (name: string): string => name.slice(name.indexOf(":") + 1);

/** The first child whose tag is `name` whatever its prefix (PowerPoint's "p:" and SmartArt's "dsp:" share names). */
function child(node: XNode | undefined, name: string): XNode | undefined {
  for (const candidate of elements(node)) if (local(candidate.name) === name) return candidate;
  return undefined;
}

const truthy = (value: string | undefined): boolean => value === "1" || value === "true";

function parseXfrm(node: XNode | undefined): Transform | undefined {
  const off = kid(node, "a:off");
  const ext = kid(node, "a:ext");
  if (!node || !off || !ext) return undefined;
  return { x: num(off, "x", 0) / 12700, y: num(off, "y", 0) / 12700, w: num(ext, "cx", 0) / 12700, h: num(ext, "cy", 0) / 12700, rot: num(node, "rot", 0) / 60000, flipH: truthy(node.attrs.flipH), flipV: truthy(node.attrs.flipV) };
}

interface GroupFrame {
  off: { x: number; y: number };
  ext: { w: number; h: number };
  chOff: { x: number; y: number };
  chExt: { w: number; h: number };
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

/** Maps a shape from a group's own coordinate space into the space the group sits in. */
function composeGroup(group: GroupFrame, t: Transform): Transform {
  const sx = group.chExt.w ? group.ext.w / group.chExt.w : 1;
  const sy = group.chExt.h ? group.ext.h / group.chExt.h : 1;
  const w = t.w * sx;
  const h = t.h * sy;
  let cx = group.off.x + (t.x - group.chOff.x) * sx + w / 2;
  let cy = group.off.y + (t.y - group.chOff.y) * sy + h / 2;
  let { rot, flipH, flipV } = t;
  const gx = group.off.x + group.ext.w / 2;
  const gy = group.off.y + group.ext.h / 2;
  if (group.flipH) {
    cx = 2 * gx - cx;
    flipH = !flipH;
    rot = -rot;
  }
  if (group.flipV) {
    cy = 2 * gy - cy;
    flipV = !flipV;
    rot = -rot;
  }
  if (group.rot) {
    const angle = (group.rot * Math.PI) / 180;
    const dx = cx - gx;
    const dy = cy - gy;
    cx = gx + dx * Math.cos(angle) - dy * Math.sin(angle);
    cy = gy + dx * Math.sin(angle) + dy * Math.cos(angle);
    rot += group.rot;
  }
  return { x: cx - w / 2, y: cy - h / 2, w, h, rot: ((rot % 360) + 360) % 360, flipH, flipV };
}

type PhKind = "title" | "body" | "dt" | "ftr" | "sldNum" | "hdr";

const phKindOf = (type: string | undefined): PhKind => (type === "title" || type === "ctrTitle" ? "title" : type === "dt" ? "dt" : type === "ftr" ? "ftr" : type === "sldNum" ? "sldNum" : type === "hdr" ? "hdr" : "body");

/** A placeholder as defined on a layout or master: what a slide's placeholder inherits. */
interface PhInfo {
  kind: PhKind;
  idx?: string;
  xf?: Transform;
  geometry?: GeometryM;
  fill?: FillDef;
  line?: LinePartial;
  body: BodyPartial;
  levels: (LevelStyle | undefined)[];
}

function matchPlaceholder(list: readonly PhInfo[], kind: PhKind, idx: string | undefined): PhInfo | undefined {
  if (idx !== undefined) {
    const byIndex = list.find((entry) => entry.idx === idx && entry.kind === kind) ?? list.find((entry) => entry.idx === idx);
    if (byIndex) return byIndex;
  }
  return list.find((entry) => entry.kind === kind);
}

interface TextStyles {
  title: (LevelStyle | undefined)[];
  body: (LevelStyle | undefined)[];
  other: (LevelStyle | undefined)[];
}

const roleOf = (kind: PhKind): keyof TextStyles => (kind === "title" ? "title" : kind === "body" ? "body" : "other");

interface Template {
  background: FillDef | null | undefined;
  masterShapes: ShapeM[];
  layoutShapes: ShapeM[];
  masterPh: PhInfo[];
  layoutPh: PhInfo[];
  textStyles: TextStyles;
  defaultLevels: (LevelStyle | undefined)[];
  showMasterShapes: boolean;
}

interface TreeState {
  env: Env;
  kind: "master" | "layout" | "slide";
  out: ShapeM[];
  placeholders: PhInfo[];
  layoutPh: readonly PhInfo[];
  masterPh: readonly PhInfo[];
  textStyles: TextStyles;
  defaultLevels: (LevelStyle | undefined)[];
}

const firstDefined = <T>(...values: (T | undefined)[]): T | undefined => values.find((value) => value !== undefined);

function thicker(a: LineDef | null | undefined, b: LineDef | null | undefined): LineDef | null | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return (b?.width ?? 0) > (a?.width ?? 0) ? b : a;
}

const RECT: GeometryM = { kind: "preset", name: "rect", adjust: {} };

export class PptxReader {
  private readonly media = new Map<string, { bytes: Uint8Array }>();
  private readonly templates = new Map<string, Template>();
  private readonly themes = new Map<string, Theme>();
  private readonly tableStyles: TableStyles;
  private presentationRels = new Map<string, Relationship>();
  private defaultTextStyle: XNode | undefined;
  private readonly quiet = new Warnings();

  constructor(
    private readonly pack: OfficePackage,
    private readonly warnings: Warnings,
  ) {
    this.tableStyles = new TableStyles(pack);
  }

  read(): PresentationM {
    const root = this.pack.xml("ppt/presentation.xml");
    if (!root) throw new AppError("INVALID_FILE", "This presentation has no slide list, so there is nothing to convert.");
    this.presentationRels = this.pack.relationships("ppt/presentation.xml");
    this.defaultTextStyle = kid(root, "p:defaultTextStyle");
    const size = kid(root, "p:sldSz");
    const width = num(size, "cx", 9144000) / 12700;
    const height = num(size, "cy", 6858000) / 12700;
    const slides: SlideM[] = [];
    kids(kid(root, "p:sldIdLst"), "p:sldId").forEach((entry, index) => {
      const rel = this.presentationRels.get(entry.attrs["r:id"] ?? "");
      if (!rel || rel.external) return;
      slides.push(this.readSlide(rel.target, index + 1));
    });
    const core = this.pack.xml("docProps/core.xml");
    return {
      width: Math.max(72, width),
      height: Math.max(72, height),
      slides,
      media: this.media,
      title: textOf(child(core, "title")).trim() || undefined,
      author: textOf(child(core, "creator")).trim() || undefined,
    };
  }

  // ---- slides, layouts and masters ---------------------------------------------------------------------------

  private theme(part: string | undefined): Theme {
    const key = part ?? "";
    let theme = this.themes.get(key);
    if (!theme) {
      theme = readThemePart(this.pack, part);
      this.themes.set(key, theme);
    }
    return theme;
  }

  private readSlide(part: string, number: number): SlideM {
    const root = this.pack.xml(part);
    const rels = this.pack.relationships(part);
    const layoutPart = [...rels.values()].find((rel) => rel.type.endsWith("/slideLayout") && !rel.external)?.target;
    const layoutRoot = layoutPart ? this.pack.xml(layoutPart) : undefined;
    const layoutRels = layoutPart ? this.pack.relationships(layoutPart) : new Map<string, Relationship>();
    const masterPart = [...layoutRels.values()].find((rel) => rel.type.endsWith("/slideMaster") && !rel.external)?.target;
    const masterRoot = masterPart ? this.pack.xml(masterPart) : undefined;
    const masterRels = masterPart ? this.pack.relationships(masterPart) : new Map<string, Relationship>();
    const themePart = [...masterRels.values()].find((rel) => rel.type.endsWith("/theme") && !rel.external)?.target;

    // Colour mapping: the slide's own override wins, then the layout's, then the master's.
    const overrideOf = (node: XNode | undefined): Record<string, string> | undefined => {
      const override = kid(kid(node, "p:clrMapOvr"), "a:overrideClrMapping");
      return override ? { ...defaultColorMap(), ...override.attrs } : undefined;
    };
    const masterMap = kid(masterRoot, "p:clrMap")?.attrs;
    const colorMap = overrideOf(root) ?? overrideOf(layoutRoot) ?? (masterMap ? { ...defaultColorMap(), ...masterMap } : defaultColorMap());
    const ctx: ColorContext = { theme: this.theme(themePart), colorMap };

    const template = this.template(layoutPart, masterPart, ctx);
    const env: Env = { part, rels, ctx };
    const state: TreeState = { env, kind: "slide", out: [], placeholders: [], layoutPh: template.layoutPh, masterPh: template.masterPh, textStyles: template.textStyles, defaultLevels: template.defaultLevels };
    this.parseTree(dig(root, "p:cSld/p:spTree"), state, identity);

    const showTemplateShapes = root?.attrs.showMasterSp !== "0" && root?.attrs.showMasterSp !== "false";
    const background = this.background(root, env) ?? template.background ?? null;
    if (background) this.useFill(background);
    return {
      number,
      part,
      background,
      shapes: [...(showTemplateShapes && template.showMasterShapes ? template.masterShapes : []), ...(showTemplateShapes ? template.layoutShapes : []), ...state.out],
      hidden: root?.attrs.show === "0" || root?.attrs.show === "false",
    };
  }

  private template(layoutPart: string | undefined, masterPart: string | undefined, ctx: ColorContext): Template {
    const key = `${layoutPart ?? ""}|${masterPart ?? ""}|${JSON.stringify(ctx.colorMap)}|${ctx.theme.major ?? ""}`;
    const cached = this.templates.get(key);
    if (cached) return cached;

    const defaultLevels = parseListStyle(this.defaultTextStyle, ctx, this.presentationRels);
    const masterRoot = masterPart ? this.pack.xml(masterPart) : undefined;
    const masterRels = masterPart ? this.pack.relationships(masterPart) : new Map<string, Relationship>();
    const masterEnv: Env = { part: masterPart ?? "", rels: masterRels, ctx };
    const styles = kid(masterRoot, "p:txStyles");
    const textStyles: TextStyles = {
      title: parseListStyle(kid(styles, "p:titleStyle"), ctx, masterRels),
      body: parseListStyle(kid(styles, "p:bodyStyle"), ctx, masterRels),
      other: parseListStyle(kid(styles, "p:otherStyle"), ctx, masterRels),
    };
    const masterState: TreeState = { env: masterEnv, kind: "master", out: [], placeholders: [], layoutPh: [], masterPh: [], textStyles, defaultLevels };
    this.parseTree(dig(masterRoot, "p:cSld/p:spTree"), masterState, identity);

    const layoutRoot = layoutPart ? this.pack.xml(layoutPart) : undefined;
    const layoutRels = layoutPart ? this.pack.relationships(layoutPart) : new Map<string, Relationship>();
    const layoutEnv: Env = { part: layoutPart ?? "", rels: layoutRels, ctx };
    const layoutState: TreeState = { env: layoutEnv, kind: "layout", out: [], placeholders: [], layoutPh: [], masterPh: [], textStyles, defaultLevels };
    this.parseTree(dig(layoutRoot, "p:cSld/p:spTree"), layoutState, identity);

    const template: Template = {
      background: this.background(layoutRoot, layoutEnv) ?? this.background(masterRoot, masterEnv),
      masterShapes: masterState.out,
      layoutShapes: layoutState.out,
      masterPh: masterState.placeholders,
      layoutPh: layoutState.placeholders,
      textStyles,
      defaultLevels,
      showMasterShapes: layoutRoot?.attrs.showMasterSp !== "0" && layoutRoot?.attrs.showMasterSp !== "false",
    };
    this.templates.set(key, template);
    return template;
  }

  private background(root: XNode | undefined, env: Env): FillDef | null | undefined {
    const bg = dig(root, "p:cSld/p:bg");
    if (!bg) return undefined;
    const props = kid(bg, "p:bgPr");
    if (props) return parseFill(props, env.ctx, env.rels) ?? undefined;
    const ref = kid(bg, "p:bgRef");
    if (ref) return themeFill(env.ctx, num(ref, "idx", 0), env.rels, parseColor(ref, env.ctx)?.color);
    return undefined;
  }

  // ---- shape trees -------------------------------------------------------------------------------------------

  private parseTree(tree: XNode | undefined, state: TreeState, compose: Compose): void {
    for (const node of elements(tree)) {
      switch (node.name) {
        case "p:sp":
        case "p:cxnSp":
        case "dsp:sp":
          this.parseShape(node, state, compose);
          break;
        case "p:pic":
          this.parsePicture(node, state, compose);
          break;
        case "p:grpSp":
          this.parseGroup(node, state, compose);
          break;
        case "p:graphicFrame":
          this.parseFrame(node, state, compose);
          break;
        case "mc:AlternateContent": {
          // The fallback is the version every reader understands, usually a picture of what the newer feature shows.
          const choice = kid(node, "mc:Fallback") ?? kid(node, "mc:Choice");
          if (choice) this.parseTree(choice, state, compose);
          break;
        }
        default:
          break;
      }
    }
  }

  private useMedia(part: string): boolean {
    if (this.media.has(part)) return true;
    const bytes = this.pack.bytes(part);
    if (!bytes) return false;
    this.media.set(part, { bytes });
    return true;
  }

  private useFill(fill: FillDef | undefined | null): void {
    if (fill?.kind === "picture") this.useMedia(fill.part);
  }

  private linkOf(click: XNode | undefined, rels: Map<string, Relationship>): LinkInfo | undefined {
    const rel = click?.attrs["r:id"] ? rels.get(click.attrs["r:id"]) : undefined;
    if (!rel) return undefined;
    if (rel.external) return { uri: rel.target };
    if (rel.type.endsWith("/slide")) return { slide: rel.target };
    return undefined;
  }

  private geometryOf(spPr: XNode | undefined): GeometryM | undefined {
    const preset = kid(spPr, "a:prstGeom");
    if (preset) {
      const adjust: Record<string, number> = {};
      for (const guide of kids(kid(preset, "a:avLst"), "a:gd")) {
        const match = /^val\s+(-?\d+)/.exec(guide.attrs.fmla ?? "");
        if (guide.attrs.name && match) adjust[guide.attrs.name] = Number(match[1]);
      }
      return { kind: "preset", name: preset.attrs.prst ?? "rect", adjust };
    }
    const custom = kid(spPr, "a:custGeom");
    if (custom) {
      const paths = this.customPaths(custom);
      return paths.length > 0 ? { kind: "custom", paths } : RECT;
    }
    return undefined;
  }

  private customPaths(custom: XNode): CustomPath[] {
    const paths: CustomPath[] = [];
    for (const path of kids(kid(custom, "a:pathLst"), "a:path")) {
      const w = num(path, "w", 0);
      const h = num(path, "h", 0);
      const named: Record<string, number> = { l: 0, t: 0, r: w, b: h, w, h, hc: w / 2, vc: h / 2, wd2: w / 2, hd2: h / 2 };
      const value = (token: string | undefined): number => {
        if (token === undefined) return 0;
        const parsed = Number(token);
        return Number.isFinite(parsed) ? parsed : (named[token] ?? 0);
      };
      const point = (node: XNode | undefined): [number, number] => [value(node?.attrs.x), value(node?.attrs.y)];
      const built: CustomPath = { w, h, fill: path.attrs.fill !== "none", stroke: !(path.attrs.stroke === "0" || path.attrs.stroke === "false"), commands: [], points: [] };
      let current: [number, number] = [0, 0];
      let start: [number, number] = [0, 0];
      for (const command of elements(path)) {
        if (command.name === "a:moveTo") {
          const to = point(kid(command, "a:pt"));
          built.commands.push("M");
          built.points.push(...to);
          current = to;
          start = to;
        } else if (command.name === "a:lnTo") {
          const to = point(kid(command, "a:pt"));
          built.commands.push("L");
          built.points.push(...to);
          current = to;
        } else if (command.name === "a:cubicBezTo") {
          const points = kids(command, "a:pt").map(point);
          const last = points[2];
          if (points.length === 3 && last) {
            built.commands.push("C");
            built.points.push(...points.flat());
            current = last;
          }
        } else if (command.name === "a:quadBezTo") {
          const [control, end] = kids(command, "a:pt").map(point);
          if (control && end) {
            built.commands.push("C");
            built.points.push(current[0] + (2 / 3) * (control[0] - current[0]), current[1] + (2 / 3) * (control[1] - current[1]), end[0] + (2 / 3) * (control[0] - end[0]), end[1] + (2 / 3) * (control[1] - end[1]), end[0], end[1]);
            current = end;
          }
        } else if (command.name === "a:arcTo") {
          current = appendArcTo(built, current, value(command.attrs.wR), value(command.attrs.hR), num(command, "stAng", 0) / 60000, num(command, "swAng", 0) / 60000);
        } else if (command.name === "a:close") {
          built.commands.push("Z");
          current = start;
        }
      }
      if (built.commands.length > 0) paths.push(built);
    }
    return paths;
  }

  private parseShape(node: XNode, state: TreeState, compose: Compose): void {
    const nv = child(node, "nvSpPr") ?? child(node, "nvCxnSpPr");
    const cNvPr = child(nv, "cNvPr");
    if (truthy(cNvPr?.attrs.hidden)) return;
    const ph = kid(child(nv, "nvPr"), "p:ph");
    const spPr = child(node, "spPr");
    const style = child(node, "style");
    const txBody = child(node, "txBody");
    const { ctx, rels } = state.env;
    const isConnector = local(node.name) === "cxnSp";

    const ownTransform = parseXfrm(kid(spPr, "a:xfrm"));
    const ownXf = ownTransform ? compose(ownTransform) : undefined;
    const ownGeometry = this.geometryOf(spPr);

    // On a layout or master a placeholder only describes what slides inherit; it is not drawn itself.
    if (ph && state.kind !== "slide") {
      state.placeholders.push({
        kind: phKindOf(ph.attrs.type),
        idx: ph.attrs.idx,
        xf: ownXf,
        geometry: ownGeometry,
        fill: parseFill(spPr, ctx, rels),
        line: parseLinePartial(kid(spPr, "a:ln"), ctx, rels),
        body: parseBodyProps(kid(txBody, "a:bodyPr"), this.quiet),
        levels: parseListStyle(kid(txBody, "a:lstStyle"), ctx, rels),
      });
      return;
    }

    let layoutPh: PhInfo | undefined;
    let masterPh: PhInfo | undefined;
    if (ph) {
      const kind = phKindOf(ph.attrs.type);
      layoutPh = matchPlaceholder(state.layoutPh, kind, ph.attrs.idx);
      masterPh = state.masterPh.find((entry) => entry.kind === (layoutPh?.kind ?? kind));
    }
    const xf = ownXf ?? layoutPh?.xf ?? masterPh?.xf;
    if (!xf || (xf.w <= 0 && xf.h <= 0)) return;
    const geometry = ownGeometry ?? layoutPh?.geometry ?? masterPh?.geometry ?? (isConnector ? { kind: "preset" as const, name: "line", adjust: {} } : RECT);
    if (geometry.kind === "preset" && !isKnownPreset(geometry.name)) this.warnings.add("shape");

    const colorOf = (ref: XNode | undefined) => parseColor(ref, ctx)?.color;
    const fillRef = kid(style, "a:fillRef");
    const styleFill: FillDef | undefined = fillRef ? (num(fillRef, "idx", 0) > 0 ? themeFill(ctx, num(fillRef, "idx", 0), rels, colorOf(fillRef)) : { kind: "none" }) : undefined;
    const fill: FillDef = parseFill(spPr, ctx, rels) ?? layoutPh?.fill ?? masterPh?.fill ?? styleFill ?? { kind: "none" };
    const lineRef = kid(style, "a:lnRef");
    let line: LineDef | null = lineRef ? themeLine(ctx, num(lineRef, "idx", 0), rels, colorOf(lineRef)) : null;
    line = applyLine(line, masterPh?.line);
    line = applyLine(line, layoutPh?.line);
    line = applyLine(line, parseLinePartial(kid(spPr, "a:ln"), ctx, rels));
    this.useFill(fill);
    this.useFill(line?.fill);

    let text: TextBodyM | undefined;
    if (txBody) {
      const fontRef = kid(style, "a:fontRef");
      const fontColor = fontRef ? colorOf(fontRef) : undefined;
      const fontLevels: (LevelStyle | undefined)[] | undefined = fontColor ? Array.from({ length: 9 }, () => ({ para: {}, run: { color: fontColor } })) : undefined;
      const role = ph ? roleOf(phKindOf(ph.attrs.type)) : undefined;
      const levels = mergeLevels(state.defaultLevels, role ? state.textStyles[role] : undefined, fontLevels, masterPh?.levels, layoutPh?.levels, parseListStyle(kid(txBody, "a:lstStyle"), ctx, rels));
      const body = resolveBody(masterPh?.body, layoutPh?.body, parseBodyProps(kid(txBody, "a:bodyPr"), this.warnings));
      const paragraphs = parseParagraphs(txBody, state.env, levels);
      if (paragraphs.some((paragraph) => paragraph.items.length > 0)) text = { ...body, paragraphs };
    }

    const link = this.linkOf(kid(cNvPr, "a:hlinkClick"), rels);
    const effects = kid(spPr, "a:effectLst");
    if (effects && elements(effects).length > 0 && (fill.kind !== "none" || line || text)) this.warnings.add("effects");
    if (fill.kind === "none" && !line && !text && !link) return;
    const textTransform = parseXfrm(child(node, "txXfrm"));
    state.out.push({ kind: "shape", xf, geometry, fill, line, text, link, textXf: textTransform ? compose(textTransform) : undefined });
  }

  private parsePicture(node: XNode, state: TreeState, compose: Compose, fallback?: Transform): void {
    const nv = child(node, "nvPicPr");
    const cNvPr = child(nv, "cNvPr");
    if (truthy(cNvPr?.attrs.hidden)) return;
    const nvPr = child(nv, "nvPr");
    const ph = kid(nvPr, "p:ph");
    if (ph && state.kind !== "slide") return;
    if (kid(nvPr, "a:videoFile") || kid(nvPr, "a:audioFile") || kid(nvPr, "a:wavAudioFile")) this.warnings.add("video");
    const spPr = child(node, "spPr");
    const { ctx, rels } = state.env;
    const blipFill = child(node, "blipFill");
    const blip = kid(blipFill, "a:blip");
    const rel = blip?.attrs["r:embed"] ? rels.get(blip.attrs["r:embed"]) : undefined;
    if (!rel || rel.external || !this.useMedia(rel.target)) {
      this.warnings.add("image-broken");
      return;
    }
    let inherited: Transform | undefined;
    if (ph) {
      const layoutPh = matchPlaceholder(state.layoutPh, phKindOf(ph.attrs.type), ph.attrs.idx);
      inherited = layoutPh?.xf ?? state.masterPh.find((entry) => entry.kind === phKindOf(ph.attrs.type))?.xf;
    }
    const own = parseXfrm(kid(spPr, "a:xfrm"));
    const xf = own ? compose(own) : (fallback ?? inherited);
    if (!xf) return;
    const geometry = this.geometryOf(spPr);
    const line = applyLine(null, parseLinePartial(kid(spPr, "a:ln"), ctx, rels));
    this.useFill(line?.fill);
    state.out.push({
      kind: "picture",
      xf,
      part: rel.target,
      crop: parseCrop(kid(blipFill, "a:srcRect")),
      geometry: geometry && !(geometry.kind === "preset" && geometry.name === "rect") ? geometry : undefined,
      line,
      alpha: num(kid(blip, "a:alphaModFix"), "amt", 100000) / 100000,
      link: this.linkOf(kid(cNvPr, "a:hlinkClick"), rels),
    });
  }

  private parseGroup(node: XNode, state: TreeState, compose: Compose): void {
    const nv = child(node, "nvGrpSpPr");
    if (truthy(child(nv, "cNvPr")?.attrs.hidden)) return;
    const xfrm = kid(child(node, "grpSpPr"), "a:xfrm");
    const off = kid(xfrm, "a:off");
    const ext = kid(xfrm, "a:ext");
    const chOff = kid(xfrm, "a:chOff");
    const chExt = kid(xfrm, "a:chExt");
    if (!xfrm || !off || !ext) {
      this.parseTree(node, state, compose);
      return;
    }
    const frame: GroupFrame = {
      off: { x: num(off, "x", 0) / 12700, y: num(off, "y", 0) / 12700 },
      ext: { w: num(ext, "cx", 0) / 12700, h: num(ext, "cy", 0) / 12700 },
      chOff: { x: num(chOff, "x", 0) / 12700, y: num(chOff, "y", 0) / 12700 },
      chExt: { w: num(chExt, "cx", num(ext, "cx", 0)) / 12700, h: num(chExt, "cy", num(ext, "cy", 0)) / 12700 },
      rot: num(xfrm, "rot", 0) / 60000,
      flipH: truthy(xfrm.attrs.flipH),
      flipV: truthy(xfrm.attrs.flipV),
    };
    this.parseTree(node, state, (t) => compose(composeGroup(frame, t)));
  }

  private parseFrame(node: XNode, state: TreeState, compose: Compose): void {
    const nv = child(node, "nvGraphicFramePr");
    if (truthy(child(nv, "cNvPr")?.attrs.hidden)) return;
    const frame = parseXfrm(child(node, "xfrm"));
    if (!frame) return;
    const xf = compose(frame);
    const data = dig(node, "a:graphic/a:graphicData");
    const uri = data?.attrs.uri ?? "";
    if (uri.endsWith("/table")) {
      const table = kid(data, "a:tbl");
      const shape = table ? this.parseTable(table, xf, state) : null;
      if (shape) state.out.push(shape);
    } else if (uri.endsWith("/chart")) {
      this.warnings.add("chart");
    } else if (uri.endsWith("/diagram")) {
      this.parseDiagram(data, xf, state);
    } else {
      const picture = descendants(data, "p:pic")[0];
      if (picture) this.parsePicture(picture, state, compose, xf);
      else this.warnings.add("ole");
    }
  }

  /** SmartArt: PowerPoint saves the finished drawing next to the diagram data, so that is what gets drawn. */
  private parseDiagram(data: XNode | undefined, xf: Transform, state: TreeState): void {
    const ids = kid(data, "dgm:relIds");
    const dataRel = ids?.attrs["r:dm"] ? state.env.rels.get(ids.attrs["r:dm"]) : undefined;
    const dataRoot = dataRel && !dataRel.external ? this.pack.xml(dataRel.target) : undefined;
    const drawingId = descendants(dataRoot, "dsp:dataModelExt")[0]?.attrs.relId;
    const drawingRel = drawingId ? state.env.rels.get(drawingId) : undefined;
    const drawing = drawingRel && !drawingRel.external ? this.pack.xml(drawingRel.target) : undefined;
    const tree = kid(drawing, "dsp:spTree");
    if (!drawingRel || !tree) {
      this.warnings.add("smartart");
      return;
    }
    const env: Env = { part: drawingRel.target, rels: this.pack.relationships(drawingRel.target), ctx: state.env.ctx };
    this.parseTree(tree, { ...state, env }, (t) => ({ ...t, x: t.x + xf.x, y: t.y + xf.y }));
  }

  // ---- tables ------------------------------------------------------------------------------------------------

  private parseTable(table: XNode, xf: Transform, state: TreeState): ShapeM | null {
    const { ctx, rels } = state.env;
    const props = kid(table, "a:tblPr");
    const flags: TableFlags = {
      firstRow: truthy(props?.attrs.firstRow),
      lastRow: truthy(props?.attrs.lastRow),
      firstCol: truthy(props?.attrs.firstCol),
      lastCol: truthy(props?.attrs.lastCol),
      bandRow: truthy(props?.attrs.bandRow),
      bandCol: truthy(props?.attrs.bandCol),
    };
    const styleId = textOf(kid(props, "a:tableStyleId")).trim();
    const styleNode = this.tableStyles.find(styleId || undefined);
    if (styleId && !styleNode) this.warnings.add("table-style");
    const style = styleNode ? parseTableStyle(styleNode, ctx, rels) : {};
    const columns = kids(kid(table, "a:tblGrid"), "a:gridCol").map((column) => num(column, "w", 0) / 12700);
    const rows = kids(table, "a:tr");
    if (rows.length === 0 || columns.length === 0) return null;

    interface Raw {
      cell: TableCellM;
      look: CellLook;
      own: { l?: LineDef | null; r?: LineDef | null; t?: LineDef | null; b?: LineDef | null };
    }
    const grid: Raw[][] = rows.map((row, r) => {
      const cells = kids(row, "a:tc");
      return columns.map((_width, c): Raw => {
        const tc = cells[c];
        const tcPr = kid(tc, "a:tcPr");
        const look = cellLook(style, flags, r, c, rows.length, columns.length);
        const base: RunStyle = {};
        if (look.bold !== undefined) base.bold = look.bold;
        if (look.italic !== undefined) base.italic = look.italic;
        if (look.color) base.color = look.color;
        const levels = mergeLevels(
          state.defaultLevels,
          Array.from({ length: 9 }, () => ({ para: {}, run: base })),
        );
        const paragraphs = parseParagraphs(kid(tc, "a:txBody"), state.env, levels);
        const anchor = tcPr?.attrs.anchor === "ctr" ? "ctr" : tcPr?.attrs.anchor === "b" ? "b" : "t";
        const text: TextBodyM = {
          paragraphs,
          insets: { l: num(tcPr, "marL", 91440) / 12700, r: num(tcPr, "marR", 91440) / 12700, t: num(tcPr, "marT", 45720) / 12700, b: num(tcPr, "marB", 45720) / 12700 },
          anchor,
          wrap: true,
          autofit: "none",
          fontScale: 1,
          lnReduction: 0,
          vert: "horz",
        };
        const fill = parseFill(tcPr, ctx, rels) ?? look.fill ?? { kind: "none" as const };
        this.useFill(fill);
        const edge = (name: string): LineDef | null | undefined => {
          const ln = kid(tcPr, name);
          return ln ? applyLine(null, parseLinePartial(ln, ctx, rels)) : undefined;
        };
        return {
          cell: {
            gridSpan: Math.max(1, num(tc, "gridSpan", 1)),
            rowSpan: Math.max(1, num(tc, "rowSpan", 1)),
            covered: truthy(tc?.attrs.hMerge) || truthy(tc?.attrs.vMerge),
            text,
            fill,
            borders: { l: null, r: null, t: null, b: null },
          },
          look,
          own: { l: edge("a:lnL"), r: edge("a:lnR"), t: edge("a:lnT"), b: edge("a:lnB") },
        };
      });
    });

    // A border shared by two cells is drawn once: the cell's own setting wins, then its neighbour's, then the style's thicker line.
    grid.forEach((row, r) => {
      row.forEach((here, c) => {
        const left = row[c - 1];
        const right = row[c + 1];
        const above = grid[r - 1]?.[c];
        const below = grid[r + 1]?.[c];
        here.cell.borders = {
          l: firstDefined(here.own.l, left?.own.r, thicker(here.look.edges.l, left?.look.edges.r)) ?? null,
          r: firstDefined(here.own.r, right?.own.l, thicker(here.look.edges.r, right?.look.edges.l)) ?? null,
          t: firstDefined(here.own.t, above?.own.b, thicker(here.look.edges.t, above?.look.edges.b)) ?? null,
          b: firstDefined(here.own.b, below?.own.t, thicker(here.look.edges.b, below?.look.edges.t)) ?? null,
        };
      });
    });
    // A merged cell's far edges are those of the last cell it covers.
    grid.forEach((row, r) => {
      row.forEach((here, c) => {
        if (here.cell.covered) return;
        const lastColumn = row[Math.min(columns.length - 1, c + here.cell.gridSpan - 1)];
        const lastRow = grid[Math.min(rows.length - 1, r + here.cell.rowSpan - 1)]?.[c];
        if (lastColumn && lastColumn !== here) here.cell.borders.r = lastColumn.cell.borders.r;
        if (lastRow && lastRow !== here) here.cell.borders.b = lastRow.cell.borders.b;
      });
    });

    const tableRows: TableRowM[] = rows.map((row, r) => ({ height: num(row, "h", 0) / 12700, cells: (grid[r] ?? []).map((raw) => raw.cell) }));
    return { kind: "table", xf, columns, rows: tableRows };
  }
}
