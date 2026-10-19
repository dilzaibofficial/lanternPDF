/** Word (.docx) to PDF. */
import { AppError } from "../../errors";
import { FontLibrary, type FontRequest } from "../fontLibrary";
import { OfficePackage } from "../package";
import { PdfBuilder } from "../pdfBuilder";
import { TextShaper } from "../textflow";
import type { ConversionResult, ConvertOptions } from "../types";
import { Warnings } from "../warnings";
import { embedImages, sampleChars } from "../shared";
import { DocxReader } from "./read";
import { type LaidBlock, type LayoutContext, layoutBlocks, paginate } from "./layout";
import { furnitureHeights, renderPages } from "./render";
import { Stylesheet } from "./styles";
import type { Block, DocxModel, Inline, ParagraphBlock, RunProps } from "./types";
import { toTextStyle } from "./layout";

/** Every font face the document uses, with the characters set in it, so fonts load once before layout. */
function collectFontRequests(model: DocxModel): { request: FontRequest; text: string }[] {
  const wanted = new Map<string, { request: FontRequest; chars: Set<string> }>();
  const add = (run: RunProps, text: string) => {
    const style = toTextStyle(run);
    const key = `${style.family}|${style.bold}|${style.italic}`;
    let entry = wanted.get(key);
    if (!entry) {
      entry = { request: { family: style.family, bold: style.bold, italic: style.italic }, chars: new Set() };
      wanted.set(key, entry);
    }
    for (const char of text) entry.chars.add(char);
  };
  const walk = (blocks: readonly Block[]) => {
    for (const block of blocks) {
      if (block.type === "p") {
        add(block.markRun, "");
        for (const item of block.items) {
          if (item.kind === "text") add(item.run, item.text);
          else if (item.kind === "field") add(item.run, "0123456789");
          else if (item.kind === "note") add(item.run, item.label);
          else if (item.kind === "bookmark") continue;
          else add(item.run, "");
        }
      } else {
        for (const row of block.rows) for (const cell of row.cells) walk(cell.blocks);
      }
    }
  };
  for (const section of model.sections) walk(section.blocks);
  for (const blocks of model.parts.values()) walk(blocks);
  for (const blocks of model.notes.values()) walk(blocks);
  // The bullets and numbers drawn by the layout itself.
  return [...wanted.values()].map(({ request, chars }) => ({ request, text: [...chars].join("") }));
}

/** Notes referenced in the text, in order, as blocks to put at the end of the document. */
function noteBlocks(model: DocxModel): Block[] {
  const referenced: { id: number; label: string; run: RunProps }[] = [];
  const walk = (blocks: readonly Block[]) => {
    for (const block of blocks) {
      if (block.type === "p") {
        for (const item of block.items) if (item.kind === "note") referenced.push({ id: item.noteId, label: item.label, run: item.run });
      } else {
        for (const row of block.rows) for (const cell of row.cells) walk(cell.blocks);
      }
    }
  };
  for (const section of model.sections) walk(section.blocks);
  if (referenced.length === 0) return [];
  const out: Block[] = [];
  const first = referenced[0] as { run: RunProps };
  out.push({ type: "p", props: { borders: { top: { style: "single", width: 0.5, color: "#000000", space: 4 } }, spacing: { before: 12, after: 2 } }, markRun: { ...first.run, size: 6 }, items: [] });
  for (const note of referenced) {
    const blocks = model.notes.get(note.id) ?? [];
    blocks.forEach((block, index) => {
      if (block.type !== "p") {
        out.push(block);
        return;
      }
      const label: Inline[] = index === 0 ? [{ kind: "text", text: `${note.label} `, run: note.run }] : [];
      const copy: ParagraphBlock = { ...block, items: [...label, ...block.items] };
      out.push(copy);
    });
  }
  return out;
}

export async function convertDocx(bytes: Uint8Array, options: ConvertOptions = {}): Promise<ConversionResult> {
  const progress = (fraction: number, message?: string) => options.onProgress?.(fraction, message);
  progress(0.03, "Opening the document");
  const pack = OfficePackage.open(bytes, "docx");
  const warnings = new Warnings();
  const sheet = Stylesheet.load(pack);
  const model = new DocxReader(pack, sheet, warnings).read();
  if (model.sections.every((section) => section.blocks.length === 0)) {
    throw new AppError("INVALID_FILE", "This document has no content to convert.");
  }

  progress(0.15, "Loading fonts");
  const fonts = new FontLibrary();
  await fonts.prepare(collectFontRequests(model));
  const shaper = new TextShaper(fonts);

  progress(0.25, "Preparing pictures");
  const builder = await PdfBuilder.create();
  const images = await embedImages(builder, model.media, warnings);

  const tallest = Math.max(72, ...model.sections.map((section) => section.props.pageHeight - section.props.margins.top - section.props.margins.bottom));
  const layoutContext: LayoutContext = { shaper, images, warnings, defaultTabStop: model.defaultTabStop, contentHeightLimit: tallest };
  const furniture = furnitureHeights(model, { model, layoutContext, shaper });

  progress(0.4, "Laying out the pages");
  const notes = noteBlocks(model);
  const pagination = paginate(model, layoutContext, furniture, notes.length > 0 ? (width): LaidBlock[] => layoutBlocks(notes, width, layoutContext) : undefined);

  progress(0.75, "Writing the PDF");
  renderPages({ builder, model, pagination, layoutContext, shaper });
  if (shaper.warnings.unsupported.size > 0) warnings.add("missing-glyphs", shaper.warnings.unsupported.size, sampleChars(shaper.warnings.unsupported));
  const baseName = (options.name ?? "").replace(/\.[^.]+$/, "");
  const out = await builder.save({ title: model.info.title || baseName || undefined, author: model.info.author, subject: model.info.subject, keywords: model.info.keywords });
  progress(0.98, "Done");
  return { bytes: out, pageCount: pagination.pages.length, warnings: warnings.messages() };
}
