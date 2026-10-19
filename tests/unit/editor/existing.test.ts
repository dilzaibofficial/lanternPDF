import { describe, expect, it } from "vitest";
import { EngineSession } from "../../../src/lib/pdf/engine/session";
import { groupTextBlocks } from "../../../src/editor/model/blocks";
import { existingId, existingObjects, isExistingId, parseExistingId, toEngineEdits } from "../../../src/editor/model/existing";
import { alignWithin, boundsOf, carryPoint, hits, translate } from "../../../src/editor/model/geometry";
import { addSource, deletePages, duplicatePages, patchExistingEdit, replacePage, setExistingEdit } from "../../../src/editor/model/ops";
import { EMPTY_DOC, type DocState, type ExistingObject, type PageEntry } from "../../../src/editor/model/types";
import { fixtureBytes } from "../../fixtures/build";

const analysisOf = async (name: string) => (await EngineSession.open({ name, bytes: fixtureBytes(name) })).analyze(0);
const named = (objects: ExistingObject[], label: string, nth = 0) => {
  const found = objects.filter((o) => o.label === label)[nth];
  if (!found) throw new Error(`no ${label} #${nth}`);
  return found;
};

describe("text blocks", () => {
  it("joins the lines of a paragraph and keeps a heading and a table cell apart", async () => {
    const analysis = await analysisOf("pdfkit-standard.pdf");
    const blocks = groupTextBlocks(analysis.lines);
    const paragraph = blocks.find((b) => b.lines.some((l) => l.text.startsWith("The company grew")));
    expect(paragraph?.lines.length).toBeGreaterThan(1);
    const title = blocks.find((b) => b.lines.some((l) => l.text === "Annual Report"));
    expect(title?.lines).toHaveLength(1);
    // Every visible line is in exactly one block.
    const seen = blocks.flatMap((b) => b.lines.map((l) => l.id));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(analysis.lines.filter((l) => !l.invisible && l.text.trim() !== "").length);
  });

  it("treats the two lines inside a drawn box as one block", async () => {
    const analysis = await analysisOf("objects.pdf");
    const blocks = groupTextBlocks(analysis.lines);
    expect(blocks.map((b) => b.lines.map((l) => l.text))).toEqual([["Objects page"], ["Boxed line one", "Boxed line two"]]);
    expect(blocks[1]?.box.y).toBeCloseTo(256.384, 2);
  });
});

describe("existing objects as editor objects", () => {
  it("builds one object per image, shape and block of text, bottom first", async () => {
    const analysis = await analysisOf("objects.pdf");
    const objects = existingObjects("p1", analysis, undefined);
    expect(objects.map((o) => o.label)).toEqual(["Text line", "Triangle", "Image", "Rectangle", "Rectangle", "Text block", "Rectangle", "Line"]);
    expect(objects.every((o) => o.kind === "existing" && o.page === "p1" && o.id.startsWith("p1~"))).toBe(true);
    const orders = objects.map((o) => o.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    const image = named(objects, "Image");
    expect(image).toMatchObject({ what: "image", x: 220, y: 140, width: 120, height: 60, canMove: true, canResize: true, canRotate: true, edited: false });
  });

  it("applies a recorded move, leaves removed things out and says what was changed", async () => {
    const analysis = await analysisOf("objects.pdf");
    const triangle = named(existingObjects("p1", analysis, undefined), "Triangle");
    const edits = { [triangle.key]: { place: { ...triangle.origin, x: 200, y: 300 } } };
    const moved = named(existingObjects("p1", analysis, edits), "Triangle");
    expect(moved).toMatchObject({ x: 200, y: 300, edited: true });
    expect(moved.origin).toEqual(triangle.origin);
    const without = existingObjects("p1", analysis, { [triangle.key]: { deleted: true } });
    expect(without.some((o) => o.label === "Triangle")).toBe(false);
  });

  it("moves a block of text by moving all its lines, and removing it removes them all", async () => {
    const analysis = await analysisOf("objects.pdf");
    const block = named(existingObjects("p1", analysis, undefined), "Text block");
    expect(block.lines).toHaveLength(2);
    const edits = { [block.key]: { place: { ...block.origin, x: block.origin.x + 30, y: block.origin.y + 10 } } };
    const moved = named(existingObjects("p1", analysis, edits), "Text block");
    expect(moved.lines?.[0]?.box.x).toBeCloseTo((block.lines?.[0]?.box.x ?? 0) + 30, 3);
    expect(toEngineEdits(analysis, edits)).toEqual(block.lines?.map((l) => ({ id: l.id, move: { dx: 30, dy: 10 } })));
    expect(toEngineEdits(analysis, { [block.key]: { deleted: true } })).toEqual(block.lines?.map((l) => ({ id: l.id, delete: true })));
  });

  it("turns an object's edit into the engine's change, and drops edits that change nothing", async () => {
    const analysis = await analysisOf("objects.pdf");
    const image = named(existingObjects("p1", analysis, undefined), "Image");
    expect(toEngineEdits(analysis, { [image.key]: { place: { ...image.origin, width: 60 }, order: "back" } })).toEqual([{ id: image.key, target: { ...image.origin, width: 60 }, order: "back" }]);
    expect(toEngineEdits(analysis, { [image.key]: { place: image.origin } })).toEqual([]);
    expect(toEngineEdits(analysis, { "page#999": { deleted: true } })).toEqual([]);
  });

  it("ids name the page and the object, and can be taken apart again", () => {
    const id = existingId("p7", "page/Fm1@3#12");
    expect(isExistingId(id)).toBe(true);
    expect(isExistingId("o1-abc")).toBe(false);
    expect(parseExistingId(id)).toEqual({ page: "p7", key: "page/Fm1@3#12" });
  });

  it("locks what the engine cannot change and gives the reason", async () => {
    const analysis = await analysisOf("objects.pdf");
    const locked = { ...analysis, objects: analysis.objects.map((o, i) => (i === 0 ? { ...o, canMove: false, canResize: false, canRotate: false, reason: "In a reusable block." } : o)) };
    const first = existingObjects("p1", locked, undefined).find((o) => o.reason === "In a reusable block.");
    expect(first).toMatchObject({ locked: true, canMove: false });
  });
});

describe("clicking on existing objects", () => {
  it("hits a triangle inside its outline but not in the empty corner of its box", async () => {
    const analysis = await analysisOf("objects.pdf");
    const triangle = named(existingObjects("p1", analysis, undefined), "Triangle");
    // Apex up: box 60..160 × 120..200, apex at (110, 120).
    expect(hits(triangle, { x: 110, y: 180 }, 2)).toBe(true);
    expect(hits(triangle, { x: 65, y: 125 }, 2)).toBe(false);
    expect(hits(triangle, { x: 155, y: 125 }, 2)).toBe(false);
    expect(hits(triangle, { x: 110, y: 119 }, 2)).toBe(true);
  });

  it("keeps hitting the real shape after it has been moved and turned", async () => {
    const analysis = await analysisOf("objects.pdf");
    const triangle = named(existingObjects("p1", analysis, undefined), "Triangle");
    const place = { x: 200, y: 300, width: 100, height: 80, rotation: 180 };
    const moved = named(existingObjects("p1", analysis, { [triangle.key]: { place } }), "Triangle");
    // Turned upside down about (250, 340): the wide side is now on top.
    expect(hits(moved, { x: 250, y: 305 }, 2)).toBe(true);
    expect(hits(moved, { x: 205, y: 375 }, 2)).toBe(false);
    expect(hits(moved, { x: 110, y: 180 }, 2)).toBe(false);
    const apex = carryPoint(moved, [110, 120]);
    expect(apex.x).toBeCloseTo(250, 3);
    expect(apex.y).toBeCloseTo(380, 3);
  });

  it("hits a drawn frame on its edge but lets a click through its inside", async () => {
    const analysis = await analysisOf("objects.pdf");
    const frame = named(existingObjects("p1", analysis, undefined), "Rectangle", 1);
    expect(frame).toMatchObject({ filled: false, stroked: true });
    expect(hits(frame, { x: 200, y: 290 }, 3)).toBe(false);
    expect(hits(frame, { x: 60, y: 290 }, 3)).toBe(true);
    expect(hits(frame, { x: 200, y: 240 }, 3)).toBe(true);
  });

  it("hits a block of text on its lines and not in the gaps beside them", async () => {
    const analysis = await analysisOf("objects.pdf");
    const block = named(existingObjects("p1", analysis, undefined), "Text block");
    const first = block.lines?.[0]?.box as { x: number; y: number; width: number; height: number };
    expect(hits(block, { x: first.x + 5, y: first.y + 5 }, 2)).toBe(true);
    expect(hits(block, { x: first.x + first.width + 40, y: first.y + 5 }, 2)).toBe(false);
  });

  it("lets objects move, align and snap like any other", async () => {
    const analysis = await analysisOf("objects.pdf");
    const image = named(existingObjects("p1", analysis, undefined), "Image");
    expect(boundsOf(translate(image, 10, -5))).toMatchObject({ x: 230, y: 135 });
    // Centre on a 400-wide page: 220..340 is already 120 wide, so it moves 80 to the left.
    expect(alignWithin([boundsOf(image)], "centre", { x: 0, y: 0, width: 400, height: 500 })).toEqual([{ dx: -80, dy: 0 }]);
  });
});

describe("recording changes to existing objects", () => {
  const base = (): DocState => {
    const page: PageEntry = { id: "p1", source: "s1", index: 0, width: 400, height: 500, rotation: 0, crop: null };
    return addSource({ ...EMPTY_DOC, pages: [page] }, { id: "s1", name: "a.pdf", pageCount: 1, sizes: [{ width: 400, height: 500, rotation: 0 }], signed: false });
  };

  it("keeps only changes that mean something", () => {
    const place = { x: 1, y: 2, width: 3, height: 4, rotation: 0 };
    let doc = setExistingEdit(base(), "p1", "k", { place });
    expect(doc.existing.p1?.k).toEqual({ place });
    expect(setExistingEdit(doc, "p1", "k", { place })).toBe(doc);
    doc = patchExistingEdit(doc, "p1", "k", { place: null });
    expect(doc.existing).toEqual({});
    doc = patchExistingEdit(base(), "p1", "k", { deleted: true });
    expect(doc.existing.p1?.k).toEqual({ deleted: true });
    // Once removed, other changes do not matter.
    expect(patchExistingEdit(doc, "p1", "k", { place })).toBe(doc);
  });

  it("goes along with a duplicated page and goes away with a deleted or replaced one", () => {
    let doc = setExistingEdit(base(), "p1", "k", { deleted: true });
    const copy = duplicatePages(doc, ["p1"]);
    const newId = copy.ids[0] as string;
    expect(copy.doc.existing[newId]).toEqual({ k: { deleted: true } });
    expect(deletePages(copy.doc, [newId]).existing[newId]).toBeUndefined();
    doc = replacePage(doc, "p1", { id: "s2", name: "b.pdf", pageCount: 1, sizes: [{ width: 400, height: 500, rotation: 0 }], signed: false }, 0);
    expect(doc.existing.p1).toBeUndefined();
  });
});
