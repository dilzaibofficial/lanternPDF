import { type PDFDict, PDFDocument, PDFName, PDFString } from "@cantoo/pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import type { PageAnalysis } from "../../../src/lib/pdf/engine/analyze";
import { prune } from "./redactHelpers";
import { type RedactionArea, redactPage } from "../../../src/lib/pdf/engine/redact";
import { EngineSession } from "../../../src/lib/pdf/engine/session";
import { fixtureBytes } from "../../fixtures/build";
import { makeImage } from "../helpers/images";
import { helvetica, rawPdf } from "../helpers/rawPdf";
import { type Raster, type Region, difference, expectEditedOnlyIn, rasterize } from "../helpers/visual";

/**
 * Redaction takes things out of the file. Every test looks at the saved file itself (its text, its pictures, its bytes) and
 * renders it before and after to prove nothing outside the redacted area changed.
 */

const SCALE = 2;
const area = (x: number, y: number, width: number, height: number, rotation = 0): RedactionArea => ({ x, y, width, height, rotation });

async function textItems(bytes: Uint8Array, pageNumber = 1) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    return content.items
      .filter((item) => "str" in item && item.str.trim() !== "")
      .map((item) => {
        const it = item as { str: string; transform: number[]; width: number };
        return { text: it.str, x: it.transform[4] as number, y: it.transform[5] as number };
      });
  } finally {
    await task.destroy();
  }
}

const textOf = async (bytes: Uint8Array, pageNumber = 1) => (await textItems(bytes, pageNumber)).map((i) => i.text).join(" ");

async function redacted(bytes: Uint8Array, areas: RedactionArea[], pageIndex = 0) {
  const doc = await PDFDocument.load(bytes);
  const report = await redactPage(doc, pageIndex, areas);
  prune(doc);
  // Written without object streams so the file's bytes can be searched.
  return { bytes: await doc.save({ useObjectStreams: false }), report, doc };
}

const px = (box: { x: number; y: number; width: number; height: number }, pad = 3): Region => ({
  x0: Math.max(0, Math.floor(box.x * SCALE - pad)),
  y0: Math.max(0, Math.floor(box.y * SCALE - pad)),
  x1: Math.ceil((box.x + box.width) * SCALE + pad),
  y1: Math.ceil((box.y + box.height) * SCALE + pad),
});

const lineOf = (analysis: PageAnalysis, text: string) => {
  const line = analysis.lines.find((l) => l.text === text);
  if (!line) throw new Error(`no line “${text}”`);
  return line;
};

describe("redacting text", () => {
  it("removes the words under a box from the file, keeps everything else where it was, and the page looks the same elsewhere", async () => {
    const original = fixtureBytes("pdfkit-standard.pdf");
    const analysis = (await EngineSession.open({ name: "p.pdf", bytes: original })).analyze(0);
    const row = lineOf(analysis, "Revenue   1,204,000");
    // The figure is the right-hand end of the line.
    const figure = area(row.box.x + row.box.width * 0.55, row.box.y - 1, row.box.width * 0.5, row.box.height + 2);
    const before = await rasterize(original, 1, SCALE);
    const result = await redacted(original, [figure]);
    expect(result.report.verified).toBe(true);
    expect(result.report.glyphs).toBeGreaterThan(5);
    const text = await textOf(result.bytes);
    expect(text).not.toContain("1,204,000");
    expect(text).toContain("Revenue");
    expect(text).toContain("Annual Report");
    // The words really are gone from the content, not hidden: not even their glyph codes are in the stream.
    const doc = await PDFDocument.load(result.bytes);
    const extracted = (await EngineSession.open({ name: "r.pdf", bytes: await doc.save() })).analyze(0).lines.map((l) => l.text).join("|");
    expect(extracted).not.toMatch(/204|000/);
    // A glyph that is cut by the box is removed whole, so the area it covers reaches a little beyond the box.
    expectEditedOnlyIn("redact figure", before, await rasterize(result.bytes, 1, SCALE), [px(figure, 8)]);
  });

  it("removes only the glyphs under the box when it covers part of a line, and the rest keeps its exact place", async () => {
    const original = fixtureBytes("pdfkit-standard.pdf");
    const analysis = (await EngineSession.open({ name: "p.pdf", bytes: original })).analyze(0);
    const title = lineOf(analysis, "Annual Report");
    const before = await textItems(original);
    const left = before.find((i) => i.text.startsWith("Annual"));
    // Cover "Annual" (the first six letters) and a little of the space after.
    const offsets = title.charOffsets;
    const box = area(title.box.x + (offsets[0] ?? 0) - 1, title.box.y - 1, (offsets[6] ?? 0) + 1, title.box.height + 2);
    const result = await redacted(original, [box]);
    const after = await textItems(result.bytes);
    expect(after.some((i) => i.text.includes("Annual"))).toBe(false);
    const rest = after.find((i) => i.text.includes("Report"));
    const was = before.find((i) => i.text.includes("Annual"));
    expect(rest).toBeTruthy();
    // "Report" is drawn exactly where it was when the line was whole.
    const reportAt = (was?.x ?? 0) + (title.charOffsets[7] ?? 0);
    expect(rest?.x).toBeCloseTo(reportAt, 0);
    expect(left).toBeTruthy();
  });

  it("works on text a browser wrote one glyph at a time", async () => {
    const original = fixtureBytes("chromium-article.pdf");
    const analysis = (await EngineSession.open({ name: "c.pdf", bytes: original })).analyze(0);
    const line = analysis.lines.find((l) => l.text.startsWith("The company grew steadily"))!;
    const start = line.text.indexOf("steadily");
    const box = area(line.box.x + (line.charOffsets[start] ?? 0) - 0.5, line.box.y, (line.charOffsets[start + 8] ?? 0) - (line.charOffsets[start] ?? 0) + 1, line.box.height);
    const before = await rasterize(original, 1, SCALE);
    const result = await redacted(original, [box]);
    expect(result.report.verified).toBe(true);
    const text = await textOf(result.bytes);
    expect(text).not.toContain("steadily");
    expect(text).toContain("The company grew");
    expect(text).toContain("during the year");
    expectEditedOnlyIn("redact word in chromium page", before, await rasterize(result.bytes, 1, SCALE), [px(box)]);
  });

  it("removes invisible text, such as the layer an OCR program leaves over a scan, and text with a replacement", async () => {
    const raw = await rawPdf({
      size: [300, 200],
      fonts: { F1: helvetica },
      content: "BT /F1 12 Tf 20 150 Td (visible) Tj ET BT /F1 12 Tf 3 Tr 20 100 Td (hidden secret) Tj ET BT /F1 12 Tf 0 Tr 20 50 Td /Span <</ActualText (replacement secret)>> BDC (shown) Tj EMC ET",
    });
    const bytes = await raw.doc.save();
    const result = await redacted(bytes, [area(10, 70, 200, 30), area(10, 120, 200, 30)]);
    expect(result.report.verified).toBe(true);
    const content = new TextDecoder("latin1").decode(
      // Look in the decoded content, not the compressed file.
      (await EngineSession.open({ name: "r.pdf", bytes: result.bytes })).doc.getPage(0).node.Contents() ? await decodedContent(result.bytes) : new Uint8Array(),
    );
    expect(content).not.toContain("replacement secret");
    expect(content).not.toContain("hidden secret");
    expect(await textOf(result.bytes)).toContain("visible");
    expect(await textOf(result.bytes)).not.toContain("hidden");
  });
});

async function decodedContent(bytes: Uint8Array): Promise<Uint8Array> {
  const { readPageContent } = await import("../../../src/lib/pdf/engine/streams");
  const doc = await PDFDocument.load(bytes);
  return readPageContent(doc, doc.getPage(0)).data;
}

describe("redacting pictures", () => {
  it("blanks the pixels of a picture under a box, for this page only, and leaves the rest of the picture alone", async () => {
    const original = fixtureBytes("objects.pdf");
    const before = await rasterize(original, 1, SCALE);
    // The picture is 220…340 × 140…200; cover its right half below the orange square.
    const box = area(280, 172, 60, 28);
    const result = await redacted(original, [box]);
    expect(result.report).toMatchObject({ imagesBlanked: 1, imagesRemoved: 0, verified: true });
    const after = await rasterize(result.bytes, 1, SCALE);
    expectEditedOnlyIn("blank picture", before, after, [px(box)]);
    const at = (r: Raster, x: number, y: number) => r.data.slice((Math.round(y * SCALE) * r.width + Math.round(x * SCALE)) * 4, (Math.round(y * SCALE) * r.width + Math.round(x * SCALE)) * 4 + 3);
    expect(Array.from(at(after, 310, 190))).toEqual([0, 0, 0]);
    expect(Array.from(at(after, 240, 190))).toEqual(Array.from(at(before, 240, 190)));
  });

  it("removes a picture that is wholly under a box, and its data leaves the file", async () => {
    const original = fixtureBytes("objects.pdf");
    const result = await redacted(original, [area(215, 135, 130, 70)]);
    expect(result.report.imagesRemoved).toBe(1);
    expect(new TextDecoder("latin1").decode(original)).toContain("/Subtype /Image");
    expect(new TextDecoder("latin1").decode(result.bytes)).not.toContain("/Subtype /Image");
  });

  it("does not touch the same picture on another page", async () => {
    const doc = await PDFDocument.create();
    const image = await doc.embedPng(new Uint8Array(makeImage("png", 40, 20)));
    for (let i = 0; i < 2; i += 1) doc.addPage([200, 100]).drawImage(image, { x: 20, y: 20, width: 160, height: 60 });
    const original = await doc.save();
    const before2 = await rasterize(original, 2, SCALE);
    const result = await redacted(original, [area(100, 20, 80, 60)], 0);
    expect(result.report.imagesBlanked).toBe(1);
    const after2 = await rasterize(result.bytes, 2, SCALE);
    expect(difference(before2, after2).changed).toBe(0);
    const after1 = await rasterize(result.bytes, 1, SCALE);
    const before1 = await rasterize(original, 1, SCALE);
    expect(difference(before1, after1).changed).toBeGreaterThan(0);
  });

  it("removes a picture it cannot edit pixel by pixel instead of leaving it, and says so", async () => {
    const raw = await rawPdf({
      size: [200, 100],
      fonts: {},
      content: "q 160 0 0 60 20 20 cm /Im1 Do Q",
      resources: { XObject: {} },
      setup: ({ doc, resources }) => {
        // A CMYK picture: not one the editor re-encodes.
        const picture = doc.context.stream(new Uint8Array(4 * 4 * 4).fill(40), { Type: "XObject", Subtype: "Image", Width: 4, Height: 4, ColorSpace: "DeviceCMYK", BitsPerComponent: 8 });
        (resources.lookup(PDFName.of("XObject")) as PDFDict).set(PDFName.of("Im1"), doc.context.register(picture));
      },
    });
    const result = await redacted(await raw.doc.save(), [area(100, 20, 60, 60)]);
    expect(result.report.imagesRemoved).toBe(1);
    expect(result.report.warnings.join(" ")).toMatch(/whole picture was removed/);
    expect(new TextDecoder("latin1").decode(result.bytes)).not.toContain("/Subtype /Image");
  });
});

describe("redacting shapes and annotations", () => {
  it("removes shapes that lie wholly under a box, keeps those only partly under it, and reports the latter", async () => {
    const original = fixtureBytes("objects.pdf");
    const before = await rasterize(original, 1, SCALE);
    // The triangle (60…160 × 120…200) is wholly under this box; the blue frame (60…340 × 240…340) is only partly.
    const result = await redacted(original, [area(50, 110, 120, 100), area(40, 300, 100, 100)]);
    expect(result.report.shapesRemoved).toBeGreaterThanOrEqual(1);
    expect(result.report.shapesKept).toBeGreaterThanOrEqual(1);
    expect(result.report.warnings.join(" ")).toMatch(/only partly under a redaction box/);
    const after = await rasterize(result.bytes, 1, SCALE);
    const at = (r: Raster, x: number, y: number) => Array.from(r.data.slice((Math.round(y * SCALE) * r.width + Math.round(x * SCALE)) * 4, (Math.round(y * SCALE) * r.width + Math.round(x * SCALE)) * 4 + 3));
    expect(at(after, 110, 180)).toEqual([255, 255, 255]);
    expect(at(before, 110, 180)).toEqual([255, 0, 0]);
  });

  it("removes notes, links and form fields under a box, with their pop-ups, and leaves the others", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const { context } = doc;
    const popup = context.register(context.obj({ Type: "Annot", Subtype: "Popup", Rect: [250, 100, 290, 140] }));
    const note = context.register(context.obj({ Type: "Annot", Subtype: "Text", Rect: [20, 100, 40, 120], Contents: PDFString.of("secret note"), Popup: popup }));
    (context.lookup(popup) as PDFDict).set(PDFName.of("Parent"), note);
    const link = context.register(context.obj({ Type: "Annot", Subtype: "Link", Rect: [20, 20, 80, 40], A: { S: "URI", URI: PDFString.of("https://secret.example/") } }));
    const keep = context.register(context.obj({ Type: "Annot", Subtype: "Text", Rect: [200, 20, 220, 40], Contents: PDFString.of("other note") }));
    const field = context.register(context.obj({ Type: "Annot", Subtype: "Widget", FT: "Tx", T: PDFString.of("name"), V: PDFString.of("Jane Doe"), Rect: [20, 150, 120, 170] }));
    page.node.set(PDFName.of("Annots"), context.obj([note, popup, link, keep, field]));
    doc.catalog.set(PDFName.of("AcroForm"), context.obj({ Fields: [field] }));
    const original = await doc.save();
    // In display space y is measured from the top: the note (100…120 from the bottom) is at 80…100, the link at 160…180, the field at 30…50.
    const result = await redacted(original, [area(10, 75, 40, 30), area(10, 155, 80, 30), area(10, 25, 120, 30)]);
    const text = new TextDecoder("latin1").decode(result.bytes);
    expect(result.report.annotationsRemoved).toBe(3);
    expect(text).toContain("other note");
    for (const gone of ["secret note", "secret.example", "Jane Doe"]) expect(text).not.toContain(gone);
    // The popup of the removed note and the removed field are gone from the page and the form.
    const after = await PDFDocument.load(result.bytes);
    const kept = after.getPage(0).node.lookup(PDFName.of("Annots")) as unknown as { size(): number };
    expect(kept.size()).toBe(1);
    const form = after.catalog.lookup(PDFName.of("AcroForm")) as unknown as PDFDict;
    expect((form.lookup(PDFName.of("Fields")) as unknown as { size(): number }).size()).toBe(0);
  });
});

describe("what is not redacted without saying so", () => {
  it("refuses to claim a page is redacted when its content cannot be read", async () => {
    const raw = await rawPdf({ size: [200, 100], fonts: { F1: helvetica }, content: "BT /F1 12 Tf 20 50 Td (secret) Tj ET" });
    // A stream in a compression nothing here can read.
    const stream = raw.doc.context.stream(new Uint8Array([1, 2, 3, 4]), { Filter: "FooDecode" });
    raw.page.node.set(PDFName.of("Contents"), raw.doc.context.register(stream));
    const report = await redactPage(raw.doc, 0, [area(0, 0, 200, 100)]);
    expect(report.verified).toBe(false);
    expect(report.warnings.join(" ")).toMatch(/Nothing on this page was redacted/);
  });
});

describe("redaction in unusual files", () => {
  const formDocument = async (draws: number) => {
    const raw = await rawPdf({
      size: [400, 200],
      fonts: {},
      content: Array.from({ length: draws }, (_, i) => `q 1 0 0 1 ${20 + i * 180} 100 cm /Fm1 Do Q`).join(" "),
      resources: { XObject: {} },
      setup: ({ doc, resources }) => {
        const form = doc.context.stream("BT /F1 14 Tf 4 20 Td (secret words) Tj ET 1 0 0 rg 0 0 30 10 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 170, 60] });
        form.dict.set(PDFName.of("Resources"), doc.context.obj({ Font: { F1: doc.context.obj({ ...helvetica }) } }));
        (resources.lookup(PDFName.of("XObject")) as PDFDict).set(PDFName.of("Fm1"), doc.context.register(form));
      },
    });
    return raw.doc.save({ useObjectStreams: false });
  };

  it("edits text inside a reusable block that the page draws once", async () => {
    const original = await formDocument(1);
    const before = await rasterize(original, 1, SCALE);
    // The text sits on the line 120 from the bottom, so about 70…84 from the top, and the red mark below it is 90…100.
    const box = area(20, 66, 90, 20);
    const result = await redacted(original, [box]);
    expect(result.report).toMatchObject({ glyphs: 12, blocksRemoved: 0, verified: true });
    expect(await textOf(result.bytes)).not.toContain("secret");
    // The red mark under the text, drawn by the same block, is still there.
    const after = await rasterize(result.bytes, 1, SCALE);
    expectEditedOnlyIn("redact in a block", before, after, [px(box, 6)]);
  });

  it("removes a reusable block the page draws twice from the place that is redacted, and keeps the other place", async () => {
    const original = await formDocument(2);
    const result = await redacted(original, [area(20, 66, 90, 20)]);
    expect(result.report.blocksRemoved).toBe(1);
    expect(result.report.warnings.join(" ")).toMatch(/more than one place/);
    const text = await textOf(result.bytes);
    // Only the second place still has its words.
    expect(text.match(/secret/g)?.length).toBe(1);
  });

  it("works on a page with a crop box and a turn", async () => {
    const original = fixtureBytes("pdflib-rotated.pdf");
    const analysis = (await EngineSession.open({ name: "r.pdf", bytes: original })).analyze(0);
    const title = analysis.lines.find((l) => l.text === "Rotated page title");
    expect(title).toBeTruthy();
    const before = await rasterize(original, 1, SCALE);
    const result = await redacted(original, [area(title!.box.x - 1, title!.box.y - 1, title!.box.width + 2, title!.box.height + 2)]);
    expect(result.report.verified).toBe(true);
    expect(await textOf(result.bytes)).not.toContain("Rotated page title");
    expect(await textOf(result.bytes)).toContain("Lower left text");
    expectEditedOnlyIn("redact on a turned page", before, await rasterize(result.bytes, 1, SCALE), [px({ x: title!.box.x, y: title!.box.y, width: title!.box.width, height: title!.box.height }, 5)]);
  });

  it("redacts text that was just edited, because it is read as the page now is", async () => {
    const { applyTextEdits } = await import("../../../src/lib/pdf/engine/textEdit");
    const original = fixtureBytes("pdfkit-standard.pdf");
    const doc = await PDFDocument.load(original);
    const analysis = (await EngineSession.open({ name: "p.pdf", bytes: original })).analyze(0);
    const title = lineOf(analysis, "Annual Report");
    await applyTextEdits(doc, 0, [{ lineId: title.id, text: "Annual Secret" }]);
    const report = await redactPage(doc, 0, [area(title.box.x - 1, title.box.y - 1, title.box.width + 40, title.box.height + 2)]);
    prune(doc);
    const saved = await doc.save({ useObjectStreams: false });
    expect(report.verified).toBe(true);
    expect(await textOf(saved)).not.toContain("Secret");
    expect(await textOf(saved)).not.toContain("Annual");
  });

  it("takes words out of a justified line without moving the words that stay", async () => {
    const original = fixtureBytes("pdfkit-standard.pdf");
    const analysis = (await EngineSession.open({ name: "p.pdf", bytes: original })).analyze(0);
    const line = analysis.lines.find((l) => l.text.startsWith("keeping costs"))!;
    const before = await rasterize(original, 1, SCALE);
    const start = line.text.indexOf("costs");
    const box = area(line.box.x + (line.charOffsets[start] ?? 0) - 0.5, line.box.y - 0.5, (line.charOffsets[start + 5] ?? 0) - (line.charOffsets[start] ?? 0) + 1, line.box.height + 1);
    const result = await redacted(original, [box]);
    expect(await textOf(result.bytes)).not.toContain("costs");
    // Everything else on the page, including the words to the right of the removed one on this very line, is pixel for pixel where it was.
    expectEditedOnlyIn("redact a word of a justified line", before, await rasterize(result.bytes, 1, SCALE), [px(box, 5)]);
  });
});
