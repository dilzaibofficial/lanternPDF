import { PDFArray, PDFDict, PDFDocument, PDFName, type PDFPage } from "@cantoo/pdf-lib";
import { BRAND } from "../../../config/brand";
import type { EditorObject, Margins, TextEditRecord } from "../../../editor/model/types";
import { AppError } from "../../errors";
import { plural } from "../../format";
import { loadForEdit } from "../document";
import type { ObjectEdit, ObjectOutcome } from "../engine/objects";
import { type RedactionReport, redactPage } from "../engine/redact";
import { stripThumbnails } from "../dedupe";
import { type EditOutcome, applyTextEdits } from "../engine/textEdit";
import { pruneUnreachable } from "../engine/prune";
import { type PageItem, arrangePages } from "../pages";
import { type JobContext, MIME, type OutputFile, type PdfInput, type Rotation, reportProgress } from "../types";
import { verifyPdf } from "../verify";
import { addComment, addMarkup } from "./annotations";
import { baseFrame, toUser } from "./baseSpace";
import { sendNewContentToBack } from "../draw";
import { type DrawContext, drawObjects } from "./drawObjects";

/** The kinds that are painted into the page's content (the others are annotations or form fields). Only these can be placed behind the page. */
const PAINTED = new Set<EditorObject["kind"]>(["text", "image", "rect", "ellipse", "line", "draw", "cover"]);

/**
 * Turns the editor's document into a PDF file.
 *
 * The stages, in order:
 *  1. **Structure** (qpdf): which pages, in what order, turned how, plus blank pages and pages from other files.
 *     qpdf keeps links, form fields, outlines, labels and metadata of the pages it carries over.
 *  2. **Content** (pdf-lib and the text engine), page by page: edits to existing text, then the added objects, then
 *     the crop.
 *  3. **Check**: the result is re-opened and verified before it is offered.
 *
 * The sources are only ever read. Nothing here writes to the files the person opened.
 */

export interface ExportSource {
  id: string;
  name: string;
  bytes: Uint8Array;
  password?: string;
  /** Number of pages the source has, so a plan that uses all of them in order can skip the rearranging. */
  pageCount: number;
}

export interface ExportPage {
  /** Source id, or null for a blank page. */
  source: string | null;
  /** 0-based page of the source. */
  index: number;
  /** Size of the page as first displayed (blank pages are created this size). */
  width: number;
  height: number;
  /** Quarter turns added in the editor. */
  rotation: Rotation;
  crop: Margins | null;
  objects: EditorObject[];
  edits: TextEditRecord[];
  /** Moves, removals and reordering of what the page already draws (images, shapes, text lines, annotations). */
  objectEdits?: ObjectEdit[];
}

export interface ExportOptions {
  fileName: string;
  /** Written as the author of notes and markup. */
  author?: string;
  /** With redaction: also clear the document's properties (title, author, subject, keywords) and its metadata. */
  removeProperties?: boolean;
  /** With redaction: also remove the bookmarks (their titles may repeat redacted words). */
  removeBookmarks?: boolean;
  /** With redaction: also remove file attachments. */
  removeAttachments?: boolean;
}

export interface ExportPlan {
  sources: ExportSource[];
  pages: ExportPage[];
  options: ExportOptions;
}

export interface ExportReport {
  pages: number;
  /** What happened to each edit of existing text. */
  edits: { page: number; outcome: EditOutcome }[];
  /** What happened to each change to what a page already drew. */
  changes: { page: number; outcome: ObjectOutcome }[];
  /** What redaction removed from each page that has redaction boxes. */
  redactions: RedactionReport[];
  objectsDrawn: number;
  annotations: number;
  warnings: string[];
}

export interface ExportResult extends OutputFile {
  report: ExportReport;
}

function structureItems(plan: ExportPlan): { items: PageItem[]; sources: PdfInput[]; needed: boolean } {
  const used: string[] = [];
  for (const page of plan.pages) if (page.source !== null && !used.includes(page.source)) used.push(page.source);
  const sources: PdfInput[] = used.map((id) => {
    const found = plan.sources.find((s) => s.id === id);
    if (!found) throw new AppError("INVALID_INPUT", "A page refers to a document that is no longer open.");
    return { name: found.name, bytes: found.bytes, password: found.password };
  });
  const items: PageItem[] = plan.pages.map((page) =>
    page.source === null ? { kind: "blank", width: page.width, height: page.height, rotate: page.rotation } : { kind: "page", source: used.indexOf(page.source), page: page.index + 1, rotate: page.rotation },
  );
  // Nothing to rearrange: one document, in its own order, unturned.
  const only = plan.sources.find((s) => s.id === used[0]);
  const identity = sources.length === 1 && only?.pageCount === items.length && items.every((item, i) => item.kind === "page" && item.source === 0 && item.page === i + 1 && item.rotate === 0);
  return { items, sources, needed: !identity };
}

/** The crop box, in the page's own space, for margins given in base space. */
function cropBoxFor(page: PDFPage, frame: ReturnType<typeof baseFrame>, crop: Margins): [number, number, number, number] {
  const width = frame.displayWidth;
  const height = frame.displayHeight;
  const corners = [toUser(frame, crop.left, crop.top), toUser(frame, width - crop.right, crop.top), toUser(frame, crop.left, height - crop.bottom), toUser(frame, width - crop.right, height - crop.bottom)];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  void page;
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Empties the information dictionary and drops the XMP metadata. */
function clearProperties(doc: PDFDocument): void {
  const info = doc.context.lookup(doc.context.trailerInfo.Info ?? PDFName.of("none"));
  if (info instanceof PDFDict) for (const key of [...info.keys()]) info.delete(key);
  doc.catalog.delete(PDFName.of("Metadata"));
  for (const page of doc.getPages()) page.node.delete(PDFName.of("Metadata"));
}

/** Drops embedded files and the annotations that show them. */
function clearAttachments(doc: PDFDocument): void {
  const names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  names?.delete(PDFName.of("EmbeddedFiles"));
  doc.catalog.delete(PDFName.of("AF"));
  for (const page of doc.getPages()) {
    const list = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!list) continue;
    for (let i = list.size() - 1; i >= 0; i -= 1) {
      const annotation = list.lookupMaybe(i, PDFDict);
      if ((annotation?.lookup(PDFName.of("Subtype")) as PDFName | undefined)?.decodeText() === "FileAttachment") list.remove(i);
    }
  }
}

export async function exportDocument(plan: ExportPlan, ctx?: JobContext): Promise<ExportResult> {
  if (plan.pages.length === 0) throw new AppError("INVALID_INPUT", "There are no pages to save.");
  const name = plan.options.fileName;
  const warnings: string[] = [];
  const report: ExportReport = { pages: plan.pages.length, edits: [], changes: [], redactions: [], objectsDrawn: 0, annotations: 0, warnings };

  // ---- 1. structure ---------------------------------------------------------------------------------------------------
  reportProgress(ctx, 0.03, "Arranging the pages");
  const { items, sources, needed } = structureItems(plan);
  let doc: PDFDocument;
  if (needed) {
    const arranged = await arrangePages(sources, items, { outputName: name });
    doc = await PDFDocument.load(arranged.bytes, { updateMetadata: false });
  } else {
    doc = await loadForEdit(sources[0] as PdfInput);
  }
  if (doc.getPageCount() !== plan.pages.length) throw new AppError("VERIFICATION_FAILED", `The pages came out as ${plural(doc.getPageCount(), "page")} instead of ${plan.pages.length}, so the file was discarded.`);

  // ---- 2. content -----------------------------------------------------------------------------------------------------
  const drawContext: DrawContext = { doc, pageNumber: 1, images: new Map() };
  const author = plan.options.author ?? "";
  for (const [index, entry] of plan.pages.entries()) {
    reportProgress(ctx, 0.1 + (index / plan.pages.length) * 0.75, `Page ${index + 1} of ${plan.pages.length}`);
    const page = doc.getPage(index);
    drawContext.pageNumber = index + 1;

    const objectEdits = entry.objectEdits ?? [];
    if (entry.edits.length > 0 || objectEdits.length > 0) {
      const result = await applyTextEdits(doc, index, entry.edits.map((e) => ({ lineId: e.lineId, text: e.text, style: e.style, fit: e.fit })), { objects: objectEdits });
      for (const outcome of result.objects) {
        report.changes.push({ page: index + 1, outcome });
        if (outcome.status === "refused") warnings.push(`Page ${index + 1}: a change to something on the page could not be made (${outcome.reason ?? "unknown reason"}), so it stays as it was.`);
      }
      for (const outcome of result.outcomes) {
        report.edits.push({ page: index + 1, outcome });
        if (outcome.status === "refused") warnings.push(`Page ${index + 1}: a text edit could not be made (${outcome.reason ?? "unknown reason"}), so that text keeps its original wording.`);
        else if (outcome.status === "applied" && !outcome.verified) warnings.push(`Page ${index + 1}: after an edit the page was read again and the text did not read as expected.`);
      }
    }

    const frame = baseFrame(page, entry.rotation);
    if (entry.objects.some((o) => o.kind === "field")) throw new AppError("UNSUPPORTED", "Form fields are not available in this build.");

    // Redaction comes after the edits (so it applies to the page as it will be) and before anything is drawn (so what is drawn
    // over the boxes, such as their own black rectangles, is not removed).
    const boxes = entry.objects.filter((o): o is Extract<EditorObject, { kind: "redact" }> => o.kind === "redact");
    if (boxes.length > 0) {
      const done = await redactPage(doc, index, boxes.map((b) => ({ x: b.x, y: b.y, width: b.width, height: b.height, rotation: b.rotation, color: b.color })));
      report.redactions.push(done);
      warnings.push(...done.warnings);
      if (!done.verified) throw new AppError("VERIFICATION_FAILED", `Page ${index + 1} could not be redacted completely, so the file was not made. ${done.warnings[0] ?? ""}`.trim());
    }
    // Objects placed behind the page are drawn first, in a content stream that goes in front of the page's own, so the
    // page's text and graphics sit on top of them. The rest are drawn after the page's content.
    const behind = entry.objects.filter((o) => o.behind && PAINTED.has(o.kind));
    const front = entry.objects.filter((o) => !behind.includes(o));
    if (behind.length > 0 || front.some((o) => PAINTED.has(o.kind))) {
      // Wrap what the page already draws so that anything it leaves open (a transformation, a clip) cannot reach our content.
      page.translateContent(0, 0);
    }
    if (behind.length > 0) {
      page.resetPosition();
      report.objectsDrawn += await drawObjects(drawContext, page, frame, behind);
      sendNewContentToBack(page);
      page.resetPosition();
    }
    report.objectsDrawn += await drawObjects(drawContext, page, frame, front);
    for (const object of entry.objects) {
      if (object.kind === "highlight" || object.kind === "underline" || object.kind === "strikeout" || object.kind === "squiggly") {
        addMarkup(doc, page, frame, object, author);
        report.annotations += 1;
      } else if (object.kind === "comment") {
        addComment(doc, page, frame, object);
        report.annotations += 1;
      }
    }

    if (entry.crop && (entry.crop.top > 0 || entry.crop.right > 0 || entry.crop.bottom > 0 || entry.crop.left > 0)) {
      const [x1, y1, x2, y2] = cropBoxFor(page, frame, entry.crop);
      if (x2 - x1 < 1 || y2 - y1 < 1) throw new AppError("INVALID_INPUT", `The crop of page ${index + 1} leaves nothing of the page.`);
      page.setCropBox(x1, y1, x2 - x1, y2 - y1);
    }
  }

  if (report.redactions.length > 0) {
    // What redaction promises goes beyond the pages: thumbnails hold a picture of the old page, and the rest is up to the person.
    stripThumbnails(doc);
    if (plan.options.removeProperties) clearProperties(doc);
    if (plan.options.removeBookmarks) doc.catalog.delete(PDFName.of("Outlines"));
    if (plan.options.removeAttachments) clearAttachments(doc);
  }

  // ---- 3. save and check ----------------------------------------------------------------------------------------------
  reportProgress(ctx, 0.9, "Saving and checking the result");
  doc.setProducer(BRAND.name);
  doc.setModificationDate(new Date());
  await doc.flush();
  pruneUnreachable(doc);
  const bytes = await doc.save();
  const pageCount = await verifyPdf(bytes, plan.pages.length, name);
  reportProgress(ctx, 1);
  return { name, bytes, mime: MIME.pdf, pageCount, report };
}
