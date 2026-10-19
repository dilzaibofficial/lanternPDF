import { describe, expect, it } from "vitest";
import {
  addObject,
  addObjects,
  allObjects,
  clearTextEdit,
  deletePages,
  duplicateObjects,
  duplicatePages,
  editsOn,
  findObject,
  insertBlankPage,
  insertSourcePages,
  moveObjectToPage,
  movePages,
  objectsOn,
  removeObjects,
  reorderObjects,
  replacePage,
  rotatePages,
  setCrop,
  setPageSize,
  setTextEdit,
  unusedSources,
  updateObject,
  updateObjects,
} from "../../../src/editor/model/ops";
import { type DocState, EMPTY_DOC, type EditorObject, type PageEntry, type ShapeObject, type SourceDoc } from "../../../src/editor/model/types";

const source: SourceDoc = { id: "s1", name: "a.pdf", pageCount: 3, sizes: [{ width: 600, height: 800, rotation: 0 }, { width: 600, height: 800, rotation: 0 }, { width: 800, height: 600, rotation: 0 }], signed: false };
const page = (id: string, index: number): PageEntry => ({ id, source: "s1", index, width: 600, height: 800, rotation: 0, crop: null });
const rect = (id: string, pageId: string): ShapeObject => ({ id, page: pageId, kind: "rect", x: 10, y: 10, width: 50, height: 30, rotation: 0, opacity: 1, fill: "#ff0", stroke: "#000", strokeWidth: 1, strokeStyle: "solid", radius: 0 });

const doc = (): DocState => ({ ...EMPTY_DOC, sources: { s1: source }, pages: [page("p1", 0), page("p2", 1), page("p3", 2)] });

describe("objects", () => {
  it("adds, finds and removes objects without touching the original state", () => {
    const start = doc();
    const withOne = addObject(start, rect("a", "p1"));
    expect(objectsOn(start, "p1")).toHaveLength(0);
    expect(objectsOn(withOne, "p1")).toHaveLength(1);
    expect(findObject(withOne, "a")).toMatchObject({ page: "p1", index: 0 });
    const without = removeObjects(withOne, ["a"]);
    expect(objectsOn(without, "p1")).toHaveLength(0);
    expect(removeObjects(without, ["nothing"])).toBe(without);
  });

  it("updates fields that exist and ignores ones that do not, and never changes identity fields", () => {
    const d = addObject(doc(), rect("a", "p1"));
    const moved = updateObject(d, "a", { x: 99, nonsense: 1, id: "other", page: "p2", kind: "ellipse" });
    expect(findObject(moved, "a")?.object).toMatchObject({ x: 99, id: "a", page: "p1", kind: "rect" });
    expect("nonsense" in (findObject(moved, "a")?.object as object)).toBe(false);
    expect(updateObject(d, "a", { x: 10 })).toBe(d); // same value: no new state
    expect(updateObject(d, "missing", { x: 1 })).toBe(d);
  });

  it("applies several patches at once", () => {
    const d = addObjects(doc(), [rect("a", "p1"), rect("b", "p2")]);
    const next = updateObjects(d, [{ id: "a", patch: { width: 70 } }, { id: "b", patch: { opacity: 0.5 } }]);
    expect(findObject(next, "a")?.object).toMatchObject({ width: 70 });
    expect(findObject(next, "b")?.object).toMatchObject({ opacity: 0.5 });
  });

  it("reorders objects in the stacking order", () => {
    let d = addObjects(doc(), [rect("a", "p1"), rect("b", "p1"), rect("c", "p1")]);
    const ids = (state: DocState) => objectsOn(state, "p1").map((o) => o.id);
    expect(ids(reorderObjects(d, ["a"], "front"))).toEqual(["b", "c", "a"]);
    expect(ids(reorderObjects(d, ["c"], "back"))).toEqual(["c", "a", "b"]);
    expect(ids(reorderObjects(d, ["a"], "forward"))).toEqual(["b", "a", "c"]);
    expect(ids(reorderObjects(d, ["c"], "backward"))).toEqual(["a", "c", "b"]);
    expect(ids(reorderObjects(d, ["c"], "forward"))).toEqual(["a", "b", "c"]); // already on top
    expect(reorderObjects(d, ["c"], "forward")).toBe(d);
    d = reorderObjects(d, ["a", "b"], "front");
    expect(ids(d)).toEqual(["c", "a", "b"]);
  });

  it("duplicates objects with new ids and an offset, onto the same or another page", () => {
    const d = addObject(doc(), rect("a", "p1"));
    const copy = duplicateObjects(d, ["a"], { dx: 5, dy: 7 });
    expect(copy.ids).toHaveLength(1);
    expect(copy.ids[0]).not.toBe("a");
    expect(findObject(copy.doc, copy.ids[0] as string)?.object).toMatchObject({ x: 15, y: 17, page: "p1" });
    const onOther = duplicateObjects(d, ["a"], { dx: 0, dy: 0 }, "p2");
    expect(findObject(onOther.doc, onOther.ids[0] as string)?.page).toBe("p2");
    expect(allObjects(onOther.doc)).toHaveLength(2);
  });

  it("moves an object to another page", () => {
    const d = addObject(doc(), rect("a", "p1"));
    const moved = moveObjectToPage(d, "a", "p3");
    expect(findObject(moved, "a")).toMatchObject({ page: "p3" });
    expect(moveObjectToPage(d, "a", "p1")).toBe(d);
  });
});

describe("text edits", () => {
  it("records an edit per line, replaces it, and clears it", () => {
    let d = setTextEdit(doc(), "p1", { lineId: "page#3", text: "New" });
    d = setTextEdit(d, "p1", { lineId: "page#9", text: "Other" });
    expect(editsOn(d, "p1")).toHaveLength(2);
    const again = setTextEdit(d, "p1", { lineId: "page#3", text: "New" });
    expect(again).toBe(d);
    d = setTextEdit(d, "p1", { lineId: "page#3", text: "Newer" });
    expect(editsOn(d, "p1").find((e) => e.lineId === "page#3")?.text).toBe("Newer");
    d = clearTextEdit(d, "p1", "page#3");
    expect(editsOn(d, "p1")).toHaveLength(1);
    d = clearTextEdit(d, "p1", "page#9");
    expect(d.textEdits.p1).toBeUndefined();
    expect(clearTextEdit(d, "p1", "page#9")).toBe(d);
  });
});

describe("pages", () => {
  it("rotates pages by quarter turns, wrapping around", () => {
    let d = rotatePages(doc(), ["p1", "p2"], 90);
    expect(d.pages.map((p) => p.rotation)).toEqual([90, 90, 0]);
    d = rotatePages(d, ["p1"], 270);
    d = rotatePages(d, ["p2"], -90);
    expect(d.pages.map((p) => p.rotation)).toEqual([0, 0, 0]);
    d = rotatePages(d, ["p3"], 180);
    expect(d.pages[2]?.rotation).toBe(180);
  });

  it("deletes pages with their objects and edits, but never all of them", () => {
    let d = addObject(doc(), rect("a", "p2"));
    d = setTextEdit(d, "p2", { lineId: "x", text: "y" });
    const next = deletePages(d, ["p2"]);
    expect(next.pages.map((p) => p.id)).toEqual(["p1", "p3"]);
    expect(next.objects.p2).toBeUndefined();
    expect(next.textEdits.p2).toBeUndefined();
    expect(deletePages(d, ["p1", "p2", "p3"])).toBe(d);
    expect(deletePages(d, ["nope"])).toBe(d);
  });

  it("moves pages to a new place in the order", () => {
    const d = doc();
    expect(movePages(d, ["p3"], 0).pages.map((p) => p.id)).toEqual(["p3", "p1", "p2"]);
    expect(movePages(d, ["p1"], 2).pages.map((p) => p.id)).toEqual(["p2", "p3", "p1"]);
    expect(movePages(d, ["p1", "p2"], 1).pages.map((p) => p.id)).toEqual(["p3", "p1", "p2"]);
    expect(movePages(d, ["p1"], 0)).toBe(d);
    expect(movePages(d, ["p1"], 99).pages.map((p) => p.id)).toEqual(["p2", "p3", "p1"]);
  });

  it("duplicates a page with copies of its objects and edits, right after the original", () => {
    let d = addObject(doc(), rect("a", "p2"));
    d = setTextEdit(d, "p2", { lineId: "l", text: "t" });
    const result = duplicatePages(d, ["p2"]);
    expect(result.doc.pages.map((p) => p.index)).toEqual([0, 1, 1, 2]);
    const copyId = result.ids[0] as string;
    expect(result.doc.pages[2]?.id).toBe(copyId);
    expect(objectsOn(result.doc, copyId)).toHaveLength(1);
    expect(objectsOn(result.doc, copyId)[0]?.id).not.toBe("a");
    expect(objectsOn(result.doc, copyId)[0]?.page).toBe(copyId);
    expect(editsOn(result.doc, copyId)).toHaveLength(1);
    // the original keeps its own
    expect(objectsOn(result.doc, "p2")[0]?.id).toBe("a");
  });

  it("inserts a blank page and pages from another document", () => {
    const blank = insertBlankPage(doc(), 0, { width: 300, height: 400 });
    expect(blank.doc.pages.map((p) => p.id)[1]).toBe(blank.id);
    expect(blank.doc.pages[1]).toMatchObject({ source: null, width: 300, height: 400 });
    const atStart = insertBlankPage(doc(), -1, { width: 1, height: 1 });
    expect(atStart.doc.pages[0]?.id).toBe(atStart.id);
    const other: SourceDoc = { id: "s2", name: "b.pdf", pageCount: 2, sizes: [{ width: 300, height: 300, rotation: 0 }, { width: 200, height: 100, rotation: 90 }], signed: false };
    const inserted = insertSourcePages(doc(), 1, other, [0, 1]);
    expect(inserted.doc.pages.map((p) => p.source)).toEqual(["s1", "s1", "s2", "s2", "s1"]);
    expect(inserted.doc.pages[3]).toMatchObject({ width: 200, height: 100 });
    expect(inserted.doc.sources.s2).toBeDefined();
  });

  it("replaces a page with another and drops edits of the old text", () => {
    let d = setTextEdit(addObject(doc(), rect("a", "p1")), "p1", { lineId: "l", text: "t" });
    const other: SourceDoc = { id: "s2", name: "b.pdf", pageCount: 1, sizes: [{ width: 300, height: 300, rotation: 0 }], signed: false };
    d = replacePage(d, "p1", other, 0);
    expect(d.pages[0]).toMatchObject({ source: "s2", index: 0, width: 300, rotation: 0 });
    expect(objectsOn(d, "p1")).toHaveLength(1);
    expect(editsOn(d, "p1")).toHaveLength(0);
    expect(unusedSources(d)).toEqual([]);
    const onlyOther = deletePages(replacePage(replacePage(d, "p2", other, 0), "p3", other, 0), ["p2", "p3"]);
    expect(unusedSources(onlyOther)).toEqual(["s1"]);
  });

  it("sets a crop and a size", () => {
    const d = setCrop(doc(), "p1", { top: 10, right: 20, bottom: 30, left: 40 });
    expect(d.pages[0]?.crop).toEqual({ top: 10, right: 20, bottom: 30, left: 40 });
    expect(setCrop(d, "p1", null).pages[0]?.crop).toBeNull();
    expect(setPageSize(doc(), "p2", { width: 100, height: 200 }).pages[1]).toMatchObject({ width: 100, height: 200 });
  });

  it("never mutates the state it is given", () => {
    const d = doc();
    const snapshot = JSON.stringify(d);
    addObject(d, rect("a", "p1"));
    rotatePages(d, ["p1"], 90);
    deletePages(d, ["p1"]);
    movePages(d, ["p3"], 0);
    duplicatePages(d, ["p1"]);
    insertBlankPage(d, 0, { width: 1, height: 1 });
    setTextEdit(d, "p1", { lineId: "a", text: "b" });
    expect(JSON.stringify(d)).toBe(snapshot);
  });

  it("does not let an object end up on a page that was deleted", () => {
    const d = deletePages(addObject(doc(), rect("a", "p2")), ["p2"]);
    expect(allObjects(d)).toEqual([] as EditorObject[]);
  });
});
