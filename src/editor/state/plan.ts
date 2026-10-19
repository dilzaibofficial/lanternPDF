import type { ExportPlan } from "../../lib/pdf/export/exportDocument";
import { toEngineEdits } from "../model/existing";
import { editsOn } from "../model/ops";
import type { DocState, EditorObject } from "../model/types";
import type { EditorStore } from "./store";

/** What a download would contain, in words that mean something to the person: used by the dialog before anything runs. */
export interface Summary {
  pages: number;
  edits: number;
  objects: number;
  markup: number;
  redactions: number;
  covers: number;
  fields: number;
  /** Things the page already drew that were moved, resized, turned or put above or below others. */
  moved: number;
  /** Things the page already drew that were removed. */
  removed: number;
  signed: boolean;
  /** Pages changed in any way. */
  changedPages: number;
}

export function summarize(doc: DocState): Summary {
  const all: EditorObject[] = Object.values(doc.objects).flat();
  const count = (test: (o: EditorObject) => boolean) => all.filter(test).length;
  const edited = new Set<string>();
  let edits = 0;
  for (const page of doc.pages) {
    const n = editsOn(doc, page.id).length;
    edits += n;
    if (n > 0 || (doc.objects[page.id]?.length ?? 0) > 0 || page.rotation !== 0 || page.crop || Object.keys(doc.existing[page.id] ?? {}).length > 0) edited.add(page.id);
  }
  const changes = doc.pages.flatMap((page) => Object.values(doc.existing[page.id] ?? {}));
  return {
    pages: doc.pages.length,
    edits,
    objects: count((o) => !["highlight", "underline", "strikeout", "squiggly", "comment", "redact", "cover", "field"].includes(o.kind)),
    markup: count((o) => ["highlight", "underline", "strikeout", "squiggly", "comment"].includes(o.kind)),
    redactions: count((o) => o.kind === "redact"),
    covers: count((o) => o.kind === "cover"),
    fields: count((o) => o.kind === "field"),
    moved: changes.filter((change) => !change.deleted).length,
    removed: changes.filter((change) => change.deleted).length,
    signed: Object.values(doc.sources).some((s) => s.signed),
    changedPages: edited.size,
  };
}

/** The serialisable description of the document for the export worker: sources, pages in order, objects and edits. */
export async function buildExportPlan(store: EditorStore, fileName: string, author: string, extra: Partial<ExportPlan["options"]> = {}): Promise<ExportPlan> {
  const doc = store.doc;
  // Changes to what a page already draws are expressed through its analysis, so every such page must have been read.
  for (const page of doc.pages) if (page.source !== null && Object.keys(doc.existing[page.id] ?? {}).length > 0) await store.analyze(page);
  const used = new Set(doc.pages.map((p) => p.source).filter((s): s is string => s !== null));
  return {
    sources: [...used].map((id) => {
      const source = store.source(id);
      if (!source) throw new Error("A source document is no longer open.");
      return { id, name: source.info.name, bytes: source.bytes, password: source.password, pageCount: source.info.pageCount };
    }),
    pages: doc.pages.map((page) => ({
      source: page.source,
      index: page.index,
      width: page.width,
      height: page.height,
      rotation: page.rotation,
      crop: page.crop,
      objects: [...(doc.objects[page.id] ?? [])],
      edits: editsOn(doc, page.id),
      objectEdits: ((analysis, edits) => (analysis && edits ? toEngineEdits(analysis, edits) : []))(store.getPageData(page.id).analysis, doc.existing[page.id]),
    })),
    options: { ...extra, fileName, author },
  };
}

/**
 * A plan for one page on its own, upright and uncropped, with every change the editor holds for it and with only the
 * given added objects drawn: the file that comes out is that page with those objects made part of it.
 */
export async function buildPagePlan(store: EditorStore, pageId: string, objectIds: readonly string[], fileName: string): Promise<ExportPlan> {
  const doc = store.doc;
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) throw new Error("That page is no longer in the document.");
  if (page.source !== null) await store.analyze(page);
  const source = page.source === null ? undefined : store.source(page.source);
  if (page.source !== null && !source) throw new Error("A source document is no longer open.");
  const chosen = new Set(objectIds);
  return {
    sources: source && page.source ? [{ id: page.source, name: source.info.name, bytes: source.bytes, password: source.password, pageCount: source.info.pageCount }] : [],
    pages: [
      {
        source: page.source,
        index: page.index,
        width: page.width,
        height: page.height,
        rotation: 0,
        crop: null,
        objects: (doc.objects[page.id] ?? []).filter((o) => chosen.has(o.id)),
        edits: editsOn(doc, page.id),
        objectEdits: ((analysis, edits) => (analysis && edits ? toEngineEdits(analysis, edits) : []))(store.getPageData(page.id).analysis, doc.existing[page.id]),
      },
    ],
    options: { fileName, author: "" },
  };
}

/** A safe, sensible name for the downloaded file. */
export function suggestName(original: string): string {
  const stem = original.replace(/\.pdf$/i, "");
  return `${stem}_edited.pdf`;
}
