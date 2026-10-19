import { PDFDocument, PDFName } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { type ExportPage, type ExportPlan, exportDocument } from "../../src/lib/pdf/export/exportDocument";
import type { EditorObject, ImageObject, MarkupObject, ShapeObject, TextBoxObject } from "../../src/editor/model/types";
import { fixtureBytes } from "../fixtures/build";
import { inkBounds, isBlue, isRed, isWhite, makeImage, renderPdfPage } from "./helpers/images";
import { makeTextPdf, pageGeometry, pageTexts } from "./helpers/pdf";

const SCALE = 2;
const base = { id: "o", page: "p", rotation: 0, opacity: 1 };

function page(overrides: Partial<ExportPage> = {}): ExportPage {
  return { source: null, index: 0, width: 400, height: 300, rotation: 0, crop: null, objects: [], edits: [], ...overrides };
}

const plan = (pages: ExportPage[], sources: ExportPlan["sources"] = []): ExportPlan => ({ sources, pages, options: { fileName: "out.pdf", author: "Tester" } });

const textBox = (overrides: Partial<TextBoxObject> = {}): TextBoxObject => ({
  ...base,
  id: "t1",
  kind: "text",
  text: "Hello",
  x: 50,
  y: 40,
  width: 200,
  height: 30,
  family: "sans",
  bold: false,
  italic: false,
  underline: false,
  size: 24,
  color: "#000000",
  align: "left",
  lineHeight: 1.25,
  letterSpacing: 0,
  fill: null,
  border: { color: null, width: 1, style: "solid" },
  padding: 2,
  radius: 0,
  autoHeight: true,
  ...overrides,
});

const rect = (overrides: Partial<ShapeObject> = {}): ShapeObject => ({ ...base, id: "r1", kind: "rect", x: 100, y: 80, width: 120, height: 60, fill: "#ff0000", stroke: null, strokeWidth: 0, strokeStyle: "solid", radius: 0, ...overrides });

async function render(bytes: Uint8Array, pageNumber = 1) {
  return renderPdfPage(bytes, pageNumber, SCALE);
}

const px = (points: number) => points * SCALE;

describe("exporting a document built in the editor", () => {
  it("creates a document from blank pages and reports what it did", async () => {
    const result = await exportDocument(plan([page(), page({ width: 200, height: 100 })]));
    expect(result.pageCount).toBe(2);
    expect(result.name).toBe("out.pdf");
    expect(await pageGeometry(result.bytes)).toEqual([{ width: 400, height: 300, rotation: 0 }, { width: 200, height: 100, rotation: 0 }]);
    expect(result.report).toMatchObject({ pages: 2, objectsDrawn: 0, annotations: 0, warnings: [] });
  });

  it("puts a text box where the editor shows it: top-left origin, first baseline 0.9 em below the padding", async () => {
    const result = await exportDocument(plan([page({ objects: [textBox()] })]));
    expect(await pageTexts(result.bytes)).toEqual(["Hello"]);
    const ink = inkBounds(await render(result.bytes), isWhite);
    // left edge: x 50 + padding 2; the cap-height top of the letters is about 0.72 em above the baseline at 40 + 2 + 21.6
    expect(ink.minX).toBeGreaterThanOrEqual(px(51));
    expect(ink.minX).toBeLessThanOrEqual(px(56));
    expect(ink.minY).toBeGreaterThanOrEqual(px(44));
    expect(ink.minY).toBeLessThanOrEqual(px(49));
    expect(ink.maxY).toBeLessThanOrEqual(px(66));
  });

  it("wraps long text in the box and aligns lines", async () => {
    const long = textBox({ text: "one two three four five six seven eight nine ten", width: 120, size: 14, align: "center" });
    const result = await exportDocument(plan([page({ objects: [long] })]));
    const texts = (await pageTexts(result.bytes))[0] ?? "";
    expect(texts.replace(/\s+/g, " ")).toBe(long.text);
    const picture = await render(result.bytes);
    const ink = inkBounds(picture, isWhite);
    // the text stays inside the box width (plus a little slack)
    expect(ink.minX).toBeGreaterThanOrEqual(px(48));
    expect(ink.maxX).toBeLessThanOrEqual(px(50 + 120 + 4));
    // and takes more than one line
    expect(ink.maxY - ink.minY).toBeGreaterThan(px(30));
  });

  it("draws a filled rectangle exactly where it is, and an ellipse inside its box", async () => {
    const result = await exportDocument(plan([page({ objects: [rect(), { ...rect({ id: "e1", x: 250, y: 80, width: 100, height: 100, fill: "#0000ff" }), kind: "ellipse" } as ShapeObject] })]));
    const picture = await render(result.bytes);
    expect(isRed(picture.at(px(160), px(110)))).toBe(true);
    expect(isRed(picture.at(px(98), px(110)))).toBe(false);
    expect(isRed(picture.at(px(222), px(110)))).toBe(false);
    expect(isBlue(picture.at(px(300), px(130)))).toBe(true);
    expect(isBlue(picture.at(px(252), px(82)))).toBe(false); // the corner of an ellipse's box is empty
    const red = inkBounds(picture, (rgb) => !isRed(rgb));
    expect(red.minX).toBeCloseTo(px(100), -1);
    expect(red.maxX).toBeCloseTo(px(220), -1);
    expect(red.minY).toBeCloseTo(px(80), -1);
    expect(red.maxY).toBeCloseTo(px(140), -1);
  });

  it("turns a box about its centre", async () => {
    // a 120x20 bar turned a quarter: it becomes a 20x120 bar around the same centre (160, 90)
    const bar = rect({ x: 100, y: 80, width: 120, height: 20, rotation: 90 });
    const result = await exportDocument(plan([page({ objects: [bar] })]));
    const red = inkBounds(await render(result.bytes), (rgb) => !isRed(rgb));
    expect(red.minX).toBeCloseTo(px(150), -1);
    expect(red.maxX).toBeCloseTo(px(170), -1);
    expect(red.minY).toBeCloseTo(px(30), -1);
    expect(red.maxY).toBeCloseTo(px(150), -1);
  });

  it("draws rounded corners, dashed outlines, lines with arrowheads, pen strokes and cover boxes", async () => {
    const objects: EditorObject[] = [
      rect({ id: "a", x: 20, y: 20, width: 100, height: 60, radius: 30, fill: "#ff0000" }),
      { ...base, id: "l", kind: "line", x1: 150, y1: 50, x2: 300, y2: 50, color: "#0000ff", strokeWidth: 4, strokeStyle: "solid", arrow: "end" },
      { ...base, id: "d", kind: "draw", points: [[20, 200], [60, 240], [100, 200]], color: "#0000ff", strokeWidth: 5 },
      { ...base, id: "c", kind: "cover", x: 200, y: 150, width: 100, height: 60, color: "#ff0000" },
    ];
    const result = await exportDocument(plan([page({ objects })]));
    const picture = await render(result.bytes);
    expect(isRed(picture.at(px(70), px(50)))).toBe(true); // inside the rounded rectangle
    expect(isRed(picture.at(px(21), px(21)))).toBe(false); // its rounded corner is cut away
    expect(isBlue(picture.at(px(225), px(50)))).toBe(true); // along the line
    expect(isBlue(picture.at(px(60.8), px(226.4)))).toBe(true); // the lowest point of the smoothed pen stroke
    expect(isRed(picture.at(px(250), px(180)))).toBe(true); // the cover box
  });

  it("places, scales, flips, crops and fades an image", async () => {
    const bytes = makeImage("png", 40, 20); // left half red, right half blue
    const image: ImageObject = { ...base, id: "i", kind: "image", image: { name: "a.png", mime: "image/png", bytes, width: 40, height: 20 }, x: 100, y: 100, width: 80, height: 40, crop: null, flipX: false, flipY: false, border: { color: null, width: 1, style: "solid" } };
    const normal = await render((await exportDocument(plan([page({ objects: [image] })]))).bytes);
    expect(isRed(normal.at(px(110), px(120)))).toBe(true);
    expect(isBlue(normal.at(px(170), px(120)))).toBe(true);
    const flipped = await render((await exportDocument(plan([page({ objects: [{ ...image, flipX: true }] })]))).bytes);
    expect(isBlue(flipped.at(px(110), px(120)))).toBe(true);
    expect(isRed(flipped.at(px(170), px(120)))).toBe(true);
    // cropping away the left half leaves only blue, stretched over the box
    const cropped = await render((await exportDocument(plan([page({ objects: [{ ...image, crop: { top: 0, right: 0, bottom: 0, left: 0.5 } }] })]))).bytes);
    expect(isBlue(cropped.at(px(110), px(120)))).toBe(true);
    expect(isBlue(cropped.at(px(170), px(120)))).toBe(true);
    const faded = await render((await exportDocument(plan([page({ objects: [{ ...image, opacity: 0.4 }] })]))).bytes);
    const [r, g] = faded.at(px(110), px(120));
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(100); // washed out towards white
  });

  it("writes highlights, underlines and notes as real annotations with appearances", async () => {
    const objects: EditorObject[] = [
      { ...base, id: "h", kind: "highlight", color: "#ffff00", opacity: 0.5, quads: [{ x: 50, y: 40, width: 100, height: 20 }] } satisfies MarkupObject,
      { ...base, id: "u", kind: "underline", color: "#ff0000", opacity: 1, quads: [{ x: 50, y: 100, width: 100, height: 20 }] } satisfies MarkupObject,
      { ...base, id: "n", kind: "comment", x: 300, y: 50, text: "Check this figure", author: "Tester" },
    ];
    const result = await exportDocument(plan([page({ objects })]));
    expect(result.report.annotations).toBe(3);
    const doc = await PDFDocument.load(result.bytes);
    const annots = doc.getPage(0).node.lookup(PDFName.of("Annots")) as unknown as { size(): number; lookup(i: number): { get(k: PDFName): unknown } };
    expect(annots.size()).toBe(3);
    const subtypes = Array.from({ length: 3 }, (_, i) => String(annots.lookup(i).get(PDFName.of("Subtype"))));
    expect(subtypes).toEqual(["/Highlight", "/Underline", "/Text"]);
    const picture = await render(result.bytes);
    const [r, g, b] = picture.at(px(100), px(50));
    expect(r).toBeGreaterThan(240);
    expect(g).toBeGreaterThan(240);
    expect(b).toBeLessThan(200); // yellow over white
    expect(isRed(picture.at(px(100), px(119.6)))).toBe(true); // the underline sits on the bottom edge of its box
  });

  it("keeps an object in the right place when the page is turned in the editor", async () => {
    const source = { id: "s1", name: "a.pdf", bytes: await makeTextPdf("A", 1, [400, 300]), pageCount: 1 };
    const marker = rect({ x: 50, y: 40, width: 100, height: 60 }); // centre (100, 70) in the page as first shown
    const result = await exportDocument(plan([page({ source: "s1", index: 0, rotation: 90, objects: [marker] })], [source]));
    expect(await pageGeometry(result.bytes)).toEqual([{ width: 400, height: 300, rotation: 90 }]);
    const picture = await render(result.bytes);
    // turned a quarter clockwise, the 400x300 page shows as 300x400; base (x, y) lands at (300 - y, x)
    expect(picture.width).toBe(px(300));
    expect(isRed(picture.at(px(300 - 70), px(100)))).toBe(true);
    expect(isRed(picture.at(px(100), px(300)))).toBe(false);
  });

  it("crops a page and keeps what is inside the crop in place", async () => {
    const marker = rect({ x: 100, y: 100, width: 40, height: 40 });
    const result = await exportDocument(plan([page({ crop: { top: 50, right: 100, bottom: 50, left: 80 }, objects: [marker] })]));
    const picture = await render(result.bytes);
    expect(picture.width).toBe(px(220));
    expect(picture.height).toBe(px(200));
    // the marker moves by the crop offset: (100, 100) -> (20, 50)
    expect(isRed(picture.at(px(40), px(70)))).toBe(true);
    expect(isRed(picture.at(px(100), px(150)))).toBe(false);
  });

  it("assembles pages from several files, with blank pages and copies, in order", async () => {
    const a = { id: "a", name: "a.pdf", bytes: await makeTextPdf("A", 3), pageCount: 3 };
    const b = { id: "b", name: "b.pdf", bytes: await makeTextPdf("B", 2), pageCount: 2 };
    const result = await exportDocument(
      plan(
        [page({ source: "b", index: 1 }), page({ source: "a", index: 0 }), page({ source: null, width: 300, height: 200 }), page({ source: "a", index: 0 }), page({ source: "a", index: 2, rotation: 180 })],
        [a, b],
      ),
    );
    expect(await pageTexts(result.bytes)).toEqual(["B p2", "A p1", "", "A p1", "A p3"]);
    expect((await pageGeometry(result.bytes)).map((g) => g.rotation)).toEqual([0, 0, 0, 0, 180]);
  });

  it("edits existing text and adds objects on the same page, and says what happened to each edit", async () => {
    const source = { id: "s", name: "pdfkit.pdf", bytes: fixtureBytes("pdfkit-standard.pdf"), pageCount: 1 };
    const { EngineSession } = await import("../../src/lib/pdf/engine/session");
    const session = await EngineSession.open({ name: "x", bytes: source.bytes });
    const line = session.analyze(0).lines.find((l) => l.text === "Annual Report");
    expect(line).toBeDefined();
    const result = await exportDocument(
      plan(
        [
          page({
            source: "s",
            index: 0,
            width: 595.28,
            height: 841.89,
            edits: [{ lineId: line?.id ?? "", text: "Annual Summary", style: { align: "left" } }, { lineId: "page#99999", text: "nothing" }],
            objects: [textBox({ text: "Added note", x: 300, y: 400, color: "#0000ff" })],
          }),
        ],
        [source],
      ),
    );
    const text = (await pageTexts(result.bytes))[0] ?? "";
    expect(text).toContain("Annual Summary");
    expect(text).toContain("Added note");
    expect(text).not.toContain("Annual Report");
    expect(result.report.edits.map((e) => e.outcome.status)).toEqual(["applied", "refused"]);
    expect(result.report.warnings.join(" ")).toMatch(/could not be made/);
  });

  it("keeps the original untouched and refuses to make a file it cannot verify", async () => {
    const original = await makeTextPdf("Keep", 2);
    const copy = original.slice();
    await exportDocument(plan([page({ source: "k", index: 0, objects: [rect()] })], [{ id: "k", name: "k.pdf", bytes: original, pageCount: 2 }]));
    expect(original).toEqual(copy);
    await expect(exportDocument(plan([]))).rejects.toThrow(/no pages/);
    await expect(exportDocument(plan([page({ source: "missing", index: 0 })]))).rejects.toThrow(/no longer open/);
  });

  it("says so, instead of silently dropping them, when asked for form fields that this build does not have", async () => {
    const field: EditorObject = { ...base, id: "f", kind: "field", fieldType: "text", name: "a", label: "", required: false, readOnly: false, multiline: false, options: [], group: "", defaultValue: "", fontSize: 12, border: { color: null, width: 1, style: "solid" }, fill: null, x: 10, y: 10, width: 50, height: 20 };
    await expect(exportDocument(plan([page({ objects: [field] })]))).rejects.toThrow(/not available/);
  });

  it("refuses a text box with letters no built-in font has, and names the page", async () => {
    await expect(exportDocument(plan([page(), page({ objects: [textBox({ text: "漢字" })] })]))).rejects.toThrow(/page 2/);
  });
});

describe("objects placed behind the page and changes to what the page already draws", () => {
  const objectsPdf = () => ({ id: "o", name: "objects.pdf", bytes: fixtureBytes("objects.pdf"), pageCount: 1 });
  const wash = (overrides: Partial<ShapeObject> = {}) => rect({ id: "wash", x: 0, y: 0, width: 400, height: 500, fill: "#ffe0e0", ...overrides });
  const isPink = ([r, g, b]: number[]) => (r as number) > 240 && (g as number) > 200 && (g as number) < 235 && (b as number) > 200 && (b as number) < 235;

  it("puts an object behind the page's own graphics, so they stay in front of it", async () => {
    const source = objectsPdf();
    const behind = await exportDocument(plan([page({ source: "o", index: 0, width: 400, height: 500, objects: [wash({ behind: true })] })], [source]));
    const picture = await render(behind.bytes);
    // Empty paper shows the wash; the page's green box and its black title are drawn over it.
    expect(isPink(picture.at(px(20), px(20)))).toBe(true);
    const green = picture.at(px(100), px(400));
    expect(green[1]).toBeGreaterThan(130);
    expect(green[0]).toBeLessThan(40);
    const infront = await exportDocument(plan([page({ source: "o", index: 0, width: 400, height: 500, objects: [wash()] })], [source]));
    const covered = (await render(infront.bytes)).at(px(100), px(400));
    expect(isPink(covered)).toBe(true);
  });

  it("changes nothing about the page's own text and shapes when something goes behind it", async () => {
    const source = objectsPdf();
    const plain = await exportDocument(plan([page({ source: "o", index: 0, width: 400, height: 500 })], [source]));
    const behind = await exportDocument(plan([page({ source: "o", index: 0, width: 400, height: 500, objects: [wash({ behind: true, fill: "#ffffff" })] })], [source]));
    const a = await render(plain.bytes);
    const b = await render(behind.bytes);
    let differing = 0;
    for (let y = 0; y < a.height; y += 3) for (let x = 0; x < a.width; x += 3) if (a.at(x, y).some((v, i) => Math.abs(v - b.at(x, y)[i]!) > 24)) differing += 1;
    expect(differing).toBe(0);
    expect(await pageTexts(behind.bytes)).toEqual(await pageTexts(plain.bytes));
  });

  it("draws added objects in the right place on a page that leaves a transformation open", async () => {
    const doc = await PDFDocument.create();
    const pdfPage = doc.addPage([200, 200]);
    pdfPage.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream("q 0.5 0 0 0.5 0 0 cm 0 0 1 rg 0 0 100 100 re f")));
    const bytes = await doc.save();
    const result = await exportDocument(plan([page({ source: "u", index: 0, width: 200, height: 200, objects: [rect({ x: 100, y: 20, width: 50, height: 50 })] })], [{ id: "u", name: "u.pdf", bytes, pageCount: 1 }]));
    const picture = await render(result.bytes);
    expect(isRed(picture.at(px(125), px(45)))).toBe(true);
    expect(isBlue(picture.at(px(25), px(175)))).toBe(true);
  });

  it("moves, removes and reorders what the page already draws, and reports it", async () => {
    const { EngineSession } = await import("../../src/lib/pdf/engine/session");
    const analysis = (await EngineSession.open({ name: "o.pdf", bytes: fixtureBytes("objects.pdf") })).analyze(0);
    const triangle = analysis.objects.find((o) => o.label === "Triangle")!;
    const image = analysis.objects.find((o) => o.kind === "image")!;
    const result = await exportDocument(
      plan(
        [
          page({
            source: "o",
            index: 0,
            width: 400,
            height: 500,
            objectEdits: [
              { id: triangle.id, target: { ...triangle.box, x: 250, y: 380 } },
              { id: image.id, delete: true },
              { id: "page#9999", delete: true },
            ],
          }),
        ],
        [objectsPdf()],
      ),
    );
    expect(result.report.changes.map((c) => c.outcome.status)).toEqual(["applied", "applied", "refused"]);
    expect(result.report.warnings.join(" ")).toMatch(/no longer on the page/);
    const picture = await render(result.bytes);
    expect(isWhite(picture.at(px(110), px(180)))).toBe(true);
    expect(isRed(picture.at(px(300), px(440)))).toBe(true);
    expect(new TextDecoder("latin1").decode(result.bytes)).not.toContain("/Subtype /Image");
  });

  it("merges added objects into the page: they come back as things the page already draws", async () => {
    const { EngineSession } = await import("../../src/lib/pdf/engine/session");
    const png = makeImage("png", 40, 20);
    const picture: ImageObject = { ...base, id: "img", kind: "image", x: 20, y: 20, width: 80, height: 40, image: { name: "a.png", mime: "image/png", bytes: png, width: 40, height: 20 }, crop: null, flipX: false, flipY: false, border: { color: null, width: 1, style: "solid" } };
    const merged = await exportDocument(plan([page({ objects: [textBox({ text: "Merged words", y: 100 }), picture, rect({ x: 200, y: 120, width: 60, height: 40 })] })]));
    const analysis = (await EngineSession.open({ name: "merged.pdf", bytes: merged.bytes })).analyze(0);
    expect(analysis.lines.map((l) => l.text)).toEqual(["Merged words"]);
    expect(analysis.objects.map((o) => o.kind).sort()).toEqual(["image", "shape"]);
    expect(analysis.objects.find((o) => o.kind === "image")?.box).toMatchObject({ x: 20, y: 20, width: 80, height: 40 });
  });
});

describe("redaction in an export", () => {
  const box = (overrides: Partial<Extract<EditorObject, { kind: "redact" }>> = {}): EditorObject => ({ ...base, id: "x", kind: "redact", x: 60, y: 120, width: 110, height: 90, color: "#000000", label: "REDACTED", ...overrides });
  const pdf = () => ({ id: "o", name: "objects.pdf", bytes: fixtureBytes("objects.pdf"), pageCount: 1 });

  it("takes out what is under the boxes, leaves a labelled black box in its place, and reports what it removed", async () => {
    const { EngineSession } = await import("../../src/lib/pdf/engine/session");
    // The triangle (60…160 × 120…200) and nothing else is under this box.
    const result = await exportDocument(plan([page({ source: "o", index: 0, width: 400, height: 500, objects: [box()] })], [pdf()]));
    expect(result.report.redactions).toHaveLength(1);
    expect(result.report.redactions[0]).toMatchObject({ shapesRemoved: 1, verified: true });
    const picture = await render(result.bytes);
    expect(picture.at(px(70), px(125))[0]).toBeLessThan(20); // black
    expect(inkBounds(picture, isWhite, { x0: px(60), y0: px(120), x1: px(170), y1: px(210) }).count).toBeGreaterThan(5000);
    expect((await pageTexts(result.bytes))[0]).toContain("REDACTED");
    const analysis = (await EngineSession.open({ name: "r.pdf", bytes: result.bytes })).analyze(0);
    // The triangle is not in the file as a shape any more; the box that replaced it is a plain black rectangle.
    expect(analysis.objects.filter((o) => o.label === "Triangle")).toHaveLength(0);
  });

  it("removes the words under a box before the box is drawn, so the label is the only text left there", async () => {
    const result = await exportDocument(plan([page({ source: "o", index: 0, width: 400, height: 500, objects: [box({ x: 60, y: 250, width: 160, height: 45, label: "" })] })], [pdf()]));
    const text = (await pageTexts(result.bytes))[0] ?? "";
    expect(text).not.toContain("Boxed line");
    expect(text).toContain("Objects page");
  });

  it("refuses to make a file it cannot vouch for, and says which page", async () => {
    const doc = await PDFDocument.create();
    const unreadable = doc.addPage([200, 100]);
    unreadable.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(new Uint8Array([1, 2, 3]), { Filter: "FooDecode" })));
    const bytes = await doc.save();
    await expect(exportDocument(plan([page({ source: "u", index: 0, width: 200, height: 100, objects: [box({ x: 0, y: 0, width: 200, height: 100 })] })], [{ id: "u", name: "u.pdf", bytes, pageCount: 1 }]))).rejects.toThrow(/Page 1 could not be redacted completely/);
  });

  it("can also clear the properties, bookmarks and attachments, and drops page thumbnails", async () => {
    const doc = await PDFDocument.create();
    doc.setTitle("Secret plan");
    doc.setAuthor("Jane Doe");
    doc.addPage([200, 100]);
    const { context } = doc;
    const outlines = context.register(context.obj({ Type: "Outlines", Count: 0 }));
    doc.catalog.set(PDFName.of("Outlines"), outlines);
    doc.catalog.set(PDFName.of("Names"), context.obj({ EmbeddedFiles: { Names: [] } }));
    const bytes = await doc.save({ useObjectStreams: false });
    const source = [{ id: "m", name: "m.pdf", bytes, pageCount: 1 }];
    const kept = await exportDocument(plan([page({ source: "m", index: 0, width: 200, height: 100, objects: [box({ x: 10, y: 10, width: 20, height: 20 })] })], source));
    const keptDoc = await PDFDocument.load(kept.bytes);
    expect(keptDoc.getTitle()).toBe("Secret plan");
    const cleared = await exportDocument({
      sources: source,
      pages: [page({ source: "m", index: 0, width: 200, height: 100, objects: [box({ x: 10, y: 10, width: 20, height: 20 })] })],
      options: { fileName: "out.pdf", removeProperties: true, removeBookmarks: true, removeAttachments: true },
    });
    const clearedDoc = await PDFDocument.load(cleared.bytes);
    expect(clearedDoc.getTitle() ?? "").toBe("");
    expect(clearedDoc.getAuthor() ?? "").toBe("");
    expect(clearedDoc.catalog.has(PDFName.of("Outlines"))).toBe(false);
    expect(new TextDecoder("latin1").decode(cleared.bytes)).not.toContain("Secret plan");
  });

  it("changes nothing about a page without redaction boxes", async () => {
    const plain = await exportDocument(plan([page({ source: "o", index: 0, width: 400, height: 500 })], [pdf()]));
    expect(plain.report.redactions).toEqual([]);
  });
});
