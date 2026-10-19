import { PDFDocument, PDFName } from "@cantoo/pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { type TextRun, interpret } from "../../../src/lib/pdf/engine/interpret";
import { IDENTITY } from "../../../src/lib/pdf/engine/matrix";
import { readPageContent } from "../../../src/lib/pdf/engine/streams";
import { courier, helvetica, interpretPage, rawPdf, reload, times } from "../helpers/rawPdf";

/** Text items as pdf.js (an independent reader) sees them, for cross-checking our positions and widths. */
async function pdfjsItems(bytes: Uint8Array) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    return content.items.filter((item) => "str" in item && item.str.trim() !== "").map((item) => {
      const it = item as { str: string; transform: number[]; width: number; height: number };
      return { str: it.str, x: it.transform[4] as number, y: it.transform[5] as number, width: it.width, height: it.height };
    });
  } finally {
    await task.destroy();
  }
}

const runsOf = (runs: TextRun[]) => runs.map((run) => run.text);

describe("content stream interpreter: text runs", () => {
  it("finds each text-showing operation with its text, font, size and position", async () => {
    const raw = await rawPdf({
      fonts: { F1: helvetica, F2: times },
      content: "BT /F1 24 Tf 72 700 Td (Hello World) Tj ET BT /F2 12 Tf 72 650 Td (The quick brown fox) Tj ET",
    });
    const { runs, problems } = interpretPage(raw.doc);
    expect(problems).toEqual([]);
    expect(runsOf(runs)).toEqual(["Hello World", "The quick brown fox"]);
    const [hello, fox] = runs as [TextRun, TextRun];
    expect(hello.font.baseFont).toBe("Helvetica");
    expect(hello.fontName).toBe("F1");
    expect(hello.fontSize).toBe(24);
    expect(hello.matrix.slice(4)).toEqual([72, 700]);
    expect(fox.font.family).toBe("serif");
    expect(fox.matrix.slice(4)).toEqual([72, 650]);
    // Helvetica AFM: H722 e556 l222 l222 o556 space278 W944 o556 r333 l222 d556 = 5167/1000 * 24
    expect(hello.advance).toBeCloseTo((5167 / 1000) * 24, 3);
    // the box starts at the origin and is as wide as the text
    expect(hello.box.x).toBeCloseTo(72, 3);
    expect(hello.box.width).toBeCloseTo(hello.advance, 3);
    expect(hello.box.y).toBeLessThan(700);
    expect(hello.box.y + hello.box.height).toBeGreaterThan(700);
  });

  it("agrees with pdf.js about where text is and how wide it is", async () => {
    const raw = await rawPdf({
      fonts: { F1: helvetica, F2: times, F3: courier },
      content: "BT /F1 18 Tf 50 740 Td (Alpha beta gamma) Tj 0 -30 Td /F2 14 Tf (Delta epsilon) Tj 0 -30 Td /F3 10 Tf (Courier line) Tj ET",
    });
    const { runs } = interpretPage(raw.doc);
    const bytes = await raw.doc.save();
    const items = await pdfjsItems(bytes);
    expect(items.length).toBe(runs.length);
    for (const run of runs) {
      const match = items.find((item) => item.str === run.text);
      expect(match, run.text).toBeDefined();
      expect(run.matrix[4]).toBeCloseTo(match?.x ?? Number.NaN, 2);
      expect(run.matrix[5]).toBeCloseTo(match?.y ?? Number.NaN, 2);
      expect(run.advance).toBeCloseTo(match?.width ?? Number.NaN, 1);
    }
  });

  it("applies character spacing, word spacing and horizontal scaling to the advance", async () => {
    const plain = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 10 Tf (a b) Tj ET" });
    const spaced = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 10 Tf 2 Tc 5 Tw 50 Tz (a b) Tj ET" });
    const base = interpretPage(plain.doc).runs[0] as TextRun;
    const run = interpretPage(spaced.doc).runs[0] as TextRun;
    // a(556) space(278) b(556) at 10pt = 13.9, plus 3 glyphs * Tc 2 + 1 space * Tw 5, all scaled by 50%
    expect(base.advance).toBeCloseTo(13.9, 3);
    expect(run.advance).toBeCloseTo((13.9 + 3 * 2 + 5) * 0.5, 3);
    expect(run.charSpacing).toBe(2);
    expect(run.wordSpacing).toBe(5);
    expect(run.hScale).toBe(0.5);
  });

  it("counts TJ adjustments in the advance and keeps strings and adjustments as separate elements", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 10 Tf 100 100 Td [(A) -500 (V) 120 (A)] TJ ET" });
    const run = interpretPage(raw.doc).runs[0] as TextRun;
    expect(run.operator).toBe("TJ");
    expect(run.elements.map((e) => e.kind)).toEqual(["str", "adj", "str", "adj", "str"]);
    // A667 V667 A667 = 20.01, minus (-500 + 120)/1000 * 10 = +3.8
    expect(run.advance).toBeCloseTo(20.01 + 5 - 1.2, 3);
    expect(run.text).toBe("A VA"); // a wide gap reads as a space; a small one does not
  });

  it("handles the next-line operators ' and \" with leading and spacing", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 12 Tf 14 TL 72 700 Td (first) Tj (second) ' 3 1 (third) \" ET" });
    const runs = interpretPage(raw.doc).runs;
    expect(runsOf(runs)).toEqual(["first", "second", "third"]);
    expect(runs[1]?.matrix.slice(4)).toEqual([72, 686]);
    expect(runs[2]?.matrix.slice(4)).toEqual([72, 672]);
    expect(runs[2]?.wordSpacing).toBe(3);
    expect(runs[2]?.charSpacing).toBe(1);
    expect(runs[1]?.newline).toBe(true);
  });

  it("follows rotation and scaling from Tm, cm and q/Q", async () => {
    const raw = await rawPdf({
      fonts: { F1: helvetica },
      content: "q 2 0 0 2 10 20 cm BT /F1 10 Tf 0 1 -1 0 100 100 Tm (up) Tj ET Q BT /F1 10 Tf 5 5 Td (plain) Tj ET",
    });
    const [rotated, plain] = interpretPage(raw.doc).runs as [TextRun, TextRun];
    // Tm (0 1 -1 0 100 100) then cm scale 2 + shift: the text runs upwards, twice as large
    expect(rotated.matrix[0]).toBeCloseTo(0, 6);
    expect(rotated.matrix[1]).toBeCloseTo(2, 6);
    expect(rotated.matrix[2]).toBeCloseTo(-2, 6);
    expect(rotated.matrix.slice(4)).toEqual([210, 220]);
    expect(rotated.box.height).toBeGreaterThan(rotated.box.width);
    // after Q the scaling is gone
    expect(plain.matrix.slice(4)).toEqual([5, 5]);
    expect(plain.matrix[0]).toBe(1);
  });

  it("reads hex strings and octal escapes through the font's encoding", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 12 Tf 10 10 Td <48656c6c6f> Tj (\\101\\102\\051) Tj ET" });
    expect(runsOf(interpretPage(raw.doc).runs)).toEqual(["Hello", "AB)"]);
  });

  it("marks runs that continue from the previous one and runs that were repositioned", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 12 Tf 10 100 Td (one) Tj (two) Tj 0 -20 Td (three) Tj ET BT /F1 12 Tf (four) Tj ET" });
    const runs = interpretPage(raw.doc).runs;
    expect(runs.map((r) => r.flowFrom)).toEqual([null, 0, null, null]);
    expect(runs.map((r) => r.textObject)).toEqual([0, 0, 0, 1]);
    // the second run starts exactly where the first one ended
    const first = runs[0] as TextRun;
    expect((runs[1] as TextRun).matrix[4]).toBeCloseTo(first.matrix[4] + first.advance, 6);
  });

  it("tracks the fill colour of text", async () => {
    const raw = await rawPdf({
      fonts: { F1: helvetica },
      content: "BT /F1 12 Tf 0 0 Td 1 0 0 rg (red) Tj 0.5 g (grey) Tj 0 0 0 1 k (cmyk) Tj ET",
    });
    expect(interpretPage(raw.doc).runs.map((r) => r.fill)).toEqual(["#ff0000", "#808080", "#000000"]);
  });

  it("finds text inside form XObjects and says how deep it was", async () => {
    const raw = await rawPdf({
      fonts: { F1: helvetica },
      content: "BT /F1 12 Tf 10 10 Td (page) Tj ET q 1 0 0 1 100 200 cm /Fm1 Do Q",
      setup: ({ doc, resources, page }) => {
        const form = doc.context.flateStream("BT /F1 10 Tf 5 5 Td (in form) Tj ET", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 50], Resources: { Font: { F1: doc.context.obj({ ...helvetica }) } } });
        const xobjects = doc.context.obj({ Fm1: doc.context.register(form) });
        resources.set(PDFName.of("XObject"), xobjects);
        void page;
      },
    });
    const result = interpretPage(raw.doc);
    expect(runsOf(result.runs)).toEqual(["page", "in form"]);
    expect(result.runs.map((r) => r.depth)).toEqual([0, 1]);
    expect(result.runs[1]?.source.kind).toBe("form");
    expect(result.runs[1]?.matrix.slice(4)).toEqual([105, 205]);
    expect(result.forms).toHaveLength(1);
  });

  it("does not loop on a form that draws itself", async () => {
    const raw = await rawPdf({
      fonts: { F1: helvetica },
      content: "/Fm1 Do",
      setup: ({ doc, resources }) => {
        const form = doc.context.flateStream("BT /F1 10 Tf (again) Tj ET /Fm1 Do", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10] });
        const ref = doc.context.register(form);
        const xobjects = doc.context.obj({ Fm1: ref });
        form.dict.set(PDFName.of("Resources"), doc.context.obj({ XObject: xobjects, Font: { F1: doc.context.obj({ ...helvetica }) } }));
        resources.set(PDFName.of("XObject"), xobjects);
      },
    });
    const result = interpretPage(raw.doc);
    expect(runsOf(result.runs)).toEqual(["again"]);
  });

  it("records the replacement text of marked content with /ActualText", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 12 Tf 10 10 Td /Span <</ActualText (fi)>> BDC (f) Tj (i) Tj EMC (plain) Tj ET" });
    const runs = interpretPage(raw.doc).runs;
    expect(runs.map((r) => r.actualText)).toEqual(["fi", "fi", null]);
  });

  it("reports images and path extents with their placement", async () => {
    const raw = await rawPdf({
      fonts: { F1: helvetica },
      content: "q 100 0 0 50 20 30 cm /Im1 Do Q 1 0 0 rg 10 10 80 40 re f BI /W 2 /H 2 /BPC 8 /CS /G ID abcd EI",
      resources: { XObject: {} },
      setup: ({ doc, resources }) => {
        const image = doc.context.stream(new Uint8Array([0, 64, 128, 255]), { Type: "XObject", Subtype: "Image", Width: 2, Height: 2, ColorSpace: "DeviceGray", BitsPerComponent: 8 });
        (resources.lookup(PDFName.of("XObject")) as unknown as { set(k: PDFName, v: unknown): void }).set(PDFName.of("Im1"), doc.context.register(image));
      },
    });
    const result = interpretPage(raw.doc);
    expect(result.images).toHaveLength(2);
    expect(result.images[0]).toMatchObject({ name: "Im1", inline: false, pixelWidth: 2, pixelHeight: 2 });
    expect(result.images[0]?.box).toEqual({ x: 20, y: 30, width: 100, height: 50 });
    expect(result.images[1]?.inline).toBe(true);
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]).toMatchObject({ box: { x: 10, y: 10, width: 80, height: 40 }, fill: true, stroke: false, depth: 0, clipped: false, built: "re", startOp: 5, endOp: 6 });
    expect(result.paths[0]?.outline).toEqual([{ points: [[10, 10], [90, 10], [90, 50], [10, 50]], closed: true }]);
    // Everything painted shares one order, so a click can tell what is on top.
    expect(result.images.map((i) => i.seq)).toEqual([0, 2]);
    expect(result.paths[0]?.seq).toBe(1);
  });

  it("keeps the operators that built a path and flattens curves into its outline", async () => {
    const raw = await rawPdf({ fonts: {}, content: "0 0 1 rg 100 100 m 200 100 l 150 200 l h f 0 0 m 10 0 l S 5 5 m 5 5 20 20 30 5 c 1 w 3 3 40 40 re W n 0 0 5 5 re f" });
    const paths = interpretPage(raw.doc).paths;
    expect(paths.map((p) => p.built)).toEqual(["m l l h", "m l", "re"]);
    expect(paths[0]?.outline?.[0]).toEqual({ points: [[100, 100], [200, 100], [150, 200]], closed: true });
    expect(paths[1]).toMatchObject({ fill: false, stroke: true });
    // A clip-only path (W n) is not a drawn shape; the following rectangle is.
    expect(paths).toHaveLength(3);
  });

  it("marks a path that is also a clip so it is not treated as movable", async () => {
    const raw = await rawPdf({ fonts: {}, content: "q 0 0 50 50 re W f Q 60 60 10 10 re f" });
    const paths = interpretPage(raw.doc).paths;
    expect(paths.map((p) => p.clipped)).toEqual([true, false]);
  });

  it("names the streams of forms by where they are drawn, not by their object number", async () => {
    const raw = await rawPdf({
      fonts: { F1: helvetica },
      content: "/Fm1 Do /Fm1 Do",
      resources: { XObject: {} },
      setup: ({ doc, resources }) => {
        const form = doc.context.stream("BT /F1 12 Tf 5 5 Td (inside) Tj ET", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 100] });
        const ref = doc.context.register(form);
        form.dict.set(PDFName.of("Resources"), doc.context.obj({ Font: { F1: doc.context.obj({ ...helvetica }) } }));
        (resources.lookup(PDFName.of("XObject")) as unknown as { set(k: PDFName, v: unknown): void }).set(PDFName.of("Fm1"), ref);
      },
    });
    const ids = interpretPage(raw.doc).runs.map((r) => r.id);
    expect(ids).toEqual(["page/Fm1@0#3", "page/Fm1@1#3"]);
  });

  it("copes with a missing font resource, text before any Tf, and absurd operands", async () => {
    const raw = await rawPdf({ fonts: {}, content: "BT /Nope 12 Tf 10 10 Td (lost) Tj ET BT (no font) Tj 1e9 0 0 1 0 0 Tm (x) Tj ET" });
    const result = interpretPage(raw.doc);
    expect(result.runs.length).toBeGreaterThanOrEqual(2);
    for (const run of result.runs) expect(Number.isFinite(run.advance)).toBe(true);
  });

  it("is not thrown by unbalanced Q, deep q nesting, or operators without operands", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: `Q Q Q ${"q ".repeat(1000)} BT Td Tj TJ ' " Tf Tm /F1 12 Tf (still read) Tj ET` });
    expect(runsOf(interpretPage(raw.doc).runs)).toEqual(["still read"]);
  });

  it("works on a document read back from bytes, not only one just built", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 12 Tf 10 10 Td (round trip) Tj ET" });
    const again = await reload(raw.doc);
    expect(runsOf(interpretPage(again).runs)).toEqual(["round trip"]);
  });

  it("light mode only records which codes each font is used with", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 12 Tf 10 10 Td (abca) Tj ET" });
    const fonts = new Map();
    const source = readPageContent(raw.doc, raw.doc.getPage(0));
    const result = interpret(raw.doc, source, IDENTITY, fonts, { light: true });
    expect(result.runs).toHaveLength(0);
    const font = [...fonts.values()][0];
    expect([...(font?.used ?? [])].sort()).toEqual([97, 98, 99]);
  });

  it("keeps the exact byte range of the operation so it can be replaced", async () => {
    const content = "BT /F1 12 Tf 10 10 Td (edit me) Tj ET";
    const raw = await rawPdf({ fonts: { F1: helvetica }, content });
    const run = interpretPage(raw.doc).runs[0] as TextRun;
    const data = run.source.data;
    expect(new TextDecoder().decode(data.slice(run.op.start, run.op.end))).toBe("(edit me) Tj");
    expect(run.elements[0]).toMatchObject({ kind: "str" });
  });
});

describe("content stream interpreter: pages from other writers", () => {
  it("reads a pdf-lib page with an embedded standard font", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont("Helvetica");
    doc.addPage([300, 200]).drawText("drawn by pdf-lib", { x: 20, y: 100, size: 15, font });
    const result = interpretPage(await reload(doc));
    expect(runsOf(result.runs)).toEqual(["drawn by pdf-lib"]);
    expect(result.runs[0]?.fontSize).toBe(15);
  });
});
