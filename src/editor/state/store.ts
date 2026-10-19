import { type AppError, toAppError } from "../../lib/errors";
import { runOperation } from "../../lib/worker/client";
import type { PageAnalysis } from "../../lib/pdf/engine/analyze";
import type { ObjectEdit } from "../../lib/pdf/engine/objects";
import type { EditReport, LineEditRequest } from "../../lib/pdf/engine/textEdit";
import type { PdfSource } from "../../lib/pdf/pdfjs";
import { EngineClient } from "../engine/client";
import { type History, canRedo, canUndo, commit, createHistory, isDirty, jumpTo, markSaved, redo, steps, undo } from "../model/history";
import {
  addObjects,
  addSource,
  clearTextEdit,
  deletePages,
  duplicateObjects,
  duplicatePages,
  editsOn,
  findObject,
  existingEditsOn,
  insertBlankPage,
  insertSourcePages,
  movePages,
  newId,
  pageById,
  patchExistingEdit,
  rebasePage,
  removeObjects,
  reorderObjects,
  replaceObjects,
  replacePage,
  rotatePages,
  setCrop,
  setPageSize,
  setTextEdit,
  updateObjects,
} from "../model/ops";
import { existingId, existingObjects, hasExistingEdits, isExistingId, parseExistingId, samePlacement, toEngineEdits } from "../model/existing";
import type { ObjectPatch, ZMove } from "../model/ops";
import { type DocState, EMPTY_DOC, type EditorObject, type ExistingObject, type Id, type Margins, type OrderTarget, type PageEntry, type SourceDoc, type TextEditRecord, type ToolId } from "../model/types";
import { type Alignment, MAX_ZOOM, MIN_ZOOM, alignWithin, boundsOf, boxesOverlap, clamp, distributeShifts, translate, unionBoxes } from "../model/geometry";
import { findInAnalysis } from "./findText";
import { buildPagePlan } from "./plan";
import { DEFAULT_TOOL_DEFAULTS, type ToolDefaults, makeRedaction } from "../model/defaults";

/**
 * The editor's state in one place, written so a screen can subscribe to just the part it shows:
 *
 *  - the **document** (immutable, with history),
 *  - the **view** (tool, zoom, selection, panels: not part of undo),
 *  - the **page data** that is worked out in the background (analysis of a page's text, and the real result of
 *    editing it), each with its own subscription so a finished analysis redraws one page, not the editor.
 *
 * Source documents' bytes live here and are never changed.
 */

export interface Source {
  info: SourceDoc;
  bytes: Uint8Array;
  /** Held in memory only, to read an encrypted document. */
  password?: string;
  pdf: PdfSource;
}

export interface FindMatch {
  page: Id;
  lineId: string;
  /** Code-point range of the match in the line's current text. */
  start: number;
  end: number;
  /** The match as a quadrilateral in display space (four points), for drawing. */
  quad: [number, number][];
}

export interface FindState {
  query: string;
  caseSensitive: boolean;
  matches: FindMatch[];
  /** Index of the match the person is on, or -1. */
  current: number;
  /** Pages whose text has been read so far, and how many there are. */
  progress: { done: number; total: number } | null;
}

export type ZoomMode = "fit-page" | "fit-width" | "custom";
export type ViewMode = "continuous" | "single";

export interface View {
  tool: ToolId;
  zoomMode: ZoomMode;
  zoom: number;
  viewMode: ViewMode;
  /** The page the editor is showing (or the one most in view). */
  currentPage: Id | null;
  selection: Id[];
  /** Pages selected in the page panel. */
  selectedPages: Id[];
  /** The existing line of text that is selected (its properties are shown). */
  line: { page: Id; lineId: string } | null;
  /** Its words are being typed over right now. Off, the line stays selected so its look can be changed. */
  lineEditing: boolean;
  /** The text box being typed in; `isNew` ones are dropped if nothing is typed. */
  editing: { id: Id; isNew: boolean } | null;
  /** A short message about what just happened or why something cannot be done. */
  notice: { id: number; text: string; tone: "info" | "warning" | "success" | "danger" } | null;
  /** Look of the next object of each kind. */
  defaults: ToolDefaults;
  /** Text search across the document, when the find bar is open. */
  find: FindState | null;
  sidebar: boolean;
  panel: boolean;
  snap: boolean;
  grid: boolean;
}

export interface Snapshot {
  doc: DocState;
  view: View;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  steps: { label: string; at: number; current: boolean }[];
  /** When the document was last downloaded. */
  lastExport: number | null;
  name: string;
}

export interface Derived {
  /** Identifies this exact set of edits. */
  key: string;
  pdf: PdfSource;
  report: EditReport | null;
}

export interface PageData {
  analysis: PageAnalysis | null;
  analysisError: AppError | null;
  derived: Derived | null;
  /** True while the real result of the page's edits is being worked out. */
  deriving: boolean;
  deriveError: AppError | null;
}

const NO_EXISTING: readonly ExistingObject[] = [];

const EMPTY_PAGE_DATA: PageData = { analysis: null, analysisError: null, derived: null, deriving: false, deriveError: null };

const DEFAULT_VIEW: View = {
  tool: "select",
  zoomMode: "fit-width",
  zoom: 1,
  viewMode: "continuous",
  currentPage: null,
  selection: [],
  selectedPages: [],
  line: null,
  lineEditing: false,
  editing: null,
  notice: null,
  defaults: DEFAULT_TOOL_DEFAULTS,
  find: null,
  sidebar: true,
  panel: true,
  snap: true,
  grid: false,
};

type Listener = () => void;

class Emitter {
  private readonly listeners = new Set<Listener>();
  on = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

const DERIVE_DELAY_MS = 140;

const sortedEditsKey = (edits: readonly TextEditRecord[], objects: readonly ObjectEdit[] = []): string => JSON.stringify([[...edits].sort((a, b) => a.lineId.localeCompare(b.lineId)), [...objects].sort((a, b) => a.id.localeCompare(b.id))]);

/** A small, stable hash for keys (not for security). */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export class EditorStore {
  readonly engine = new EngineClient();
  private history: History<DocState> = createHistory(EMPTY_DOC, "Open document");
  private view: View = DEFAULT_VIEW;
  private snapshotValue: Snapshot;
  private readonly emitter = new Emitter();
  private readonly sources = new Map<Id, Source>();
  private readonly pageData = new Map<Id, PageData>();
  private readonly pageEmitters = new Map<Id, Emitter>();
  private readonly analysisCache = new Map<string, Promise<PageAnalysis>>();
  private readonly deriveTimers = new Map<Id, ReturnType<typeof setTimeout>>();
  private readonly deriveControllers = new Map<Id, AbortController>();
  private lastExport: number | null = null;
  private name = "document.pdf";
  private disposed = false;
  private readonly objectUrls = new Set<string>();

  constructor() {
    this.snapshotValue = this.buildSnapshot();
  }

  // ---- subscriptions ---------------------------------------------------------------------------------------------------

  subscribe = (listener: Listener): (() => void) => this.emitter.on(listener);
  getSnapshot = (): Snapshot => this.snapshotValue;

  private pageEmitter(id: Id): Emitter {
    let emitter = this.pageEmitters.get(id);
    if (!emitter) {
      emitter = new Emitter();
      this.pageEmitters.set(id, emitter);
    }
    return emitter;
  }

  subscribePage = (id: Id, listener: Listener): (() => void) => this.pageEmitter(id).on(listener);
  getPageData = (id: Id): PageData => this.pageData.get(id) ?? EMPTY_PAGE_DATA;

  private buildSnapshot(): Snapshot {
    return {
      doc: this.history.present.state,
      view: this.view,
      canUndo: canUndo(this.history),
      canRedo: canRedo(this.history),
      dirty: isDirty(this.history),
      steps: steps(this.history),
      lastExport: this.lastExport,
      name: this.name,
    };
  }

  private publish(): void {
    if (this.disposed) return;
    this.snapshotValue = this.buildSnapshot();
    this.emitter.emit();
  }

  private setPageData(id: Id, patch: Partial<PageData>): void {
    this.pageData.set(id, { ...this.getPageData(id), ...patch });
    this.pageEmitter(id).emit();
  }

  // ---- reading --------------------------------------------------------------------------------------------------------

  get doc(): DocState {
    return this.history.present.state;
  }

  get state(): Snapshot {
    return this.snapshotValue;
  }

  source(id: Id): Source | undefined {
    return this.sources.get(id);
  }

  /** What pdf.js should draw for a page: the derived (edited) page when there is one, else the source page. */
  renderSource(page: PageEntry): { pdf: PdfSource; pageNumber: number } | null {
    if (page.source === null) return null;
    const derived = this.getPageData(page.id).derived;
    if (derived && (editsOn(this.doc, page.id).length > 0 || hasExistingEdits(existingEditsOn(this.doc, page.id)))) return { pdf: derived.pdf, pageNumber: 1 };
    const source = this.sources.get(page.source);
    return source ? { pdf: source.pdf, pageNumber: page.index + 1 } : null;
  }

  // ---- opening ----------------------------------------------------------------------------------------------------------

  /** Opens a document (the first one, or one added later). Resolves with the source's id. */
  async addDocument(name: string, bytes: Uint8Array, password?: string): Promise<Id> {
    const id = newId("s");
    const info = await this.engine.open(id, name, bytes, password);
    const source: SourceDoc = { id, name, pageCount: info.pageCount, sizes: info.sizes, signed: info.signed };
    this.sources.set(id, { info: source, bytes, password, pdf: { key: `src:${id}`, bytes, password, name } });
    return id;
  }

  /** Starts a session on the first document: every page becomes a page of the editor. */
  async openFirst(name: string, bytes: Uint8Array, password?: string): Promise<void> {
    const id = await this.addDocument(name, bytes, password);
    const info = (this.sources.get(id) as Source).info;
    const pages: PageEntry[] = info.sizes.map((size, index) => ({ id: newId("p"), source: id, index, width: size.width, height: size.height, rotation: 0, crop: null }));
    this.name = name;
    this.history = createHistory({ ...addSource(EMPTY_DOC, info), pages }, "Open document");
    this.view = { ...DEFAULT_VIEW, currentPage: pages[0]?.id ?? null };
    this.publish();
  }

  // ---- history ------------------------------------------------------------------------------------------------------------

  /** Records a change to the document. */
  apply(label: string, change: (doc: DocState) => DocState, options: { key?: string } = {}): void {
    const before = this.doc;
    const after = change(before);
    if (after === before) return;
    this.history = commit(this.history, after, label, options);
    // Selection may refer to things that are gone.
    const alive = new Set(Object.values(after.objects).flat().map((o) => o.id));
    const selection = this.view.selection.filter((id) => alive.has(id) || this.existingAlive(after, id));
    const pageIds = new Set(after.pages.map((p) => p.id));
    const selectedPages = this.view.selectedPages.filter((id) => pageIds.has(id));
    const line = this.view.line && pageIds.has(this.view.line.page) ? this.view.line : null;
    const currentPage = this.view.currentPage && pageIds.has(this.view.currentPage) ? this.view.currentPage : (after.pages[0]?.id ?? null);
    this.view = { ...this.view, selection, selectedPages, line, currentPage };
    this.afterDocChange(before, after);
    this.publish();
  }

  undo = (): void => {
    const before = this.doc;
    this.history = undo(this.history);
    this.afterHistoryJump(before);
  };

  jump = (index: number): void => {
    const before = this.doc;
    this.history = jumpTo(this.history, index);
    this.afterHistoryJump(before);
  };

  redo = (): void => {
    const before = this.doc;
    this.history = redo(this.history);
    this.afterHistoryJump(before);
  };

  /** Is `id` an existing object of a page that is still there and that has not been removed? */
  private existingAlive(doc: DocState, id: Id): boolean {
    const parsed = parseExistingId(id);
    if (!parsed || !pageById(doc, parsed.page)) return false;
    return !doc.existing[parsed.page]?.[parsed.key]?.deleted;
  }

  private afterHistoryJump(before: DocState): void {
    const after = this.doc;
    const alive = new Set(Object.values(after.objects).flat().map((o) => o.id));
    const pageIds = new Set(after.pages.map((p) => p.id));
    this.view = {
      ...this.view,
      selection: this.view.selection.filter((id) => alive.has(id) || this.existingAlive(after, id)),
      selectedPages: this.view.selectedPages.filter((id) => pageIds.has(id)),
      line: this.view.line && pageIds.has(this.view.line.page) ? this.view.line : null,
      currentPage: this.view.currentPage && pageIds.has(this.view.currentPage) ? this.view.currentPage : (after.pages[0]?.id ?? null),
    };
    this.afterDocChange(before, after);
    this.publish();
  }

  markExported(): void {
    this.history = markSaved(this.history);
    this.lastExport = Date.now();
    this.publish();
  }

  // ---- background work after a change -----------------------------------------------------------------------------------

  private afterDocChange(before: DocState, after: DocState): void {
    for (const page of after.pages) {
      if (before.textEdits[page.id] !== after.textEdits[page.id] || before.existing[page.id] !== after.existing[page.id]) this.scheduleDerive(page.id, before.textEdits[page.id] === after.textEdits[page.id]);
    }
  }

  /** Makes sure a page's analysis exists (and starts reading it if not). */
  analyze(page: PageEntry): Promise<PageAnalysis | null> {
    if (page.source === null) return Promise.resolve(null);
    const key = `${page.source}:${page.index}`;
    let promise = this.analysisCache.get(key);
    if (!promise) {
      promise = this.engine.analyze(page.source, page.index);
      this.analysisCache.set(key, promise);
      promise.catch(() => this.analysisCache.delete(key));
    }
    return promise.then(
      (analysis) => {
        if (this.getPageData(page.id).analysis !== analysis) {
          this.setPageData(page.id, { analysis, analysisError: null });
          // A page duplicated with changes to its objects shows them as soon as it has been read.
          if (hasExistingEdits(existingEditsOn(this.doc, page.id)) && !this.getPageData(page.id).derived) this.scheduleDerive(page.id, true);
        }
        return analysis;
      },
      (error) => {
        this.setPageData(page.id, { analysisError: toAppError(error) });
        return null;
      },
    );
  }

  /** Cached analysis shared by pages that show the same source page (copies of a page). */
  analysisFor(page: PageEntry): PageAnalysis | null {
    return this.getPageData(page.id).analysis;
  }

  /** The engine's changes to what a page already draws, worked out from its analysis (none until the page has been read). */
  private objectEditsOn(pageId: Id): ObjectEdit[] {
    const edits = existingEditsOn(this.doc, pageId);
    const analysis = this.getPageData(pageId).analysis;
    return edits && analysis ? toEngineEdits(analysis, edits) : [];
  }

  /**
   * Starts working out the real result of a page's edits. `immediate` skips the short wait that lets a run of keystrokes
   * become one request: moving or removing something is a single decision, so it is shown at once.
   */
  private scheduleDerive(pageId: Id, immediate = false): void {
    const timer = this.deriveTimers.get(pageId);
    if (timer) clearTimeout(timer);
    this.deriveControllers.get(pageId)?.abort();
    const edits = editsOn(this.doc, pageId);
    const objects = this.objectEditsOn(pageId);
    if (edits.length === 0 && objects.length === 0) {
      this.setPageData(pageId, { derived: null, deriving: false, deriveError: null });
      return;
    }
    this.setPageData(pageId, { deriving: true });
    this.deriveTimers.set(
      pageId,
      setTimeout(() => void this.derive(pageId), immediate ? 0 : DERIVE_DELAY_MS),
    );
  }

  private async derive(pageId: Id): Promise<void> {
    this.deriveTimers.delete(pageId);
    const page = pageById(this.doc, pageId);
    if (!page || page.source === null) return;
    const edits = editsOn(this.doc, pageId);
    const objects = this.objectEditsOn(pageId);
    if (edits.length === 0 && objects.length === 0) return;
    const key = `${pageId}:${hash(sortedEditsKey(edits, objects))}`;
    if (this.getPageData(pageId).derived?.key === key) {
      this.setPageData(pageId, { deriving: false });
      return;
    }
    const controller = new AbortController();
    this.deriveControllers.set(pageId, controller);
    const requests: LineEditRequest[] = edits.map((e) => ({ lineId: e.lineId, text: e.text, style: e.style, fit: e.fit }));
    try {
      const { bytes, report } = await this.engine.derive(page.source, page.index, requests, objects, controller.signal);
      if (controller.signal.aborted || this.disposed) return;
      this.setPageData(pageId, { derived: { key, pdf: { key: `derived:${key}`, bytes, name: "edited page" }, report }, deriving: false, deriveError: null });
      const refused = report?.objects.find((outcome) => outcome.status === "refused");
      if (refused) this.notify(refused.reason ?? "One of the changes to this page could not be made.", "warning");
    } catch (error) {
      if (controller.signal.aborted) return;
      const app = toAppError(error);
      if (app.code === "CANCELLED") return;
      this.setPageData(pageId, { deriving: false, deriveError: app });
    } finally {
      if (this.deriveControllers.get(pageId) === controller) this.deriveControllers.delete(pageId);
    }
  }

  // ---- view -----------------------------------------------------------------------------------------------------------

  setView(patch: Partial<View>): void {
    this.view = { ...this.view, ...patch };
    this.publish();
  }

  setTool(tool: ToolId): void {
    const keepLine = tool === "edit-text" && this.view.line !== null;
    this.setView({ tool, selection: tool === "select" ? this.view.selection : [], line: keepLine ? this.view.line : null, lineEditing: keepLine ? this.view.lineEditing : false, editing: null });
  }

  private noticeCounter = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Shows a short message for a few seconds. */
  notify(text: string, tone: "info" | "warning" | "success" | "danger" = "info"): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    const id = (this.noticeCounter += 1);
    this.setView({ notice: { id, text, tone } });
    this.noticeTimer = setTimeout(() => {
      if (this.view.notice?.id === id) this.setView({ notice: null });
    }, tone === "danger" ? 9000 : 5000);
  }

  dismissNotice(): void {
    this.setView({ notice: null });
  }

  setDefaults(patch: Partial<ToolDefaults>): void {
    this.setView({ defaults: { ...this.view.defaults, ...patch } });
  }

  startEditing(id: Id, isNew = false): void {
    this.setView({ editing: { id, isNew }, selection: [id], line: null, lineEditing: false });
  }

  stopEditing(): void {
    this.setView({ editing: null });
  }

  setZoom(zoom: number, mode: ZoomMode = "custom"): void {
    this.setView({ zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM), zoomMode: mode });
  }

  select(ids: readonly Id[]): void {
    this.setView({ selection: [...ids], line: null, lineEditing: false });
  }

  /** Selects a line of text and, unless told not to, opens it for typing. */
  selectLine(line: View["line"], edit = true): void {
    this.setView({ line, lineEditing: line !== null && edit, selection: [] });
  }

  /** Closes the typing box but keeps the line selected, so its look can be changed in the panel. */
  stopLineEditing(): void {
    if (this.view.lineEditing) this.setView({ lineEditing: false });
  }

  goToPage(id: Id): void {
    this.setView({ currentPage: id });
  }

  // ---- finding text ---------------------------------------------------------------------------------------------------

  private findRun = 0;

  /**
   * Looks for `query` in the text of every page, as the editor sees it (edits included). Pages are read one after
   * another so the search can show progress and be replaced by a newer one.
   */
  async find(query: string, caseSensitive: boolean): Promise<void> {
    const run = (this.findRun += 1);
    if (query === "") {
      this.setView({ find: null });
      return;
    }
    const pages = this.doc.pages.filter((p) => p.source !== null);
    this.setView({ find: { query, caseSensitive, matches: [], current: -1, progress: { done: 0, total: pages.length } } });
    const matches: FindMatch[] = [];
    for (let i = 0; i < pages.length; i += 1) {
      const page = pages[i] as PageEntry;
      const analysis = await this.analyze(page);
      if (run !== this.findRun || this.disposed) return;
      if (analysis) matches.push(...findInAnalysis(this.doc, page, analysis, query, caseSensitive));
      if (i % 3 === 2 || i === pages.length - 1) {
        const first = this.view.find?.current ?? -1;
        this.setView({ find: { query, caseSensitive, matches: [...matches], current: first >= 0 ? first : matches.length > 0 ? 0 : -1, progress: i === pages.length - 1 ? null : { done: i + 1, total: pages.length } } });
      }
    }
    const current = this.view.find?.current ?? -1;
    if (current >= 0) this.revealMatch(current);
  }

  /** Moves to the next or previous match, wrapping around, and shows it. */
  stepFind(direction: 1 | -1): void {
    const find = this.view.find;
    if (!find || find.matches.length === 0) return;
    const current = (find.current + direction + find.matches.length) % find.matches.length;
    this.setView({ find: { ...find, current } });
    this.revealMatch(current);
  }

  private revealMatch(index: number): void {
    const match = this.view.find?.matches[index];
    if (match) this.setView({ currentPage: match.page });
  }

  closeFind(): void {
    this.findRun += 1;
    this.setView({ find: null });
  }

  /**
   * Puts a redaction box over every match of the current search. The words are removed from the file when it is downloaded
   * (see the redaction box), and the boxes can be moved, resized or deleted until then.
   */
  redactMatches(): number {
    const find = this.view.find;
    if (!find || find.matches.length === 0) return 0;
    const boxes = find.matches.map((match) => {
      const xs = match.quad.map((p) => p[0]);
      const ys = match.quad.map((p) => p[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return makeRedaction(match.page, { x: x - 0.5, y: y - 0.5, width: Math.max(...xs) - x + 1, height: Math.max(...ys) - y + 1 }, this.view.defaults);
    });
    this.addObjects(boxes.length === 1 ? "Redact a match" : `Redact ${boxes.length} matches`, boxes, false);
    this.notify(boxes.length === 1 ? "A redaction box was placed over the match. The words are removed when you download." : `${boxes.length} redaction boxes were placed. The words are removed from the file when you download.`, "success");
    return boxes.length;
  }

  /** Replaces one match, or all of them, with `replacement`, as edits of the lines they are in. */
  replaceMatches(which: "current" | "all", replacement: string): number {
    const find = this.view.find;
    if (!find || find.matches.length === 0) return 0;
    const chosen = which === "all" ? find.matches : find.current >= 0 ? [find.matches[find.current] as FindMatch] : [];
    const byLine = new Map<string, FindMatch[]>();
    for (const match of chosen) byLine.set(`${match.page}|${match.lineId}`, [...(byLine.get(`${match.page}|${match.lineId}`) ?? []), match]);
    let count = 0;
    const skipped = new Set<string>();
    this.apply(which === "all" ? `Replace all “${find.query}”` : `Replace “${find.query}”`, (doc) => {
      let next = doc;
      for (const [, list] of byLine) {
        const first = list[0] as FindMatch;
        const page = pageById(next, first.page);
        const analysis = page ? this.getPageData(page.id).analysis : null;
        const line = analysis?.lines.find((l) => l.id === first.lineId);
        if (!line) continue;
        if (line.verdict !== "A") {
          skipped.add(line.text.length > 30 ? `${line.text.slice(0, 30)}…` : line.text);
          continue;
        }
        const existing = next.textEdits[first.page]?.[first.lineId];
        const points = Array.from(existing?.text ?? line.text);
        // Replace from the end so earlier positions stay valid.
        for (const match of [...list].sort((a, b) => b.start - a.start)) {
          points.splice(match.start, match.end - match.start, ...Array.from(replacement));
          count += 1;
        }
        const text = points.join("");
        next = text === line.text ? clearTextEdit(next, first.page, first.lineId) : setTextEdit(next, first.page, { lineId: first.lineId, text, style: { ...(existing?.style ?? {}), align: existing?.style?.align ?? line.align }, fit: existing?.fit });
      }
      return next;
    });
    // The matches are stale now: search again for what is left.
    void this.find(find.query, find.caseSensitive);
    if (skipped.size > 0) this.notify(`Not replaced, because that text cannot be edited: ${[...skipped].slice(0, 3).map((s) => `“${s}”`).join(", ")}${skipped.size > 3 ? ` and ${skipped.size - 3} more` : ""}.`, "warning");
    else if (count > 0) this.notify(count === 1 ? "Replaced 1 match." : `Replaced ${count} matches.`, "success");
    return count;
  }

  // ---- what the page already draws -------------------------------------------------------------------------------------------

  private readonly existingMemo = new Map<Id, { analysis: PageAnalysis; edits: unknown; objects: ExistingObject[] }>();

  /** The existing objects of a page (images, shapes, annotations, blocks of text) with the editor's changes applied, bottom first. */
  existingOn = (pageId: Id): readonly ExistingObject[] => {
    const analysis = this.getPageData(pageId).analysis;
    if (!analysis) return NO_EXISTING;
    const edits = existingEditsOn(this.doc, pageId);
    const memo = this.existingMemo.get(pageId);
    if (memo && memo.analysis === analysis && memo.edits === edits) return memo.objects;
    const objects = existingObjects(pageId, analysis, edits);
    this.existingMemo.set(pageId, { analysis, edits, objects });
    return objects;
  };

  /** Everything selectable on a page: what it already draws, then what was added (bottom first, so the last is on top). */
  objectsOn(pageId: Id): EditorObject[] {
    return [...this.existingOn(pageId), ...(this.doc.objects[pageId] ?? [])];
  }

  /** An object by id, whether it was added or the page already drew it. */
  object(id: Id): EditorObject | null {
    const added = findObject(this.doc, id)?.object;
    if (added) return added;
    const parsed = parseExistingId(id);
    return parsed ? (this.existingOn(parsed.page).find((o) => o.id === id) ?? null) : null;
  }

  objects(ids: readonly Id[]): EditorObject[] {
    return ids.map((id) => this.object(id)).filter((o): o is EditorObject => Boolean(o));
  }

  /** Splits ids into those of added objects and those of existing ones. */
  private partition(ids: readonly Id[]): { added: Id[]; existing: ExistingObject[] } {
    const added: Id[] = [];
    const existing: ExistingObject[] = [];
    for (const id of ids) {
      if (isExistingId(id)) {
        const object = this.object(id);
        if (object?.kind === "existing") existing.push(object);
      } else added.push(id);
    }
    return { added, existing };
  }

  // ---- document actions ------------------------------------------------------------------------------------------------------

  addObjects(label: string, objects: readonly EditorObject[], select = true): void {
    this.apply(label, (doc) => addObjects(doc, objects));
    if (select) this.setView({ selection: objects.map((o) => o.id), line: null });
  }

  updateObjects(label: string, patches: readonly { id: Id; patch: ObjectPatch }[], key?: string): void {
    this.apply(label, (doc) => updateObjects(doc, patches), { key });
  }

  /** Replaces whole objects: added ones as they are, existing ones as a record of where they now are. */
  replaceObjects(label: string, objects: readonly EditorObject[], key?: string): void {
    const added: EditorObject[] = [];
    const existing: ExistingObject[] = [];
    for (const object of objects) {
      if (object.kind === "existing") existing.push(object);
      else added.push(object);
    }
    this.apply(
      label,
      (doc) => {
        let next = replaceObjects(doc, added);
        for (const object of existing) {
          if (!object.canMove) continue;
          const place = { x: object.x, y: object.y, width: object.width, height: object.height, rotation: object.rotation };
          next = patchExistingEdit(next, object.page, object.key, { place: samePlacement(place, object.origin) ? null : place });
        }
        return next;
      },
      { key },
    );
  }

  /** Removes objects: added ones are dropped, things the page already draws are taken out of the saved file. */
  removeObjects(ids: readonly Id[], label = "Delete"): void {
    const { added, existing } = this.partition(ids);
    const blocked = existing.filter((o) => !o.canMove);
    if (blocked.length > 0) this.notify(blocked[0]?.reason ?? "That cannot be removed.", "warning");
    const removable = existing.filter((o) => o.canMove);
    this.apply(label, (doc) => {
      let next = removeObjects(doc, added);
      for (const object of removable) next = patchExistingEdit(next, object.page, object.key, { deleted: true });
      return next;
    });
  }

  /** Puts objects above or below others. Things the page already draws are moved within the page's own drawing order. */
  reorder(ids: readonly Id[], how: ZMove): void {
    const labels: Record<ZMove, string> = { front: "Bring to front", back: "Send to back", forward: "Bring forward", backward: "Send backward" };
    const { added, existing } = this.partition(ids);
    const reorderable = existing.filter((o) => o.canReorder);
    if (existing.length > 0 && reorderable.length === 0 && added.length === 0) {
      this.notify(existing[0]?.what === "text" ? "Text cannot be moved above or below other things on the page, only moved or removed." : (existing[0]?.reason ?? "Its place in the stacking order cannot be changed."), "warning");
      return;
    }
    this.apply(labels[how], (doc) => {
      let next = reorderObjects(doc, added, how);
      for (const object of reorderable) {
        const target = this.orderTarget(object, how);
        if (target) next = patchExistingEdit(next, object.page, object.key, { order: target });
      }
      return next;
    });
  }

  /** Where an existing object goes for a step in the stacking order: the front or back, or past the nearest overlapping one. */
  private orderTarget(object: ExistingObject, how: ZMove): OrderTarget | null {
    if (how === "front") return "front";
    if (how === "back") return "back";
    const siblings = this.existingOn(object.page).filter((o) => o.canReorder && o.id !== object.id);
    const mine = boundsOf(object);
    const overlapping = siblings.filter((o) => boxesOverlap(boundsOf(o), mine));
    if (how === "forward") {
      const above = overlapping.find((o) => o.order > object.order);
      return above ? { after: above.key } : null;
    }
    const below = [...overlapping].reverse().find((o) => o.order < object.order);
    return below ? { before: below.key } : null;
  }

  // ---- arranging ---------------------------------------------------------------------------------------------------------

  /** The visible area of a page, which is what "the page" means for aligning. */
  private pageFrame(pageId: Id): { x: number; y: number; width: number; height: number } | null {
    const page = pageById(this.doc, pageId);
    if (!page) return null;
    const crop = page.crop ?? { top: 0, right: 0, bottom: 0, left: 0 };
    return { x: crop.left, y: crop.top, width: Math.max(1, page.width - crop.left - crop.right), height: Math.max(1, page.height - crop.top - crop.bottom) };
  }

  /** What can be moved by an arrange command: not locked, and not something the page holds in a way that cannot be changed. */
  private movable(ids: readonly Id[]): EditorObject[] {
    return this.objects(ids).filter((o) => !o.locked);
  }

  /**
   * Lines objects up with the page, or with each other. Against the page the selection moves as one: the box that holds it
   * is lined up, so objects keep their places relative to each other.
   */
  alignObjects(ids: readonly Id[], how: Alignment, within: "page" | "selection"): void {
    const objects = this.movable(ids);
    const first = objects[0];
    if (!first) {
      this.notify("Nothing selected can be moved.", "warning");
      return;
    }
    const boxes = objects.map(boundsOf);
    const union = unionBoxes(boxes);
    const page = this.pageFrame(first.page);
    if (!union || !page) return;
    const shifts = within === "page" || objects.length === 1 ? boxes.map(() => (alignWithin([union], how, page)[0] as { dx: number; dy: number })) : alignWithin(boxes, how, union);
    const label = { left: "left", centre: "horizontally", right: "right", top: "top", middle: "vertically", bottom: "bottom" }[how];
    this.replaceObjects(within === "page" || objects.length === 1 ? `Align ${label} on the page` : `Align ${label}`, objects.map((o, i) => translate(o, shifts[i]?.dx ?? 0, shifts[i]?.dy ?? 0)));
  }

  /** Puts the selection in the middle of the page, both ways. */
  centreOnPage(ids: readonly Id[]): void {
    const objects = this.movable(ids);
    const first = objects[0];
    const union = unionBoxes(objects.map(boundsOf));
    const page = first ? this.pageFrame(first.page) : null;
    if (!first || !union || !page) {
      this.notify("Nothing selected can be moved.", "warning");
      return;
    }
    const dx = page.x + page.width / 2 - (union.x + union.width / 2);
    const dy = page.y + page.height / 2 - (union.y + union.height / 2);
    this.replaceObjects("Centre on the page", objects.map((o) => translate(o, dx, dy)));
  }

  /** Spaces three or more objects evenly. */
  distributeObjects(ids: readonly Id[], axis: "x" | "y"): void {
    const objects = this.movable(ids);
    if (objects.length < 3) return;
    const shifts = distributeShifts(objects.map(boundsOf), axis);
    this.replaceObjects(axis === "x" ? "Space evenly across" : "Space evenly down", objects.map((o, i) => translate(o, shifts[i]?.dx ?? 0, shifts[i]?.dy ?? 0)));
  }

  /** Draws added objects behind (or again in front of) everything the page draws itself. */
  setLayer(ids: readonly Id[], behind: boolean): void {
    const { added } = this.partition(ids);
    if (added.length === 0) return;
    this.apply(behind ? "Place behind the page" : "Place in front of the page", (doc) => updateObjects(doc, added.map((id) => ({ id, patch: { behind: behind ? true : undefined } }))));
  }

  /** Makes added objects move, turn and be selected together. */
  group(ids: readonly Id[]): void {
    const { added } = this.partition(ids);
    if (added.length < 2) {
      this.notify("Select two or more objects you added to group them.", "info");
      return;
    }
    const group = newId("g");
    this.apply("Group", (doc) => updateObjects(doc, added.map((id) => ({ id, patch: { group } }))));
  }

  ungroup(ids: readonly Id[]): void {
    const { added } = this.partition(ids);
    const grouped = added.filter((id) => this.object(id)?.group);
    if (grouped.length === 0) return;
    // The whole group goes, not only the members that were selected.
    const groups = new Set(grouped.map((id) => this.object(id)?.group));
    const members = Object.values(this.doc.objects)
      .flat()
      .filter((o) => o.group && groups.has(o.group))
      .map((o) => o.id);
    this.apply("Ungroup", (doc) => updateObjects(doc, members.map((id) => ({ id, patch: { group: undefined } }))));
  }

  /** Makes an added picture as large as the page allows without changing its shape, and centres it. */
  fitToPage(id: Id): void {
    const found = this.findObject(id);
    const frame = found ? this.pageFrame(found.page) : null;
    if (!found || found.object.kind !== "image" || !frame) return;
    const image = found.object;
    const natural = image.image;
    const visibleWidth = natural.width * (1 - (image.crop?.left ?? 0) - (image.crop?.right ?? 0));
    const visibleHeight = natural.height * (1 - (image.crop?.top ?? 0) - (image.crop?.bottom ?? 0));
    const scale = Math.min(frame.width / Math.max(1, visibleWidth), frame.height / Math.max(1, visibleHeight));
    const width = visibleWidth * scale;
    const height = visibleHeight * scale;
    this.apply("Fit to page", (doc) => replaceObjects(doc, [{ ...image, x: frame.x + (frame.width - width) / 2, y: frame.y + (frame.height - height) / 2, width, height, rotation: 0 }]));
  }

  /**
   * Makes added objects part of their page: the page is written out with them drawn into it, and the editor carries on
   * from that file. They can be selected and moved afterwards like anything else the page holds. Everything else
   * stays as it was, including what was not merged.
   */
  async mergeIntoPage(ids: readonly Id[]): Promise<void> {
    const { added } = this.partition(ids);
    const objects = added.map((id) => findObject(this.doc, id)).filter((found): found is NonNullable<typeof found> => found !== null);
    const first = objects[0];
    if (!first) {
      this.notify("Select something you added to merge it into the page.", "info");
      return;
    }
    const pageId = first.page;
    const onThePage = objects.filter((o) => o.page === pageId).map((o) => o.object.id);
    try {
      this.notify("Merging into the page…", "info");
      const plan = await buildPagePlan(this, pageId, onThePage, "merged page.pdf");
      const result = await runOperation("exportDocument", { plan }, {});
      if (this.disposed) return;
      const sourceId = await this.addDocument(`${this.name} (merged page)`, result.bytes);
      const info = (this.sources.get(sourceId) as Source).info;
      this.apply("Merge into page", (doc) => rebasePage(doc, pageId, info, onThePage));
      this.pageData.delete(pageId);
      this.pageEmitter(pageId).emit();
      this.setView({ selection: [] });
      this.notify(onThePage.length > 1 ? `${onThePage.length} objects are now part of the page.` : "The object is now part of the page.", "success");
    } catch (error) {
      this.notify(toAppError(error).message, "danger");
    }
  }

  /**
   * Makes an image the background of its page: it fills the page (cropped, never stretched) and is drawn behind
   * everything the page draws itself.
   */
  setAsBackground(id: Id): void {
    const found = this.findObject(id);
    const page = found ? pageById(this.doc, found.page) : undefined;
    const frame = found ? this.pageFrame(found.page) : null;
    if (!found || found.object.kind !== "image" || !page || !frame) return;
    const image = found.object;
    const natural = image.image;
    const wantAspect = frame.width / frame.height;
    const haveAspect = natural.width / Math.max(1, natural.height);
    // Cover: cut away what does not fit, equally on both sides.
    let crop = { top: 0, right: 0, bottom: 0, left: 0 };
    if (haveAspect > wantAspect) {
      const keep = wantAspect / haveAspect;
      crop = { top: 0, bottom: 0, left: (1 - keep) / 2, right: (1 - keep) / 2 };
    } else if (haveAspect < wantAspect) {
      const keep = haveAspect / wantAspect;
      crop = { left: 0, right: 0, top: (1 - keep) / 2, bottom: (1 - keep) / 2 };
    }
    this.apply("Use as page background", (doc) => replaceObjects(doc, [{ ...image, ...frame, rotation: 0, crop, flipX: image.flipX, flipY: image.flipY, behind: true, opacity: image.opacity }]));
    const covered = this.getPageData(page.id).analysis?.objects.some((o) => o.background);
    if (covered) this.notify("This page paints its own background over the picture. Remove the page's background (Delete it in the selection of the page itself) or put the picture in front.", "warning");
  }

  /** Removes the editor's changes to existing objects: they go back to where they were in the file (removed ones come back). */
  resetExisting(ids: readonly Id[]): void {
    const { existing } = this.partition(ids);
    const parsed = ids.map((id) => parseExistingId(id)).filter((p): p is NonNullable<typeof p> => p !== null);
    if (existing.length === 0 && parsed.length === 0) return;
    this.apply("Restore original", (doc) => {
      let next = doc;
      for (const { page, key } of parsed) next = patchExistingEdit(next, page, key, { deleted: null, place: null, order: null });
      return next;
    });
  }

  /** Brings back everything removed from a page (and undoes every move) in one step. */
  restorePageObjects(pageId: Id): void {
    if (!this.doc.existing[pageId]) return;
    this.apply("Restore the page's items", (doc) => {
      const existing = { ...doc.existing };
      delete existing[pageId];
      return { ...doc, existing };
    });
  }

  /** Puts copies of objects (from the clipboard) on a page, a little offset, and selects them. */
  pasteObjects(objects: readonly EditorObject[], pageId: Id, offset: number): Id[] {
    const copies = objects.map((o) => ({ ...translate(o, offset, offset), id: newId(), page: pageId }) as EditorObject);
    if (copies.length === 0) return [];
    this.addObjects(copies.length > 1 ? `Paste ${copies.length} objects` : "Paste", copies);
    return copies.map((c) => c.id);
  }

  /** Moves objects by an offset (the arrow keys), merging a run of nudges into one history step. */
  moveObjects(objects: readonly EditorObject[], dx: number, dy: number): void {
    this.replaceObjects("Nudge", objects.map((o) => translate(o, dx, dy)), `nudge:${objects.map((o) => o.id).join(",")}`);
  }

  duplicate(ids: readonly Id[], offset?: { dx: number; dy: number }, targetPage?: Id): Id[] {
    let created: Id[] = [];
    const { added, existing } = this.partition(ids);
    if (existing.length > 0) this.notify("Things that are already part of the page cannot be duplicated yet. Add an image or shape from the toolbar instead.", "info");
    if (added.length === 0) return [];
    this.apply("Duplicate", (doc) => {
      const result = duplicateObjects(doc, added, offset, targetPage);
      created = result.ids;
      return result.doc;
    });
    if (created.length > 0) this.setView({ selection: created, line: null });
    return created;
  }

  editText(pageId: Id, record: TextEditRecord): void {
    this.apply(`Edit text “${record.text.length > 24 ? `${record.text.slice(0, 24)}…` : record.text}”`, (doc) => setTextEdit(doc, pageId, record), { key: `text:${pageId}:${record.lineId}` });
  }

  resetTextEdit(pageId: Id, lineId: string): void {
    this.apply("Restore original text", (doc) => clearTextEdit(doc, pageId, lineId));
  }

  rotatePages(ids: readonly Id[], delta: 90 | 180 | 270 | -90): void {
    this.apply(ids.length > 1 ? `Rotate ${ids.length} pages` : "Rotate page", (doc) => rotatePages(doc, ids, delta));
  }

  deletePages(ids: readonly Id[]): void {
    this.apply(ids.length > 1 ? `Delete ${ids.length} pages` : "Delete page", (doc) => deletePages(doc, ids));
  }

  movePages(ids: readonly Id[], toIndex: number): void {
    this.apply(ids.length > 1 ? `Move ${ids.length} pages` : "Move page", (doc) => movePages(doc, ids, toIndex));
  }

  duplicatePages(ids: readonly Id[]): void {
    let created: Id[] = [];
    this.apply(ids.length > 1 ? `Duplicate ${ids.length} pages` : "Duplicate page", (doc) => {
      const result = duplicatePages(doc, ids);
      created = result.ids;
      return result.doc;
    });
    if (created.length > 0) this.setView({ selectedPages: created });
  }

  insertBlank(afterIndex: number, size: { width: number; height: number }): Id | null {
    let id: Id | null = null;
    this.apply("Insert blank page", (doc) => {
      const result = insertBlankPage(doc, afterIndex, size);
      id = result.id;
      return result.doc;
    });
    if (id) this.setView({ currentPage: id, selectedPages: [id] });
    return id;
  }

  async insertFromDocument(name: string, bytes: Uint8Array, afterIndex: number, password?: string, indexes?: number[]): Promise<Id[]> {
    const id = await this.addDocument(name, bytes, password);
    const source = (this.sources.get(id) as Source).info;
    const chosen = indexes ?? source.sizes.map((_, i) => i);
    let created: Id[] = [];
    this.apply(chosen.length > 1 ? `Insert ${chosen.length} pages from ${name}` : `Insert a page from ${name}`, (doc) => {
      const result = insertSourcePages(doc, afterIndex, source, chosen);
      created = result.ids;
      return result.doc;
    });
    if (created[0]) this.setView({ currentPage: created[0], selectedPages: created });
    return created;
  }

  async replaceWithDocumentPage(pageId: Id, name: string, bytes: Uint8Array, index: number, password?: string): Promise<void> {
    const id = await this.addDocument(name, bytes, password);
    const source = (this.sources.get(id) as Source).info;
    this.apply("Replace page", (doc) => replacePage(doc, pageId, source, index));
  }

  setCrop(pageId: Id, crop: Margins | null): void {
    this.apply(crop ? "Crop page" : "Remove crop", (doc) => setCrop(doc, pageId, crop));
  }

  setPageSize(pageId: Id, size: { width: number; height: number }): void {
    this.apply("Change page size", (doc) => setPageSize(doc, pageId, size));
  }

  findObject(id: Id): { object: EditorObject; page: Id; index: number } | null {
    return findObject(this.doc, id);
  }

  /** The id an existing object of a page has (for tests and tools that know a key). */
  existingIdOf(page: Id, key: string): Id {
    return existingId(page, key);
  }

  private readonly imageUrls = new WeakMap<Uint8Array, string>();

  /** A URL the page can draw an added image from; made once per image and revoked when the editor closes. */
  imageUrl = (image: { bytes: Uint8Array; mime: string }): string => {
    let url = this.imageUrls.get(image.bytes);
    if (!url) {
      url = URL.createObjectURL(new Blob([image.bytes as BlobPart], { type: image.mime }));
      this.imageUrls.set(image.bytes, url);
      this.objectUrls.add(url);
    }
    return url;
  };

  // ---- cleanup --------------------------------------------------------------------------------------------------------

  /** Releases the worker, the bytes and every object URL. After this the store is inert. */
  dispose(): void {
    this.disposed = true;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    for (const timer of this.deriveTimers.values()) clearTimeout(timer);
    for (const controller of this.deriveControllers.values()) controller.abort();
    this.deriveTimers.clear();
    this.deriveControllers.clear();
    this.engine.dispose();
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.clear();
    this.sources.clear();
    this.pageData.clear();
    this.analysisCache.clear();
  }
}
