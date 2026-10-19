/** Reads a .docx into the model the layout works from. */
import { type OfficePackage, type Relationship, sniffImage } from "../package";
import { emuToPt, twipsToPt } from "../units";
import type { LinkRef } from "../textflow";
import type { Warnings } from "../warnings";
import { type XNode, descendants, dig, elements, kid, kids, num, textOf } from "../xml";
import { mergePara, mergeRun, onOff, parseCellProps, parseParaProps, parseRunProps, parseTableProps } from "./props";
import { NumberingCounters, type ResolvedTableStyle, type Stylesheet } from "./styles";
import type { AnchorInfo, Block, CellModel, CellProps, DocxModel, HeaderFooterRef, Inline, ParaProps, ParagraphBlock, RowModel, RunProps, Section, SectionProps, TableBlock, TableProps } from "./types";

interface PartContext {
  path: string;
  rels: Map<string, Relationship>;
}

/** Text formatting the table style gives to everything inside a cell. */
interface Below {
  para: ParaProps;
  run: RunProps;
}

interface FieldFrame {
  instr: string;
  phase: "instr" | "result";
  resultStart: number;
  firstRun?: RunProps;
}

interface RunContext {
  part: PartContext;
  items: Inline[];
  baseRun: RunProps;
  link?: LinkRef;
  fields: FieldFrame[];
}

const LETTER: Omit<SectionProps, "headers" | "footers"> = {
  pageWidth: 612,
  pageHeight: 792,
  landscape: false,
  margins: { top: 72, right: 72, bottom: 72, left: 72, header: 36, footer: 36 },
  columns: 1,
  columnGap: 36,
  titlePage: false,
  type: "nextPage",
};

const SUPPORTED_IMAGES = new Set(["png", "jpeg", "gif", "bmp", "webp"]);

function lengthFromStyle(style: string | undefined, property: string): number | undefined {
  const match = style?.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*(-?[0-9.]+)\\s*(pt|in|cm|mm|px)?`, "i"));
  if (!match) return undefined;
  const value = Number.parseFloat(match[1] as string);
  switch ((match[2] ?? "pt").toLowerCase()) {
    case "in":
      return value * 72;
    case "cm":
      return (value * 72) / 2.54;
    case "mm":
      return (value * 72) / 25.4;
    case "px":
      return value * 0.75;
    default:
      return value;
  }
}

export class DocxReader {
  readonly media = new Map<string, { bytes: Uint8Array }>();
  private readonly counters: NumberingCounters;
  private footnoteLabel = 0;
  private endnoteLabel = 0;

  constructor(
    private readonly pack: OfficePackage,
    private readonly sheet: Stylesheet,
    private readonly warnings: Warnings,
  ) {
    this.counters = new NumberingCounters(sheet);
  }

  read(): DocxModel {
    const root = this.pack.xml("word/document.xml");
    const body = kid(root, "w:body");
    const part: PartContext = { path: "word/document.xml", rels: this.pack.relationships("word/document.xml") };
    const settings = this.pack.xml("word/settings.xml");
    const defaultTabStop = twipsToPt(num(kid(settings, "w:defaultTabStop"), "w:val", 720));

    const sections: Section[] = [];
    let blocks: Block[] = [];
    let finalProps: SectionProps | undefined;
    for (const child of this.flatten(elements(body))) {
      if (child.name === "w:sectPr") {
        finalProps = this.readSection(child, part);
        continue;
      }
      for (const block of this.readBlock(child, part)) {
        blocks.push(block);
        if (block.type === "p" && block.section) {
          sections.push({ props: block.section, blocks });
          blocks = [];
        }
      }
    }
    sections.push({ props: finalProps ?? { ...LETTER, headers: {}, footers: {} }, blocks });

    // Headers and footers, once each.
    const parts = new Map<string, Block[]>();
    for (const section of sections) {
      for (const ref of [section.props.headers, section.props.footers]) {
        for (const path of [ref.default, ref.first, ref.even]) {
          if (!path || parts.has(path)) continue;
          const headerRoot = this.pack.xml(path);
          if (!headerRoot) continue;
          const headerPart: PartContext = { path, rels: this.pack.relationships(path) };
          parts.set(path, this.readBlocks(elements(headerRoot), headerPart));
        }
      }
    }

    const notes = new Map<number, Block[]>();
    for (const [path, tag] of [["word/footnotes.xml", "w:footnote"], ["word/endnotes.xml", "w:endnote"]] as const) {
      const notesRoot = this.pack.xml(path);
      const notesPart: PartContext = { path, rels: this.pack.relationships(path) };
      for (const note of kids(notesRoot, tag)) {
        const type = note.attrs["w:type"];
        if (type === "separator" || type === "continuationSeparator" || type === "continuationNotice") continue;
        const id = num(note, "w:id", -1);
        if (id >= 0) notes.set(tag === "w:endnote" ? id + 100000 : id, this.readBlocks(elements(note), notesPart));
      }
    }

    const core = this.pack.xml("docProps/core.xml");
    const field = (name: string) => textOf(kid(core, name)).trim() || undefined;
    return {
      sections,
      parts,
      evenAndOddHeaders: onOff(kid(settings, "w:evenAndOddHeaders")) === true,
      notes,
      media: this.media,
      info: { title: field("dc:title"), author: field("dc:creator"), subject: field("dc:subject"), keywords: field("cp:keywords") },
      defaultTabStop,
    };
  }

  /** Looks through wrappers that only group content (content controls, tracked insertions, custom XML). */
  private flatten(nodes: XNode[]): XNode[] {
    const out: XNode[] = [];
    for (const node of nodes) {
      if (node.name === "w:sdt") out.push(...this.flatten(elements(kid(node, "w:sdtContent"))));
      else if (node.name === "w:customXml" || node.name === "w:ins" || node.name === "w:moveTo" || node.name === "w:smartTag") out.push(...this.flatten(elements(node)));
      else if (node.name === "w:del" || node.name === "w:moveFrom") continue;
      else out.push(node);
    }
    return out;
  }

  private readBlocks(nodes: XNode[], part: PartContext, below?: Below): Block[] {
    const out: Block[] = [];
    for (const node of this.flatten(nodes)) out.push(...this.readBlock(node, part, below));
    return out;
  }

  private readBlock(node: XNode, part: PartContext, below?: Below): Block[] {
    if (node.name === "w:p") return [this.readParagraph(node, part, below)];
    if (node.name === "w:tbl") return [this.readTable(node, part)];
    return [];
  }

  // ---- sections ------------------------------------------------------------------------------------------

  private readSection(sectPr: XNode, part: PartContext): SectionProps {
    const size = kid(sectPr, "w:pgSz");
    const margin = kid(sectPr, "w:pgMar");
    const columns = kid(sectPr, "w:cols");
    let width = twipsToPt(num(size, "w:w", LETTER.pageWidth * 20));
    let height = twipsToPt(num(size, "w:h", LETTER.pageHeight * 20));
    const landscape = size?.attrs["w:orient"] === "landscape";
    if (landscape && height > width) [width, height] = [height, width];
    const refs = (tag: string): HeaderFooterRef => {
      const out: HeaderFooterRef = {};
      for (const ref of kids(sectPr, tag)) {
        const rel = part.rels.get(ref.attrs["r:id"] ?? "");
        const type = ref.attrs["w:type"] ?? "default";
        if (!rel || rel.external) continue;
        if (type === "first") out.first = rel.target;
        else if (type === "even") out.even = rel.target;
        else out.default = rel.target;
      }
      return out;
    };
    const gutter = twipsToPt(num(margin, "w:gutter", 0));
    const type = kid(sectPr, "w:type")?.attrs["w:val"];
    const start = kid(sectPr, "w:pgNumType")?.attrs["w:start"];
    const columnCount = num(columns, "w:num", 1);
    if (columnCount > 1) this.warnings.add("columns");
    return {
      pageWidth: width,
      pageHeight: height,
      landscape,
      margins: {
        top: twipsToPt(num(margin, "w:top", 1440)),
        right: twipsToPt(num(margin, "w:right", 1440)),
        bottom: twipsToPt(num(margin, "w:bottom", 1440)),
        left: twipsToPt(num(margin, "w:left", 1440)) + gutter,
        header: twipsToPt(num(margin, "w:header", 720)),
        footer: twipsToPt(num(margin, "w:footer", 720)),
      },
      columns: columnCount,
      columnGap: twipsToPt(num(columns, "w:space", 720)),
      titlePage: onOff(kid(sectPr, "w:titlePg")) === true,
      type: type === "continuous" ? "continuous" : type === "evenPage" ? "evenPage" : type === "oddPage" ? "oddPage" : "nextPage",
      headers: refs("w:headerReference"),
      footers: refs("w:footerReference"),
      pageNumberStart: start !== undefined ? Number(start) : undefined,
    };
  }

  // ---- paragraphs ----------------------------------------------------------------------------------------

  private readParagraph(p: XNode, part: PartContext, below?: Below): ParagraphBlock {
    const pPr = kid(p, "w:pPr");
    const styleId = kid(pPr, "w:pStyle")?.attrs["w:val"];
    const base = this.sheet.paragraphStyle(styleId, below);
    const direct = parseParaProps(pPr, this.sheet.ctx);
    if (kid(pPr, "w:framePr")) {
      this.warnings.add("frames");
    }
    if (direct.bidi || base.para.bidi) this.warnings.add("rtl");

    // Style, then the list level's own indents, then what the paragraph says itself.
    const numId = direct.numId ?? base.para.numId;
    const level = direct.numLevel ?? base.para.numLevel ?? 0;
    let props = base.para;
    let marker: { text: string; run: RunProps; suffix: "tab" | "space" | "nothing" } | undefined;
    if (numId !== undefined && numId > 0) {
      const found = this.counters.marker(numId, level);
      if (found) {
        props = mergePara(props, found.level.para);
        marker = { text: found.text, run: found.level.run, suffix: found.level.suffix };
      }
    }
    props = mergePara(props, direct);

    // The paragraph mark's own formatting gives an empty paragraph its height, and the marker its look.
    const markRun = mergeRun(base.run, parseRunProps(kid(pPr, "w:rPr"), this.sheet.ctx));
    const items: Inline[] = [];
    if (marker) {
      const markerRun = mergeRun(markRun, marker.run);
      if (marker.run.fontName) markerRun.symbolFont = marker.run.symbolFont;
      items.push({ kind: "text", text: marker.text, run: markerRun });
      if (marker.suffix === "tab") items.push({ kind: "tab", run: markerRun });
      else if (marker.suffix === "space") items.push({ kind: "text", text: " ", run: markerRun });
    }
    const ctx: RunContext = { part, items, baseRun: base.run, fields: [] };
    this.readInline(elements(p), ctx);

    const section = kid(pPr, "w:sectPr");
    return { type: "p", props, styleId, markRun, items, section: section ? this.readSection(section, part) : undefined };
  }

  private readInline(nodes: XNode[], ctx: RunContext): void {
    for (const node of nodes) {
      switch (node.name) {
        case "w:r":
          this.readRun(node, ctx);
          break;
        case "w:hyperlink": {
          const rel = node.attrs["r:id"] ? ctx.part.rels.get(node.attrs["r:id"]) : undefined;
          const link: LinkRef | undefined = rel?.external ? { uri: rel.target } : node.attrs["w:anchor"] ? { anchor: node.attrs["w:anchor"] } : undefined;
          this.readInline(elements(node), { ...ctx, link: link ?? ctx.link });
          break;
        }
        case "w:fldSimple": {
          const instr = node.attrs["w:instr"] ?? "";
          const name = instr.trim().split(/\s+/)[0]?.toUpperCase();
          const start = ctx.items.length;
          this.readInline(elements(node), ctx);
          if (name === "PAGE" || name === "NUMPAGES" || name === "SECTIONPAGES") {
            const run = (ctx.items.slice(start).find((item) => "run" in item) as { run: RunProps } | undefined)?.run ?? ctx.baseRun;
            ctx.items.splice(start);
            ctx.items.push({ kind: "field", field: name === "PAGE" ? "page" : "pages", run });
          } else if (name === "HYPERLINK") {
            this.applyLink(ctx.items, start, instr);
          }
          break;
        }
        case "w:bookmarkStart": {
          const name = node.attrs["w:name"];
          if (name && !name.startsWith("_GoBack")) ctx.items.push({ kind: "bookmark", name });
          break;
        }
        case "w:ins":
        case "w:smartTag":
        case "w:customXml":
        case "w:moveTo":
          this.readInline(elements(node), ctx);
          break;
        case "w:sdt":
          this.readInline(elements(kid(node, "w:sdtContent")), ctx);
          break;
        case "m:oMath":
        case "m:oMathPara":
          this.warnings.add("equation");
          break;
        default:
          break;
      }
    }
  }

  private applyLink(items: Inline[], from: number, instr: string): void {
    const anchor = instr.match(/\\l\s+"([^"]+)"/)?.[1];
    const uri = instr.match(/HYPERLINK\s+"([^"]+)"/i)?.[1];
    const link: LinkRef | undefined = uri ? { uri } : anchor ? { anchor } : undefined;
    if (!link) return;
    for (let i = from; i < items.length; i += 1) {
      const item = items[i] as Inline;
      if (item.kind === "text" || item.kind === "image") item.link = link;
    }
  }

  private readRun(run: XNode, ctx: RunContext): void {
    const rPr = kid(run, "w:rPr");
    const style = kid(rPr, "w:rStyle")?.attrs["w:val"];
    let effective = style ? mergeRun(ctx.baseRun, this.sheet.characterStyle(style)) : ctx.baseRun;
    effective = mergeRun(effective, parseRunProps(rPr, this.sheet.ctx));
    if (effective.hidden) return;
    if (effective.rtl) this.warnings.add("rtl");

    let text = "";
    const flush = () => {
      if (text !== "") ctx.items.push({ kind: "text", text, run: effective, link: ctx.link });
      text = "";
    };
    const inInstruction = () => ctx.fields.some((field) => field.phase === "instr");

    const visit = (nodes: XNode[]) => {
      for (const child of nodes) {
        switch (child.name) {
          case "w:t":
            if (!inInstruction()) {
              // A raw tab character inside text is a tab stop, as it is in Word.
              const parts = textOf(child).split("	");
              parts.forEach((part, index) => {
                if (index > 0) {
                  flush();
                  ctx.items.push({ kind: "tab", run: effective });
                }
                text += part;
              });
            }
            break;
          case "w:instrText": {
            const frame = ctx.fields[ctx.fields.length - 1];
            if (frame) frame.instr += textOf(child);
            break;
          }
          case "w:fldChar": {
            const kind = child.attrs["w:fldCharType"];
            if (kind === "begin") {
              flush();
              ctx.fields.push({ instr: "", phase: "instr", resultStart: ctx.items.length });
            } else if (kind === "separate") {
              flush();
              const frame = ctx.fields[ctx.fields.length - 1];
              if (frame) {
                frame.phase = "result";
                frame.resultStart = ctx.items.length;
                frame.firstRun = effective;
              }
            } else if (kind === "end") {
              flush();
              const frame = ctx.fields.pop();
              if (frame) this.finishField(frame, ctx, effective);
            }
            break;
          }
          case "w:tab":
          case "w:ptab":
            if (!inInstruction()) {
              flush();
              ctx.items.push({ kind: "tab", run: effective });
            }
            break;
          case "w:br": {
            if (inInstruction()) break;
            flush();
            const type = child.attrs["w:type"];
            ctx.items.push({ kind: "break", type: type === "page" ? "page" : type === "column" ? "column" : "line", run: effective });
            break;
          }
          case "w:cr":
            if (!inInstruction()) {
              flush();
              ctx.items.push({ kind: "break", type: "line", run: effective });
            }
            break;
          case "w:noBreakHyphen":
            text += "‑";
            break;
          case "w:sym": {
            const code = Number.parseInt(child.attrs["w:char"] ?? "", 16);
            if (Number.isFinite(code)) {
              flush();
              ctx.items.push({ kind: "text", text: String.fromCodePoint(code), run: { ...effective, symbolFont: true, fontName: child.attrs["w:font"] ?? effective.fontName }, link: ctx.link });
            }
            break;
          }
          case "w:drawing":
          case "w:pict":
          case "w:object": {
            flush();
            const image = child.name === "w:drawing" ? this.readDrawing(child, ctx.part, effective) : this.readPicture(child, ctx.part, effective);
            if (image) {
              if (image.kind === "image") image.link = ctx.link;
              ctx.items.push(image);
            }
            break;
          }
          case "w:footnoteReference":
          case "w:endnoteReference": {
            flush();
            const endnote = child.name === "w:endnoteReference";
            const id = num(child, "w:id", -1);
            if (id >= 0) {
              this.warnings.add("footnotes");
              const label = endnote ? this.toRoman((this.endnoteLabel += 1)) : String((this.footnoteLabel += 1));
              ctx.items.push({ kind: "note", noteId: endnote ? id + 100000 : id, label, run: { ...effective, vertAlign: "superscript" } });
            }
            break;
          }
          case "mc:AlternateContent": {
            const choice = kid(child, "mc:Choice") ?? kid(child, "mc:Fallback");
            visit(elements(choice));
            break;
          }
          default:
            break;
        }
      }
    };
    visit(elements(run));
    flush();
  }

  private toRoman(value: number): string {
    const table: [number, string][] = [[10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
    let rest = value;
    let out = "";
    for (const [size, symbol] of table) {
      while (rest >= size) {
        out += symbol;
        rest -= size;
      }
    }
    return out;
  }

  private finishField(frame: FieldFrame, ctx: RunContext, fallbackRun: RunProps): void {
    const name = frame.instr.trim().split(/\s+/)[0]?.toUpperCase();
    if (name === "PAGE" || name === "NUMPAGES" || name === "SECTIONPAGES") {
      ctx.items.splice(frame.resultStart);
      ctx.items.push({ kind: "field", field: name === "PAGE" ? "page" : "pages", run: frame.firstRun ?? fallbackRun });
    } else if (name === "HYPERLINK") {
      this.applyLink(ctx.items, frame.resultStart, frame.instr);
    }
  }

  // ---- pictures ------------------------------------------------------------------------------------------

  private pictureFrom(rel: Relationship | undefined, width: number, height: number, run: RunProps, crop?: { left: number; top: number; right: number; bottom: number }, anchor?: AnchorInfo): Inline | null {
    if (!rel || rel.external) {
      this.warnings.add("image-broken");
      return null;
    }
    const bytes = this.pack.bytes(rel.target);
    if (!bytes) {
      this.warnings.add("image-broken");
      return null;
    }
    const format = sniffImage(bytes);
    if (!SUPPORTED_IMAGES.has(format)) {
      this.warnings.add("image-format", 1, format === "unknown" ? undefined : format.toUpperCase());
      return null;
    }
    this.media.set(rel.target, { bytes });
    return { kind: "image", part: rel.target, width, height, run, crop, anchor };
  }

  private readDrawing(drawing: XNode, part: PartContext, run: RunProps): Inline | null {
    const holder = kid(drawing, "wp:inline") ?? kid(drawing, "wp:anchor");
    if (!holder) return null;
    const extent = kid(holder, "wp:extent");
    const width = emuToPt(num(extent, "cx", 0));
    const height = emuToPt(num(extent, "cy", 0));
    const data = dig(holder, "a:graphic/a:graphicData");
    const uri = data?.attrs.uri ?? "";
    if (uri.endsWith("/picture")) {
      const pic = kid(data, "pic:pic");
      const blip = dig(pic, "pic:blipFill/a:blip");
      const rel = blip?.attrs["r:embed"] ? part.rels.get(blip.attrs["r:embed"]) : undefined;
      const source = dig(pic, "pic:blipFill/a:srcRect");
      const crop = source
        ? { left: num(source, "l", 0) / 100000, top: num(source, "t", 0) / 100000, right: num(source, "r", 0) / 100000, bottom: num(source, "b", 0) / 100000 }
        : undefined;
      const anchor = holder.name === "wp:anchor" ? this.readAnchor(holder) : undefined;
      return this.pictureFrom(rel, width, height, run, crop, anchor);
    }
    if (uri.includes("chart")) this.warnings.add("chart");
    else if (uri.includes("diagram")) this.warnings.add("smartart");
    else if (descendants(data, "w:txbxContent").length > 0) this.warnings.add("textbox");
    else if (uri.includes("wordprocessingShape") || uri.includes("wordprocessingGroup") || uri.includes("wordprocessingCanvas")) this.warnings.add("shape");
    else if (uri.includes("video") || uri.includes("media")) this.warnings.add("video");
    return null;
  }

  private readAnchor(anchor: XNode): AnchorInfo {
    const horizontal = kid(anchor, "wp:positionH");
    const vertical = kid(anchor, "wp:positionV");
    const wrap = anchor.children.find((child): child is XNode => typeof child !== "string" && child.name.startsWith("wp:wrap"));
    const wrapName = wrap?.name.replace("wp:wrap", "") ?? "None";
    return {
      hFrom: horizontal?.attrs.relativeFrom ?? "column",
      hOffset: emuToPt(Number(textOf(kid(horizontal, "wp:posOffset")) || 0)),
      hAlign: textOf(kid(horizontal, "wp:align")).trim() || undefined,
      vFrom: vertical?.attrs.relativeFrom ?? "paragraph",
      vOffset: emuToPt(Number(textOf(kid(vertical, "wp:posOffset")) || 0)),
      vAlign: textOf(kid(vertical, "wp:align")).trim() || undefined,
      wrap: wrapName === "Square" ? "square" : wrapName === "Tight" ? "tight" : wrapName === "Through" ? "through" : wrapName === "TopAndBottom" ? "topAndBottom" : "none",
      behind: anchor.attrs.behindDoc === "1" || anchor.attrs.behindDoc === "true",
    };
  }

  /** Older (VML) pictures and embedded objects. */
  private readPicture(node: XNode, part: PartContext, run: RunProps): Inline | null {
    const shapes = descendants(node, "v:shape");
    for (const shape of shapes) {
      const image = descendants(shape, "v:imagedata")[0];
      if (!image) continue;
      const rel = part.rels.get(image.attrs["r:id"] ?? image.attrs["o:relid"] ?? "");
      const style = shape.attrs.style;
      const width = lengthFromStyle(style, "width") ?? 100;
      const height = lengthFromStyle(style, "height") ?? 100;
      if (shape.attrs.type === "#_x0000_t136") {
        this.warnings.add("watermark");
        return null;
      }
      return this.pictureFrom(rel, width, height, run);
    }
    if (descendants(node, "v:textbox").length > 0) this.warnings.add("textbox");
    else if (descendants(node, "o:OLEObject").length > 0) this.warnings.add("ole");
    else if (shapes.some((shape) => shape.attrs.type === "#_x0000_t136")) this.warnings.add("watermark");
    else if (shapes.length > 0 || descendants(node, "v:rect").length > 0 || descendants(node, "v:line").length > 0) this.warnings.add("shape");
    return null;
  }

  // ---- tables --------------------------------------------------------------------------------------------

  private readTable(tbl: XNode, part: PartContext): TableBlock {
    const direct = parseTableProps(kid(tbl, "w:tblPr"), this.sheet.ctx);
    const style = this.sheet.tableStyle(direct.styleId);
    const props: TableProps = {
      ...style.table,
      ...direct,
      borders: { ...(style.table.borders ?? {}), ...(direct.borders ?? {}) },
      cellMargins: { ...(style.table.cellMargins ?? {}), ...(direct.cellMargins ?? {}) },
    };
    const look = direct.look ?? style.table.look ?? { firstRow: true, lastRow: false, firstCol: true, lastCol: false, bandedRows: true, bandedCols: false };
    props.look = look;
    const grid = kids(kid(tbl, "w:tblGrid"), "w:gridCol").map((col) => twipsToPt(num(col, "w:w", 0)));
    const rowNodes = kids(tbl, "w:tr");
    const rows: RowModel[] = [];

    rowNodes.forEach((rowNode, rowIndex) => {
      const trPr = kid(rowNode, "w:trPr");
      const heightNode = kid(trPr, "w:trHeight");
      const cells: CellModel[] = [];
      let column = num(kid(trPr, "w:gridBefore"), "w:val", 0);
      const cellNodes = this.flatten(elements(rowNode)).filter((node) => node.name === "w:tc");
      cellNodes.forEach((cellNode) => {
        const tcPr = kid(cellNode, "w:tcPr");
        const span = Math.max(1, num(kid(tcPr, "w:gridSpan"), "w:val", 1));
        const vMergeNode = kid(tcPr, "w:vMerge");
        const vMerge: CellModel["vMerge"] = vMergeNode ? (vMergeNode.attrs["w:val"] === "restart" ? "restart" : "continue") : null;
        const widthNode = kid(tcPr, "w:tcW");
        const conditions = this.conditionsFor(style, look, rowIndex, column, rowNodes.length, Math.max(grid.length, 1), props);
        let below: Below = { para: style.para, run: style.run };
        let cellProps: CellProps = { ...style.cell };
        for (const condition of conditions) {
          below = { para: mergePara(below.para, condition.para), run: mergeRun(below.run, condition.run) };
          cellProps = {
            ...cellProps,
            ...condition.cell,
            borders: { ...(cellProps.borders ?? {}), ...(condition.cell.borders ?? {}) },
          };
        }
        const own = parseCellProps(tcPr, this.sheet.ctx);
        cellProps = { ...cellProps, ...own, borders: { ...(cellProps.borders ?? {}), ...(own.borders ?? {}) }, margins: { ...(cellProps.margins ?? {}), ...(own.margins ?? {}) } };
        if (own.shading === undefined && tcPr && kid(tcPr, "w:shd")?.attrs["w:fill"] === "auto") cellProps.shading = undefined;
        const blocks = this.readBlocks(elements(cellNode), part, below);
        cells.push({
          gridSpan: span,
          vMerge,
          props: cellProps,
          width: widthNode && widthNode.attrs["w:type"] !== "pct" ? twipsToPt(num(widthNode, "w:w", 0)) : undefined,
          blocks: blocks.length > 0 ? blocks : [this.emptyParagraph(below)],
          noWrap: onOff(kid(tcPr, "w:noWrap")) === true,
        });
        column += span;
      });
      const rule = heightNode?.attrs["w:hRule"];
      rows.push({
        cells,
        height: heightNode ? { value: twipsToPt(num(heightNode, "w:val", 0)), rule: rule === "exact" ? "exact" : "atLeast" } : undefined,
        header: onOff(kid(trPr, "w:tblHeader")) === true,
        cantSplit: onOff(kid(trPr, "w:cantSplit")) === true,
      });
    });

    // A table without a grid takes it from its widest row.
    let effectiveGrid = grid;
    if (effectiveGrid.length === 0 && rows.length > 0) {
      const widest = rows.reduce((best, row) => (row.cells.reduce((sum, cell) => sum + cell.gridSpan, 0) > best.cells.reduce((sum, cell) => sum + cell.gridSpan, 0) ? row : best), rows[0] as RowModel);
      effectiveGrid = widest.cells.flatMap((cell) => Array.from({ length: cell.gridSpan }, () => (cell.width ?? 72) / cell.gridSpan));
    }
    return { type: "tbl", props, grid: effectiveGrid, rows };
  }

  private emptyParagraph(below: Below): ParagraphBlock {
    const base = this.sheet.paragraphStyle(undefined, below);
    return { type: "p", props: base.para, markRun: base.run, items: [] };
  }

  /** The parts of a table style that apply to one cell, in the order Word layers them. */
  private conditionsFor(style: ResolvedTableStyle, look: NonNullable<TableProps["look"]>, row: number, column: number, rowCount: number, columnCount: number, props: TableProps): { para: ParaProps; run: RunProps; cell: CellProps }[] {
    const out: { para: ParaProps; run: RunProps; cell: CellProps }[] = [];
    const add = (name: string) => {
      const found = style.conditions.get(name);
      if (found) out.push(found);
    };
    add("wholeTable");
    const rowBand = props.rowBandSize ?? 1;
    const columnBand = props.colBandSize ?? 1;
    const bodyRow = row - (look.firstRow ? 1 : 0);
    const bodyColumn = column - (look.firstCol ? 1 : 0);
    if (look.bandedRows && bodyRow >= 0 && !(look.lastRow && row === rowCount - 1)) add(Math.floor(bodyRow / rowBand) % 2 === 0 ? "band1Horz" : "band2Horz");
    if (look.bandedCols && bodyColumn >= 0 && !(look.lastCol && column === columnCount - 1)) add(Math.floor(bodyColumn / columnBand) % 2 === 0 ? "band1Vert" : "band2Vert");
    if (look.firstCol && column === 0) add("firstCol");
    if (look.lastCol && column === columnCount - 1) add("lastCol");
    if (look.firstRow && row === 0) add("firstRow");
    if (look.lastRow && row === rowCount - 1) add("lastRow");
    if (look.firstRow && look.firstCol && row === 0 && column === 0) add("nwCell");
    if (look.firstRow && look.lastCol && row === 0 && column === columnCount - 1) add("neCell");
    if (look.lastRow && look.firstCol && row === rowCount - 1 && column === 0) add("swCell");
    if (look.lastRow && look.lastCol && row === rowCount - 1 && column === columnCount - 1) add("seCell");
    return out;
  }
}
