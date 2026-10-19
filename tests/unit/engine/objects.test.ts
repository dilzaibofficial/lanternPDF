import { type PDFDict, PDFDocument, PDFName, type PDFNumber, PDFRef, PDFString } from "@cantoo/pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import type { PageAnalysis } from "../../../src/lib/pdf/engine/analyze";
import type { ObjectEdit } from "../../../src/lib/pdf/engine/objects";
import { EngineSession } from "../../../src/lib/pdf/engine/session";
import { fixtureBytes } from "../../fixtures/build";
import { type Raster, type Region, difference, expectEditedOnlyIn, rasterize } from "../helpers/visual";

/**
 * Existing objects: the editor can find the images, shapes and annotations a page already has, move, resize and turn them,
 * put them above or below each other, and remove them. Every test renders the page before and after with pdf.js and
 * requires that nothing changed except where the object was or now is.
 */

const SCALE = 2;
const open = (name = "objects.pdf") => EngineSession.open({ name, bytes: fixtureBytes(name) });

/** The pixels of a display-space box (display space has its origin at the top left, like the render). */
function pixels(raster: Raster, box: { x: number; y: number; width: number; height: number }, pad = 3): Region {
  return {
    x0: Math.max(0, Math.floor(box.x * SCALE - pad)),
    y0: Math.max(0, Math.floor(box.y * SCALE - pad)),
    x1: Math.min(raster.width, Math.ceil((box.x + box.width) * SCALE + pad)),
    y1: Math.min(raster.height, Math.ceil((box.y + box.height) * SCALE + pad)),
  };
}

const at = (raster: Raster, x: number, y: number): [number, number, number] => {
  const i = (Math.round(y * SCALE) * raster.width + Math.round(x * SCALE)) * 4;
  return [raster.data[i] as number, raster.data[i + 1] as number, raster.data[i + 2] as number];
};
const isWhite = (rgb: number[]) => rgb.every((v) => v > 245);
const isRed = (rgb: number[]) => rgb[0]! > 200 && rgb[1]! < 60 && rgb[2]! < 60;
const isOrange = (rgb: number[]) => rgb[0]! > 200 && rgb[1]! > 100 && rgb[1]! < 160 && rgb[2]! < 60;
const isBlueish = (rgb: number[]) => rgb[2]! > rgb[0]! + 40;

function find(analysis: PageAnalysis, label: string, nth = 0) {
  const found = analysis.objects.filter((o) => o.label === label)[nth];
  if (!found) throw new Error(`no ${label} #${nth}; have ${analysis.objects.map((o) => `${o.label}:${o.id}`).join(", ")}`);
  return found;
}

async function render(session: EngineSession, edits: ObjectEdit[], lineEdits: { lineId: string; text: string }[] = []) {
  const { bytes, report } = await session.derivePage(0, lineEdits, { objects: edits });
  return { bytes, report, raster: await rasterize(bytes, 1, SCALE) };
}

async function pdfjsText(bytes: Uint8Array) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    return content.items
      .filter((item) => "str" in item && item.str.trim() !== "")
      .map((item) => {
        const it = item as { str: string; transform: number[] };
        return { text: it.str, x: it.transform[4] as number, y: it.transform[5] as number };
      });
  } finally {
    await task.destroy();
  }
}

const hasImageObject = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes).includes("/Subtype /Image");

describe("finding the objects of a page", () => {
  it("lists the image, the shapes and the lines in paint order, with names a person would use", async () => {
    const session = await open();
    const analysis = session.analyze(0);
    const ordered = [...analysis.objects].sort((a, b) => a.order - b.order).map((o) => o.label);
    expect(ordered).toEqual(["Triangle", "Image", "Rectangle", "Rectangle", "Rectangle", "Line"]);
    // The title is painted first, then the shapes, the box's two lines last-but-one.
    expect(analysis.lines.map((l) => l.text)).toEqual(["Objects page", "Boxed line one", "Boxed line two"]);
    expect(analysis.lines[0]?.order).toBeLessThan(find(analysis, "Triangle").order);
  });

  it("gives positions in display space (top-left origin) and the real outline of a triangle", async () => {
    const analysis = (await open()).analyze(0);
    const triangle = find(analysis, "Triangle");
    expect(triangle.box).toEqual({ x: 60, y: 120, width: 100, height: 80, rotation: 0 });
    expect(triangle.outline).toHaveLength(1);
    const points = triangle.outline?.[0]?.points ?? [];
    expect(points).toHaveLength(3);
    expect(triangle.outline?.[0]?.closed).toBe(true);
    // Apex up: the point with the smallest y sits over the middle of the base.
    const apex = [...points].sort((a, b) => a[1] - b[1])[0];
    expect(apex?.[0]).toBeCloseTo(110, 1);
    expect(apex?.[1]).toBeCloseTo(120, 1);
    const image = find(analysis, "Image");
    expect(image).toMatchObject({ box: { x: 220, y: 140, width: 120, height: 60, rotation: 0 }, pixelWidth: 160, pixelHeight: 60, canMove: true, canResize: true });
  });
});

describe("removing an object", () => {
  it("removes the image from the page and from the file, and nothing else changes", async () => {
    const session = await open();
    const analysis = session.analyze(0);
    const image = find(analysis, "Image");
    const before = await rasterize(fixtureBytes("objects.pdf"), 1, SCALE);
    const { bytes, report, raster } = await render(session, [{ id: image.id, delete: true }]);
    expect(report?.objects).toEqual([{ id: image.id, status: "applied" }]);
    // The orange rectangle that was painted over the picture stays; the picture does not.
    expectEditedOnlyIn("delete image", before, raster, [pixels(before, image.bounds)]);
    expect(isWhite(at(raster, 230, 190))).toBe(true);
    expect(isOrange(at(raster, 320, 150))).toBe(true);
    // Deleting is not hiding: the picture's bytes are not in the saved file any more.
    expect(hasImageObject(fixtureBytes("objects.pdf"))).toBe(true);
    expect(hasImageObject(bytes)).toBe(false);
  });

  it("removes a triangle drawn under a transformation", async () => {
    const session = await open();
    const triangle = find(session.analyze(0), "Triangle");
    const before = await rasterize(fixtureBytes("objects.pdf"), 1, SCALE);
    expect(isRed(at(before, 110, 180))).toBe(true);
    const { raster } = await render(session, [{ id: triangle.id, delete: true }]);
    expectEditedOnlyIn("delete triangle", before, raster, [pixels(before, triangle.bounds)]);
    expect(isWhite(at(raster, 110, 180))).toBe(true);
  });

  it("removes several things at once", async () => {
    const session = await open();
    const analysis = session.analyze(0);
    const edits = [find(analysis, "Triangle"), find(analysis, "Line"), find(analysis, "Rectangle", 2)].map((o) => ({ id: o.id, delete: true }));
    const before = await rasterize(fixtureBytes("objects.pdf"), 1, SCALE);
    const { raster, report } = await render(session, edits);
    expect(report?.objects.every((o) => o.status === "applied")).toBe(true);
    const regions = [find(analysis, "Triangle"), find(analysis, "Line"), find(analysis, "Rectangle", 2)].map((o) => pixels(before, o.bounds));
    expectEditedOnlyIn("delete three", before, raster, regions);
  });

  it("refuses an object that is not there", async () => {
    const session = await open();
    const { report } = await render(session, [{ id: "page#9999", delete: true }]);
    expect(report?.objects[0]).toMatchObject({ status: "refused" });
  });
});

describe("moving and resizing an object", () => {
  it("moves a triangle: its old place is empty, its new place is red, the rest is untouched", async () => {
    const session = await open();
    const triangle = find(session.analyze(0), "Triangle");
    const before = await rasterize(fixtureBytes("objects.pdf"), 1, SCALE);
    const target = { ...triangle.box, x: triangle.box.x + 60, y: triangle.box.y + 40 };
    const { raster, report } = await render(session, [{ id: triangle.id, target }]);
    expect(report?.objects[0]?.status).toBe("applied");
    expectEditedOnlyIn("move triangle", before, raster, [pixels(before, triangle.bounds), pixels(before, { ...target, width: target.width, height: target.height })]);
    expect(isWhite(at(raster, 110, 180))).toBe(true);
    expect(isRed(at(raster, 170, 220))).toBe(true);
  });

  it("moves an image and keeps what was painted over it above it", async () => {
    const session = await open();
    const image = find(session.analyze(0), "Image");
    const before = await rasterize(fixtureBytes("objects.pdf"), 1, SCALE);
    const target = { ...image.box, x: image.box.x - 100, y: image.box.y + 120 };
    const { raster } = await render(session, [{ id: image.id, target }]);
    expectEditedOnlyIn("move image", before, raster, [pixels(before, image.bounds), pixels(before, target)]);
    expect(isBlueish(at(raster, 130, 280))).toBe(true);
  });

  it("resizes an image from its corner", async () => {
    const session = await open();
    const image = find(session.analyze(0), "Image");
    const before = await rasterize(fixtureBytes("objects.pdf"), 1, SCALE);
    const target = { ...image.box, width: 60, height: 30 };
    const { raster } = await render(session, [{ id: image.id, target }]);
    // Half the size: the right-hand part is no longer picture, and the colours still run blue to teal.
    expectEditedOnlyIn("resize image", before, raster, [pixels(before, image.bounds)]);
    expect(isBlueish(at(raster, 230, 150))).toBe(true);
    expect(isWhite(at(raster, 320, 190))).toBe(true);
  });

  it("turns a rectangle a quarter turn about its centre", async () => {
    const session = await open();
    const green = find(session.analyze(0), "Rectangle", 2);
    expect(green.box).toMatchObject({ x: 60, y: 380, width: 80, height: 40 });
    const before = await rasterize(fixtureBytes("objects.pdf"), 1, SCALE);
    const target = { ...green.box, rotation: 90 };
    const { raster } = await render(session, [{ id: green.id, target }]);
    // 80 × 40 about (100, 400) becomes 40 wide and 80 tall.
    expect(at(raster, 100, 365)[1]).toBeGreaterThan(120);
    expect(isWhite(at(raster, 65, 400))).toBe(true);
    expectEditedOnlyIn("rotate rectangle", before, raster, [pixels(before, { x: 60, y: 360, width: 80, height: 80 })]);
  });

  it("moves, resizes and turns in one step", async () => {
    const session = await open();
    const triangle = find(session.analyze(0), "Triangle");
    const before = await rasterize(fixtureBytes("objects.pdf"), 1, SCALE);
    const target = { x: 150, y: 300, width: 120, height: 60, rotation: 180 };
    const { raster } = await render(session, [{ id: triangle.id, target }]);
    expect(isWhite(at(raster, 110, 180))).toBe(true);
    // Upside down: the wide side is at the top of its box.
    expect(isRed(at(raster, 210, 305))).toBe(true);
    expect(isWhite(at(raster, 160, 355))).toBe(true);
    expectEditedOnlyIn("move resize turn", before, raster, [pixels(before, triangle.bounds), pixels(before, target)]);
  });

  it("leaves a page alone when the target is where the object already is", async () => {
    const session = await open();
    const rectangle = find(session.analyze(0), "Rectangle", 1);
    const { report, raster } = await render(session, [{ id: rectangle.id, target: rectangle.box }]);
    expect(report?.objects[0]?.status).toBe("unchanged");
    const before = await rasterize(fixtureBytes("objects.pdf"), 1, SCALE);
    expect(difference(before, raster).changed).toBe(0);
  });
});

describe("the stacking order", () => {
  it("sends the orange rectangle behind the picture it was painted over", async () => {
    const session = await open();
    const analysis = session.analyze(0);
    const orange = find(analysis, "Rectangle", 0);
    const before = await rasterize(fixtureBytes("objects.pdf"), 1, SCALE);
    // Where they overlap (x 300–340, y 150–170) the orange is on top.
    expect(isOrange(at(before, 320, 160))).toBe(true);
    const { raster, report } = await render(session, [{ id: orange.id, order: "back" }]);
    expect(report?.objects[0]?.status).toBe("applied");
    expect(isBlueish(at(raster, 320, 160)) || at(raster, 320, 160)[1]! > 120).toBe(true);
    expect(isOrange(at(raster, 350, 130))).toBe(true);
    // Only the overlap changed.
    expectEditedOnlyIn("orange to back", before, raster, [pixels(before, { x: 300, y: 140, width: 40, height: 40 })]);
  });

  it("brings the picture in front of the rectangle that was over it", async () => {
    const session = await open();
    const analysis = session.analyze(0);
    const image = find(analysis, "Image");
    const before = await rasterize(fixtureBytes("objects.pdf"), 1, SCALE);
    const { raster } = await render(session, [{ id: image.id, order: "front" }]);
    expect(isOrange(at(raster, 320, 160))).toBe(false);
    expect(isOrange(at(raster, 350, 130))).toBe(true);
    expectEditedOnlyIn("image to front", before, raster, [pixels(before, { x: 300, y: 140, width: 40, height: 40 })]);
  });

  it("puts an object just after another one", async () => {
    const session = await open();
    const analysis = session.analyze(0);
    const image = find(analysis, "Image");
    const orange = find(analysis, "Rectangle", 0);
    const { raster } = await render(session, [{ id: image.id, order: { after: orange.id } }]);
    expect(isOrange(at(raster, 320, 160))).toBe(false);
  });

  it("keeps a moved object's colours and line style when it goes to the back", async () => {
    const session = await open();
    const analysis = session.analyze(0);
    const box = find(analysis, "Rectangle", 1);
    const before = await rasterize(fixtureBytes("objects.pdf"), 1, SCALE);
    const { raster } = await render(session, [{ id: box.id, order: "back" }]);
    expect(difference(before, raster).changed).toBe(0);
  });

  it("can move and reorder an object in the same step", async () => {
    const session = await open();
    const analysis = session.analyze(0);
    const orange = find(analysis, "Rectangle", 0);
    const before = await rasterize(fixtureBytes("objects.pdf"), 1, SCALE);
    const target = { ...orange.box, x: orange.box.x - 40 };
    const { raster } = await render(session, [{ id: orange.id, target, order: "back" }]);
    expect(isOrange(at(raster, 285, 130))).toBe(true);
    expect(difference(before, raster).changed).toBeGreaterThan(0);
  });
});

describe("lines of text", () => {
  it("moves a line of text and leaves the other lines where they were", async () => {
    const session = await open();
    const analysis = session.analyze(0);
    const line = analysis.lines.find((l) => l.text === "Boxed line two") as PageAnalysis["lines"][number];
    const before = await rasterize(fixtureBytes("objects.pdf"), 1, SCALE);
    const { raster, bytes, report } = await render(session, [{ id: line.id, move: { dx: 100, dy: -35 } }]);
    expect(report?.objects[0]?.status, report?.objects[0]?.reason).toBe("applied");
    const text = await pdfjsText(bytes);
    const moved = text.find((t) => t.text === "Boxed line two");
    const first = text.find((t) => t.text === "Boxed line one");
    expect(moved?.x).toBeCloseTo(170, 1);
    expect(moved?.y).toBeCloseTo(215 + 35, 1);
    expect(first).toMatchObject({ x: 70 });
    expect(first?.y).toBeCloseTo(235, 1);
    expectEditedOnlyIn("move line", before, raster, [pixels(before, line.box), pixels(before, { ...line.box, x: line.box.x + 100, y: line.box.y - 35 })]);
  });

  it("moves the first line of a text object without shifting the lines that follow it in that object", async () => {
    // Three lines in one text object, positioned with Td: moving the middle one must not drag the last one along.
    const doc = await PDFDocument.create();
    const font = await doc.embedFont("Helvetica");
    const page = doc.addPage([300, 200]);
    const { context } = doc;
    page.node.set(PDFName.of("Resources"), context.obj({ Font: { F1: font.ref } }));
    page.node.set(PDFName.of("Contents"), context.register(context.flateStream("BT /F1 12 Tf 20 150 Td (first) Tj 0 -20 Td (second) Tj 0 -20 Td (third) Tj ET")));
    const session = await EngineSession.open({ name: "three.pdf", bytes: await doc.save() });
    const lines = session.analyze(0).lines;
    const second = lines.find((l) => l.text === "second") as PageAnalysis["lines"][number];
    const { bytes, report } = await session.derivePage(0, [], { objects: [{ id: second.id, move: { dx: 50, dy: 0 } }] });
    expect(report?.objects[0]?.status, report?.objects[0]?.reason).toBe("applied");
    const text = await pdfjsText(bytes);
    expect(text.find((t) => t.text === "first")).toMatchObject({ x: 20, y: 150 });
    expect(text.find((t) => t.text === "second")).toMatchObject({ x: 70, y: 130 });
    expect(text.find((t) => t.text === "third")).toMatchObject({ x: 20, y: 110 });
  });

  it("removes a line of text, and the lines after it in the same text object stay put", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont("Helvetica");
    const page = doc.addPage([300, 200]);
    const { context } = doc;
    page.node.set(PDFName.of("Resources"), context.obj({ Font: { F1: font.ref } }));
    page.node.set(PDFName.of("Contents"), context.register(context.flateStream("BT /F1 12 Tf 20 150 Td (first) Tj 0 -20 Td (second) Tj 0 -20 Td (third) Tj ET")));
    const session = await EngineSession.open({ name: "three.pdf", bytes: await doc.save() });
    const lines = session.analyze(0).lines;
    const second = lines.find((l) => l.text === "second") as PageAnalysis["lines"][number];
    const { bytes } = await session.derivePage(0, [], { objects: [{ id: second.id, delete: true }] });
    const text = await pdfjsText(bytes);
    expect(text.map((t) => t.text)).toEqual(["first", "third"]);
    expect(text.find((t) => t.text === "third")).toMatchObject({ x: 20, y: 110 });
    // The words are gone from the file, not covered.
    expect(new TextDecoder("latin1").decode(bytes)).not.toContain("second");
  });

  it("removes a line drawn with the quote operators and keeps the line spacing of what follows", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont("Helvetica");
    const page = doc.addPage([300, 200]);
    const { context } = doc;
    page.node.set(PDFName.of("Resources"), context.obj({ Font: { F1: font.ref } }));
    page.node.set(PDFName.of("Contents"), context.register(context.flateStream("BT /F1 12 Tf 14 TL 20 150 Td (one) Tj (two) ' (three) ' (four) ' ET")));
    const session = await EngineSession.open({ name: "quotes.pdf", bytes: await doc.save() });
    const two = session.analyze(0).lines.find((l) => l.text === "two") as PageAnalysis["lines"][number];
    const { bytes } = await session.derivePage(0, [], { objects: [{ id: two.id, delete: true }] });
    const text = await pdfjsText(bytes);
    expect(text.map((t) => t.text)).toEqual(["one", "three", "four"]);
    expect(text.find((t) => t.text === "three")?.y).toBeCloseTo(150 - 28, 1);
    expect(text.find((t) => t.text === "four")?.y).toBeCloseTo(150 - 42, 1);
  });

  it("edits the text of a line and moves it in the same step", async () => {
    const session = await open();
    const line = session.analyze(0).lines.find((l) => l.text === "Boxed line one") as PageAnalysis["lines"][number];
    const { bytes, report } = await render(session, [{ id: line.id, move: { dx: 0, dy: 60 } }], [{ lineId: line.id, text: "Boxed line 1" }]);
    expect(report?.outcomes[0]?.status).toBe("applied");
    expect(report?.objects[0]?.status).toBe("applied");
    const text = await pdfjsText(bytes);
    const moved = text.find((t) => t.text === "Boxed line 1");
    expect(moved?.x).toBeCloseTo(70, 1);
    expect(moved?.y).toBeCloseTo(235 - 60, 1);
    expect(text.find((t) => t.text === "Boxed line two")?.y).toBeCloseTo(215, 1);
  });

  it("ignores the edit of a line that is removed in the same step", async () => {
    const session = await open();
    const line = session.analyze(0).lines.find((l) => l.text === "Boxed line one") as PageAnalysis["lines"][number];
    const { bytes, report } = await render(session, [{ id: line.id, delete: true }], [{ lineId: line.id, text: "Changed" }]);
    expect(report?.outcomes[0]?.status).toBe("unchanged");
    const text = (await pdfjsText(bytes)).map((t) => t.text);
    expect(text).not.toContain("Changed");
    expect(text).not.toContain("Boxed line one");
  });
});

describe("annotations", () => {
  async function withAnnotation() {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const { context } = doc;
    const appearance = context.register(context.stream("1 0 0 rg 0 0 60 30 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 60, 30] }));
    const popup = context.register(context.obj({ Type: "Annot", Subtype: "Popup", Rect: [200, 100, 280, 160], Open: false }));
    const square = context.register(
      context.obj({ Type: "Annot", Subtype: "Square", Rect: [100, 100, 160, 130], C: [1, 0, 0], F: 4, AP: { N: appearance }, Contents: PDFString.of("a note"), Popup: popup }),
    );
    const link = context.register(context.obj({ Type: "Annot", Subtype: "Link", Rect: [10, 10, 60, 30], Border: [0, 0, 0] }));
    (context.lookup(popup) as PDFDict).set(PDFName.of("Parent"), square);
    page.node.set(PDFName.of("Annots"), context.obj([square, popup, link]));
    return EngineSession.open({ name: "annot.pdf", bytes: await doc.save() });
  }

  it("lists annotations that are objects and leaves links and pop-ups out", async () => {
    const session = await withAnnotation();
    const objects = session.analyze(0).objects;
    expect(objects.map((o) => `${o.kind}:${o.label}`)).toEqual(["annotation:Rectangle"]);
    expect(objects[0]).toMatchObject({ box: { x: 100, y: 70, width: 60, height: 30 }, contents: "a note", canMove: true });
  });

  it("moves an annotation", async () => {
    const session = await withAnnotation();
    const annotation = session.analyze(0).objects[0] as NonNullable<PageAnalysis["objects"][number]>;
    const { bytes } = await session.derivePage(0, [], { objects: [{ id: annotation.id, target: { ...annotation.box, x: 150, y: 20 } }] });
    const moved = await PDFDocument.load(bytes);
    const list = moved.getPage(0).node.lookup(PDFName.of("Annots")) as unknown as { lookup(i: number): PDFDict; size(): number };
    const rect = list.lookup(0).lookup(PDFName.of("Rect")) as unknown as { lookup(i: number): PDFNumber };
    expect([0, 1, 2, 3].map((i) => rect.lookup(i).asNumber())).toEqual([150, 150, 210, 180]);
  });

  it("removes an annotation with its pop-up, and keeps the link", async () => {
    const session = await withAnnotation();
    const annotation = session.analyze(0).objects[0] as NonNullable<PageAnalysis["objects"][number]>;
    const { bytes } = await session.derivePage(0, [], { objects: [{ id: annotation.id, delete: true }] });
    const result = await PDFDocument.load(bytes);
    const list = result.getPage(0).node.lookup(PDFName.of("Annots")) as unknown as { size(): number; lookup(i: number): PDFDict };
    expect(list.size()).toBe(1);
    expect((list.lookup(0).lookup(PDFName.of("Subtype")) as PDFName).decodeText()).toBe("Link");
  });
});

describe("objects inside a form XObject", () => {
  async function withForm(draws: number) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const { context } = doc;
    const form = context.register(context.stream("1 0 0 rg 0 0 40 40 re f 0 0 1 rg 50 0 40 40 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 100] }));
    page.node.set(PDFName.of("Resources"), context.obj({ XObject: { Fm1: form } }));
    const uses = Array.from({ length: draws }, (_, i) => `q 1 0 0 1 ${20 + i * 120} 100 cm /Fm1 Do Q`).join(" ");
    page.node.set(PDFName.of("Contents"), context.register(context.flateStream(uses)));
    return { bytes: await doc.save(), form };
  }

  it("moves a shape that lives inside a form that is drawn once", async () => {
    const { bytes } = await withForm(1);
    const session = await EngineSession.open({ name: "form.pdf", bytes });
    const objects = session.analyze(0).objects;
    expect(objects).toHaveLength(2);
    const red = objects[0] as NonNullable<PageAnalysis["objects"][number]>;
    expect(red.canMove).toBe(true);
    const before = await rasterize(bytes, 1, SCALE);
    // Up 40: the form's own box (100 × 100 where it is drawn) clips what is moved out of it, so stay inside.
    const { bytes: after, report } = await session.derivePage(0, [], { objects: [{ id: red.id, target: { ...red.box, y: red.box.y - 40 } }] });
    expect(report?.objects[0]?.status, report?.objects[0]?.reason).toBe("applied");
    const raster = await rasterize(after, 1, SCALE);
    // The red square left its place (20..60, 60..100) and the blue one beside it did not move.
    expect(isWhite(at(raster, 40, 90))).toBe(true);
    expect(isRed(at(raster, 40, 40))).toBe(true);
    expect(isBlueish(at(raster, 90, 80))).toBe(true);
    expect(difference(before, raster).changed).toBeGreaterThan(0);
  });

  it("refuses to change a shape in a form the page draws twice, because both would change", async () => {
    const { bytes } = await withForm(2);
    const session = await EngineSession.open({ name: "form.pdf", bytes });
    const objects = session.analyze(0).objects;
    expect(objects.every((o) => !o.canMove && o.reason?.includes("2 times"))).toBe(true);
    const { report } = await session.derivePage(0, [], { objects: [{ id: (objects[0] as NonNullable<PageAnalysis["objects"][number]>).id, delete: true }] });
    expect(report?.objects[0]?.status).toBe("refused");
  });

  it("gives the same ids to the objects of a page after it has been copied into another document", async () => {
    const { bytes } = await withForm(1);
    const session = await EngineSession.open({ name: "form.pdf", bytes });
    const ids = session.analyze(0).objects.map((o) => o.id);
    const { bytes: copy } = await session.derivePage(0, []);
    const again = await EngineSession.open({ name: "copy.pdf", bytes: copy });
    expect(again.analyze(0).objects.map((o) => o.id)).toEqual(ids);
  });
});

describe("a page from a browser, where everything is inside one global transformation", () => {
  const name = "chromium-article.pdf";

  it("sends the picture to the back and to the front without moving it", async () => {
    const session = await open(name);
    const analysis = session.analyze(0);
    const image = find(analysis, "Image");
    const before = await rasterize(fixtureBytes(name), 1, SCALE);
    // It was painted before the rotated note that crosses it, so going to the back changes nothing at all…
    const back = await render(session, [{ id: image.id, order: "back" }]);
    expect(back.report?.objects[0]?.status, back.report?.objects[0]?.reason).toMatch(/applied|unchanged/);
    expect(difference(before, back.raster).changed).toBe(0);
    // …and going to the front puts it over the note, but only inside the picture box itself.
    const front = await render(session, [{ id: image.id, order: "front" }]);
    expect(front.report?.objects[0]?.status, front.report?.objects[0]?.reason).toBe("applied");
    expectEditedOnlyIn("browser image to front", before, front.raster, [pixels(before, image.bounds, 4)]);
  });

  it("moves and removes the picture", async () => {
    const session = await open(name);
    const image = find(session.analyze(0), "Image");
    const before = await rasterize(fixtureBytes(name), 1, SCALE);
    const to = { ...image.box, x: image.box.x + 200, y: image.box.y + 20 };
    const moved = await render(session, [{ id: image.id, target: to }]);
    expectEditedOnlyIn("browser image moved", before, moved.raster, [pixels(before, image.bounds, 4), pixels(before, to, 4)]);
    const removed = await render(session, [{ id: image.id, delete: true }]);
    expect(isBlueish(at(removed.raster, image.bounds.x + 10, image.bounds.y + 10))).toBe(false);
    expect(hasImageObject(removed.bytes)).toBe(false);
  });
});

describe("odd input", () => {
  it("uses the last change when an object is listed twice", async () => {
    const session = await open();
    const image = find(session.analyze(0), "Image");
    const { report, raster } = await render(session, [
      { id: image.id, target: { ...image.box, x: 10 } },
      { id: image.id, delete: true },
    ]);
    expect(report?.objects).toEqual([{ id: image.id, status: "applied" }]);
    expect(isWhite(at(raster, 230, 190))).toBe(true);
  });

  it("copes with a minified stream where operators run into each other", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont("Helvetica");
    const page = doc.addPage([300, 200]);
    const { context } = doc;
    page.node.set(PDFName.of("Resources"), context.obj({ Font: { F1: font.ref } }));
    page.node.set(PDFName.of("Contents"), context.register(context.flateStream("BT/F1 12 Tf 20 150 Td(first)Tj 0 -20 Td(second)Tj 0 -20 Td(third)Tj ET 1 0 0 rg 10 10 30 30 re f")));
    const session = await EngineSession.open({ name: "min.pdf", bytes: await doc.save() });
    const analysis = session.analyze(0);
    const second = analysis.lines.find((l) => l.text === "second") as PageAnalysis["lines"][number];
    const square = analysis.objects[0] as NonNullable<PageAnalysis["objects"][number]>;
    const { bytes, report } = await session.derivePage(0, [], {
      objects: [
        { id: second.id, delete: true },
        { id: square.id, target: { ...square.box, x: 100 } },
      ],
    });
    expect(report?.objects.map((o) => o.status)).toEqual(["applied", "applied"]);
    expect((await pdfjsText(bytes)).map((t) => t.text)).toEqual(["first", "third"]);
    const raster = await rasterize(bytes, 1, SCALE);
    expect(isRed(at(raster, 115, 175))).toBe(true);
    expect(isWhite(at(raster, 25, 175))).toBe(true);
  });
});

void PDFRef;
