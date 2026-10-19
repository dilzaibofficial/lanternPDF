import { translate } from "./geometry";
import type { DocState, EditorObject, ExistingEdit, Id, Margins, PageEntry, Rotation, SourceDoc, TextEditRecord } from "./types";

/**
 * Every change to the document is one of these pure functions: state in, new state out, nothing mutated. The editor
 * wraps each call with a label for the history, and tests exercise them without any screen.
 */

let counter = 0;
export function newId(prefix = "o"): Id {
  counter += 1;
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}${counter.toString(36)}-${random}`;
}

// ---- lookup ---------------------------------------------------------------------------------------------------------

export const pageById = (doc: DocState, id: Id): PageEntry | undefined => doc.pages.find((p) => p.id === id);
export const pageIndexOf = (doc: DocState, id: Id): number => doc.pages.findIndex((p) => p.id === id);
export const objectsOn = (doc: DocState, pageId: Id): readonly EditorObject[] => doc.objects[pageId] ?? [];

export function findObject(doc: DocState, id: Id): { object: EditorObject; page: Id; index: number } | null {
  for (const [page, list] of Object.entries(doc.objects)) {
    const index = list.findIndex((o) => o.id === id);
    if (index >= 0) return { object: list[index] as EditorObject, page, index };
  }
  return null;
}

export const allObjects = (doc: DocState): EditorObject[] => Object.values(doc.objects).flat();

// ---- objects --------------------------------------------------------------------------------------------------------

export function addObjects(doc: DocState, objects: readonly EditorObject[]): DocState {
  if (objects.length === 0) return doc;
  const next = { ...doc.objects };
  for (const object of objects) next[object.page] = [...(next[object.page] ?? []), object];
  return { ...doc, objects: next };
}

export const addObject = (doc: DocState, object: EditorObject): DocState => addObjects(doc, [object]);

export type ObjectPatch = Partial<Record<string, unknown>>;

/** Fields every object may have but most do not until they are set. */
const OPTIONAL_FIELDS = new Set(["behind", "group", "locked"]);

/** Applies changes to objects by id. Fields that do not exist on the object's kind are ignored. */
export function updateObjects(doc: DocState, patches: readonly { id: Id; patch: ObjectPatch }[]): DocState {
  if (patches.length === 0) return doc;
  const byId = new Map(patches.map((p) => [p.id, p.patch]));
  let changed = false;
  const next: Record<Id, EditorObject[]> = {};
  for (const [page, list] of Object.entries(doc.objects)) {
    next[page] = list.map((object) => {
      const patch = byId.get(object.id);
      if (!patch) return object;
      const merged = { ...object } as Record<string, unknown>;
      let touched = false;
      for (const [key, value] of Object.entries(patch)) {
        if (key === "id" || key === "page" || key === "kind") continue;
        if (!(key in object) && !OPTIONAL_FIELDS.has(key)) continue;
        if (value === undefined) {
          if (key in merged) {
            delete merged[key];
            touched = true;
          }
        } else if (merged[key] !== value) {
          merged[key] = value;
          touched = true;
        }
      }
      if (!touched) return object;
      changed = true;
      return merged as unknown as EditorObject;
    });
  }
  return changed ? { ...doc, objects: next } : doc;
}

export const updateObject = (doc: DocState, id: Id, patch: ObjectPatch): DocState => updateObjects(doc, [{ id, patch }]);

/** Replaces whole objects (used by drags, which compute the final shape). */
export function replaceObjects(doc: DocState, replacements: readonly EditorObject[]): DocState {
  if (replacements.length === 0) return doc;
  const byId = new Map(replacements.map((o) => [o.id, o]));
  const next: Record<Id, EditorObject[]> = {};
  let changed = false;
  for (const [page, list] of Object.entries(doc.objects)) {
    next[page] = list.map((object) => {
      const replacement = byId.get(object.id);
      if (!replacement || replacement === object) return object;
      changed = true;
      return replacement;
    });
  }
  return changed ? { ...doc, objects: next } : doc;
}

export function removeObjects(doc: DocState, ids: readonly Id[]): DocState {
  if (ids.length === 0) return doc;
  const gone = new Set(ids);
  let changed = false;
  const next: Record<Id, EditorObject[]> = {};
  for (const [page, list] of Object.entries(doc.objects)) {
    const kept = list.filter((o) => !gone.has(o.id));
    if (kept.length !== list.length) changed = true;
    next[page] = kept;
  }
  return changed ? { ...doc, objects: next } : doc;
}

export type ZMove = "front" | "back" | "forward" | "backward";

export function reorderObjects(doc: DocState, ids: readonly Id[], how: ZMove): DocState {
  const chosen = new Set(ids);
  let changed = false;
  const next: Record<Id, EditorObject[]> = { ...doc.objects };
  for (const [page, list] of Object.entries(doc.objects)) {
    if (!list.some((o) => chosen.has(o.id))) continue;
    const picked = list.filter((o) => chosen.has(o.id));
    const rest = list.filter((o) => !chosen.has(o.id));
    let result: EditorObject[];
    if (how === "front") result = [...rest, ...picked];
    else if (how === "back") result = [...picked, ...rest];
    else {
      result = [...list];
      const order = how === "forward" ? [...result.keys()].reverse() : [...result.keys()];
      for (const i of order) {
        const j = how === "forward" ? i + 1 : i - 1;
        if (!chosen.has((result[i] as EditorObject).id) || j < 0 || j >= result.length || chosen.has((result[j] as EditorObject).id)) continue;
        [result[i], result[j]] = [result[j] as EditorObject, result[i] as EditorObject];
      }
    }
    if (result.some((o, i) => o !== list[i])) changed = true;
    next[page] = result;
  }
  return changed ? { ...doc, objects: next } : doc;
}

/** Copies objects, offset a little, with new ids. Returns the new document and the ids of the copies. */
export function duplicateObjects(doc: DocState, ids: readonly Id[], offset = { dx: 12, dy: 12 }, targetPage?: Id): { doc: DocState; ids: Id[] } {
  const copies: EditorObject[] = [];
  for (const id of ids) {
    const found = findObject(doc, id);
    if (!found) continue;
    const moved = translate(found.object, offset.dx, offset.dy);
    copies.push({ ...moved, id: newId(), page: targetPage ?? found.page } as EditorObject);
  }
  return { doc: addObjects(doc, copies), ids: copies.map((c) => c.id) };
}

/** Moves an object to another page, keeping its position on the page. */
export function moveObjectToPage(doc: DocState, id: Id, pageId: Id): DocState {
  const found = findObject(doc, id);
  if (!found || found.page === pageId) return doc;
  const without = removeObjects(doc, [id]);
  return addObject(without, { ...found.object, page: pageId } as EditorObject);
}

// ---- text edits -------------------------------------------------------------------------------------------------------

export function setTextEdit(doc: DocState, pageId: Id, record: TextEditRecord): DocState {
  const pageEdits = doc.textEdits[pageId] ?? {};
  const existing = pageEdits[record.lineId];
  if (existing && existing.text === record.text && JSON.stringify(existing.style) === JSON.stringify(record.style) && existing.fit === record.fit) return doc;
  return { ...doc, textEdits: { ...doc.textEdits, [pageId]: { ...pageEdits, [record.lineId]: record } } };
}

export function clearTextEdit(doc: DocState, pageId: Id, lineId: string): DocState {
  const pageEdits = doc.textEdits[pageId];
  if (!pageEdits || !(lineId in pageEdits)) return doc;
  const { [lineId]: _removed, ...rest } = pageEdits;
  void _removed;
  const next = { ...doc.textEdits };
  if (Object.keys(rest).length === 0) delete next[pageId];
  else next[pageId] = rest;
  return { ...doc, textEdits: next };
}

export const editsOn = (doc: DocState, pageId: Id): TextEditRecord[] => Object.values(doc.textEdits[pageId] ?? {});

// ---- changes to what the page already draws ----------------------------------------------------------------------------

/** An edit that changes nothing is no edit. */
const meaningful = (edit: ExistingEdit): ExistingEdit | null => {
  if (edit.deleted) return { deleted: true };
  const kept: ExistingEdit = {};
  if (edit.place) kept.place = edit.place;
  if (edit.order) kept.order = edit.order;
  return kept.place || kept.order ? kept : null;
};

/** Records (or, with null, forgets) the change to one existing object. */
export function setExistingEdit(doc: DocState, pageId: Id, key: string, edit: ExistingEdit | null): DocState {
  const page = doc.existing[pageId] ?? {};
  const cleaned = edit ? meaningful(edit) : null;
  if (!cleaned) {
    if (!(key in page)) return doc;
    const { [key]: _removed, ...rest } = page;
    void _removed;
    const next = { ...doc.existing };
    if (Object.keys(rest).length === 0) delete next[pageId];
    else next[pageId] = rest;
    return { ...doc, existing: next };
  }
  if (JSON.stringify(page[key]) === JSON.stringify(cleaned)) return doc;
  return { ...doc, existing: { ...doc.existing, [pageId]: { ...page, [key]: cleaned } } };
}

/** Changes some fields of the recorded change to an existing object (null clears a field). */
export function patchExistingEdit(doc: DocState, pageId: Id, key: string, patch: { [K in keyof ExistingEdit]?: ExistingEdit[K] | null }): DocState {
  const current = doc.existing[pageId]?.[key] ?? {};
  const merged: ExistingEdit = { ...current };
  for (const [field, value] of Object.entries(patch) as [keyof ExistingEdit, unknown][]) {
    if (value === null || value === undefined) delete merged[field];
    else (merged as Record<string, unknown>)[field] = value;
  }
  return setExistingEdit(doc, pageId, key, merged);
}

export const existingEditsOn = (doc: DocState, pageId: Id): Readonly<Record<string, ExistingEdit>> | undefined => doc.existing[pageId];

// ---- pages ------------------------------------------------------------------------------------------------------------

export function addSource(doc: DocState, source: SourceDoc): DocState {
  return { ...doc, sources: { ...doc.sources, [source.id]: source } };
}

const turn = (rotation: Rotation, delta: number): Rotation => ((((rotation + delta) % 360) + 360) % 360) as Rotation;

export function rotatePages(doc: DocState, pageIds: readonly Id[], delta: 90 | 180 | 270 | -90): DocState {
  const chosen = new Set(pageIds);
  if (chosen.size === 0) return doc;
  return { ...doc, pages: doc.pages.map((p) => (chosen.has(p.id) ? { ...p, rotation: turn(p.rotation, delta) } : p)) };
}

export function deletePages(doc: DocState, pageIds: readonly Id[]): DocState {
  const gone = new Set(pageIds);
  const pages = doc.pages.filter((p) => !gone.has(p.id));
  if (pages.length === doc.pages.length || pages.length === 0) return doc; // a document keeps at least one page
  const objects = { ...doc.objects };
  const textEdits = { ...doc.textEdits };
  const existing = { ...doc.existing };
  for (const id of gone) {
    delete objects[id];
    delete textEdits[id];
    delete existing[id];
  }
  return { ...doc, pages, objects, textEdits, existing };
}

/** Moves pages so that they start at `toIndex` of the list that remains once they are taken out. */
export function movePages(doc: DocState, pageIds: readonly Id[], toIndex: number): DocState {
  const chosen = new Set(pageIds);
  const moving = doc.pages.filter((p) => chosen.has(p.id));
  const rest = doc.pages.filter((p) => !chosen.has(p.id));
  if (moving.length === 0) return doc;
  const at = Math.max(0, Math.min(rest.length, toIndex));
  const pages = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  return pages.every((p, i) => p === doc.pages[i]) ? doc : { ...doc, pages };
}

/** Puts a copy of each page right after it, with copies of its objects and edits. */
export function duplicatePages(doc: DocState, pageIds: readonly Id[]): { doc: DocState; ids: Id[] } {
  const chosen = new Set(pageIds);
  const pages: PageEntry[] = [];
  const objects = { ...doc.objects };
  const textEdits = { ...doc.textEdits };
  const existing = { ...doc.existing };
  const created: Id[] = [];
  for (const page of doc.pages) {
    pages.push(page);
    if (!chosen.has(page.id)) continue;
    const id = newId("p");
    created.push(id);
    pages.push({ ...page, id });
    objects[id] = (doc.objects[page.id] ?? []).map((o) => ({ ...o, id: newId(), page: id }) as EditorObject);
    if (doc.textEdits[page.id]) textEdits[id] = { ...doc.textEdits[page.id] };
    if (doc.existing[page.id]) existing[id] = { ...doc.existing[page.id] };
  }
  return { doc: { ...doc, pages, objects, textEdits, existing }, ids: created };
}

export function insertBlankPage(doc: DocState, afterIndex: number, size: { width: number; height: number }): { doc: DocState; id: Id } {
  const id = newId("p");
  const page: PageEntry = { id, source: null, index: 0, width: size.width, height: size.height, rotation: 0, crop: null };
  const at = Math.max(-1, Math.min(doc.pages.length - 1, afterIndex)) + 1;
  return { doc: { ...doc, pages: [...doc.pages.slice(0, at), page, ...doc.pages.slice(at)] }, id };
}

export function insertSourcePages(doc: DocState, afterIndex: number, source: SourceDoc, indexes: readonly number[]): { doc: DocState; ids: Id[] } {
  const entries: PageEntry[] = indexes.map((index) => {
    const size = source.sizes[index];
    return { id: newId("p"), source: source.id, index, width: size?.width ?? 595, height: size?.height ?? 842, rotation: 0, crop: null };
  });
  const at = Math.max(-1, Math.min(doc.pages.length - 1, afterIndex)) + 1;
  const withSource = addSource(doc, source);
  return { doc: { ...withSource, pages: [...withSource.pages.slice(0, at), ...entries, ...withSource.pages.slice(at)] }, ids: entries.map((e) => e.id) };
}

/**
 * After a page has been written out with some of its objects merged into it: the page now shows the new file's page, the
 * merged objects and the edits that went into it are gone, and what was not merged stays on top as before.
 */
export function rebasePage(doc: DocState, pageId: Id, source: SourceDoc, mergedIds: readonly Id[]): DocState {
  const withSource = addSource(doc, source);
  const size = source.sizes[0];
  const merged = new Set(mergedIds);
  const textEdits = { ...withSource.textEdits };
  delete textEdits[pageId];
  const existing = { ...withSource.existing };
  delete existing[pageId];
  return {
    ...withSource,
    textEdits,
    existing,
    objects: { ...withSource.objects, [pageId]: (withSource.objects[pageId] ?? []).filter((o) => !merged.has(o.id)) },
    pages: withSource.pages.map((p) => (p.id === pageId ? { ...p, source: source.id, index: 0, width: size?.width ?? p.width, height: size?.height ?? p.height } : p)),
  };
}

/** Swaps what a page shows for another source page. Its objects stay; edits of the old text and of the old page's own items are dropped. */
export function replacePage(doc: DocState, pageId: Id, source: SourceDoc, index: number): DocState {
  const size = source.sizes[index];
  const withSource = addSource(doc, source);
  const textEdits = { ...withSource.textEdits };
  delete textEdits[pageId];
  const existing = { ...withSource.existing };
  delete existing[pageId];
  return {
    ...withSource,
    textEdits,
    existing,
    pages: withSource.pages.map((p) => (p.id === pageId ? { ...p, source: source.id, index, width: size?.width ?? p.width, height: size?.height ?? p.height, rotation: 0, crop: null } : p)),
  };
}

export function setCrop(doc: DocState, pageId: Id, crop: Margins | null): DocState {
  return { ...doc, pages: doc.pages.map((p) => (p.id === pageId ? { ...p, crop } : p)) };
}

/** Changes the size of a blank page, or of any page when its content is to be scaled on export. */
export function setPageSize(doc: DocState, pageId: Id, size: { width: number; height: number }): DocState {
  return { ...doc, pages: doc.pages.map((p) => (p.id === pageId ? { ...p, width: size.width, height: size.height } : p)) };
}

/** Sources that no page uses any more can be released. */
export function unusedSources(doc: DocState): Id[] {
  const used = new Set(doc.pages.map((p) => p.source).filter((s): s is Id => s !== null));
  return Object.keys(doc.sources).filter((id) => !used.has(id));
}
