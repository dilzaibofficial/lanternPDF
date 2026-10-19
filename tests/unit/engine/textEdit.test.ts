import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PDFDocument, PDFName } from "@cantoo/pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { engineContext } from "../../../src/lib/pdf/engine/context";
import { interpret } from "../../../src/lib/pdf/engine/interpret";
import { type TextLine, buildLines } from "../../../src/lib/pdf/engine/lines";
import { IDENTITY } from "../../../src/lib/pdf/engine/matrix";
import { pruneUnreachable } from "../../../src/lib/pdf/engine/prune";
import { readPageContent } from "../../../src/lib/pdf/engine/streams";
import { type EditOutcome, type LineEditRequest, applyTextEdits } from "../../../src/lib/pdf/engine/textEdit";
import { helvetica, rawPdf, reload, times } from "../helpers/rawPdf";

const require = createRequire(import.meta.url);
const dejavu = () => new Uint8Array(readFileSync(require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf")));

function linesOf(doc: PDFDocument, pageIndex = 0): TextLine[] {
  const context = engineContext(doc);
  const result = interpret(doc, readPageContent(doc, doc.getPage(pageIndex)), IDENTITY, new Map(), {}, { formSources: context.formSources });
  return buildLines(result.runs);
}

const lineWith = (doc: PDFDocument, text: string, pageIndex = 0): TextLine => {
  const found = linesOf(doc, pageIndex).find((line) => line.text === text);
  if (!found) throw new Error(`no line “${text}”; have ${linesOf(doc, pageIndex).map((l) => `“${l.text}”`).join(", ")}`);
  return found;
};

async function pdfjsLines(bytes: Uint8Array, pageNumber = 1) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    return content.items
      .filter((item) => "str" in item && item.str.trim() !== "")
      .map((item) => {
        const it = item as { str: string; transform: number[]; width: number };
        return { str: it.str, x: it.transform[4] as number, y: it.transform[5] as number, width: it.width };
      });
  } finally {
    await task.destroy();
  }
}

/** Applies one edit, saves, and returns what a second, independent reader sees. */
async function edit(doc: PDFDocument, lineText: string, request: Omit<LineEditRequest, "lineId">, pageIndex = 0) {
  const line = lineWith(doc, lineText, pageIndex);
  const report = await applyTextEdits(doc, pageIndex, [{ lineId: line.id, ...request }]);
  pruneUnreachable(doc);
  const bytes = await doc.save();
  return { outcome: report.outcomes[0] as EditOutcome, report, bytes, items: await pdfjsLines(bytes, pageIndex + 1) };
}

const contentText = (doc: PDFDocument, pageIndex = 0) => new TextDecoder("latin1").decode(readPageContent(doc, doc.getPage(pageIndex)).data);
const hexOf = (text: string) => Array.from(text, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");

describe("existing text: replacing words in a standard font", () => {
  it("replaces a word in place, with the line's own font, and the old word is gone from the file", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 24 Tf 72 700 Td (Hello World) Tj ET BT /F1 12 Tf 72 650 Td (Another line) Tj ET" });
    const { outcome, items, bytes } = await edit(raw.doc, "Hello World", { text: "Hello There" });
    expect(outcome).toMatchObject({ status: "applied", mode: "A", verified: true });
    expect(items.map((i) => i.str)).toEqual(["Hello There", "Another line"]);
    // same start position
    expect(items[0]?.x).toBeCloseTo(72, 2);
    expect(items[0]?.y).toBeCloseTo(700, 2);
    // the old word is in neither the content nor anywhere in the saved bytes
    const after = await PDFDocument.load(bytes);
    const text = contentText(after);
    expect(text).not.toContain("World");
    expect(text).not.toContain(hexOf("World"));
    expect(new TextDecoder("latin1").decode(bytes)).not.toContain("World");
  });

  it("leaves every other line exactly as it was", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica, F2: times }, content: "BT /F1 24 Tf 72 700 Td (Title here) Tj ET BT /F2 12 Tf 72 650 Td (Body text stays) Tj ET BT /F1 9 Tf 300 100 Td (Footer) Tj ET" });
    const before = await pdfjsLines(await raw.doc.save());
    const { items } = await edit(raw.doc, "Title here", { text: "A new title" });
    const byText = new Map(items.map((i) => [i.str, i]));
    for (const keep of ["Body text stays", "Footer"]) {
      const was = before.find((i) => i.str === keep);
      const is = byText.get(keep);
      expect(is?.x).toBeCloseTo(was?.x ?? Number.NaN, 4);
      expect(is?.y).toBeCloseTo(was?.y ?? Number.NaN, 4);
      expect(is?.width).toBeCloseTo(was?.width ?? Number.NaN, 4);
    }
    expect(byText.has("A new title")).toBe(true);
  });

  it("inserts, deletes and replaces anywhere in the line", async () => {
    const make = () => rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 12 Tf 72 700 Td (The quick fox) Tj ET" });
    expect((await edit((await make()).doc, "The quick fox", { text: "The quick brown fox" })).items[0]?.str).toBe("The quick brown fox");
    expect((await edit((await make()).doc, "The quick fox", { text: "The fox" })).items[0]?.str).toBe("The fox");
    expect((await edit((await make()).doc, "The quick fox", { text: "A quick fox" })).items[0]?.str).toBe("A quick fox");
    expect((await edit((await make()).doc, "The quick fox", { text: "The quick foxes!" })).items[0]?.str).toBe("The quick foxes!");
    expect((await edit((await make()).doc, "The quick fox", { text: "Quick fox" })).items[0]?.str).toBe("Quick fox");
  });

  it("reports an unchanged line as unchanged and does not touch the page", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 12 Tf 72 700 Td (same) Tj ET" });
    const before = contentText(raw.doc);
    const line = lineWith(raw.doc, "same");
    const report = await applyTextEdits(raw.doc, 0, [{ lineId: line.id, text: "same" }]);
    expect(report.outcomes[0]?.status).toBe("unchanged");
    expect(report.changed).toBe(false);
    expect(contentText(raw.doc)).toBe(before);
  });

  it("refuses a line that is not on the page", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 12 Tf 72 700 Td (x) Tj ET" });
    const report = await applyTextEdits(raw.doc, 0, [{ lineId: "page#999", text: "y" }]);
    expect(report.outcomes[0]).toMatchObject({ status: "refused" });
  });

  it("keeps kerning in the parts of a TJ array that are not edited", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 20 Tf 72 700 Td [(W) 80 (ater) -60 (loo)] TJ ET" });
    const { outcome, items } = await edit(raw.doc, "Waterloo", { text: "Waterloo!" });
    expect(outcome.mode).toBe("A");
    expect(items[0]?.str).toBe("Waterloo!");
    const after = lineWith(raw.doc, "Waterloo!");
    // the untouched start still carries its original spacing numbers
    const stream = contentText(raw.doc);
    expect(stream).toMatch(/80/);
    expect(stream).toMatch(/-60/);
    expect(after.advance).toBeGreaterThan(0);
  });

  it("works on the ' and \" operators without losing the new line", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 12 Tf 14 TL 72 700 Td (first) Tj (second) ' (third) ' ET" });
    const { items } = await edit(raw.doc, "second", { text: "2nd" });
    expect(items.map((i) => i.str)).toEqual(["first", "2nd", "third"]);
    const ys = items.map((i) => Math.round(i.y));
    expect(ys).toEqual([700, 686, 672]);
  });

  it("edits rotated text along its own direction", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 14 Tf 0 1 -1 0 300 100 Tm (vertical word) Tj ET" });
    const { outcome } = await edit(raw.doc, "vertical word", { text: "upward line" });
    expect(outcome.status).toBe("applied");
    const edited = lineWith(raw.doc, "upward line");
    expect(edited.rotation).toBeCloseTo(90, 3);
    expect(edited.origin[0]).toBeCloseTo(300, 3);
    expect(edited.origin[1]).toBeCloseTo(100, 3);
  });

  it("reads hex-string text and preserves how the rest of the page is encoded", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 12 Tf 72 700 Td <48656c6c6f20776f726c64> Tj ET" });
    const { items } = await edit(raw.doc, "Hello world", { text: "Hello there" });
    expect(items[0]?.str).toBe("Hello there");
  });

  it("survives a save and reload between two edits of the same page", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 12 Tf 72 700 Td (one) Tj ET BT /F1 12 Tf 72 600 Td (two) Tj ET" });
    await edit(raw.doc, "one", { text: "uno" });
    const again = await reload(raw.doc);
    const second = await edit(again, "two", { text: "dos" });
    expect(second.items.map((i) => i.str)).toEqual(["uno", "dos"]);
  });
});

describe("existing text: characters the font cannot draw", () => {
  it("draws a Cyrillic word in a fallback font, keeps position and size, and the text stays searchable", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 24 Tf 72 700 Td (Hello World) Tj ET" });
    const { outcome, items } = await edit(raw.doc, "Hello World", { text: "Hello Мир" });
    expect(outcome).toMatchObject({ status: "applied", mode: "B", verified: true });
    expect(outcome.fallbackChars).toBe("Мир");
    expect(outcome.notes.join(" ")).toMatch(/not in this document's font/);
    expect(items.map((i) => i.str).join("")).toContain("Мир");
    expect(items.map((i) => i.str).join("")).toContain("Hello");
    expect(items[0]?.x).toBeCloseTo(72, 2);
    expect(items[0]?.y).toBeCloseTo(700, 2);
  });

  it("refuses text no built-in font can draw, instead of printing empty boxes", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 24 Tf 72 700 Td (Hello) Tj ET" });
    const before = contentText(raw.doc);
    const line = lineWith(raw.doc, "Hello");
    const report = await applyTextEdits(raw.doc, 0, [{ lineId: line.id, text: "Hello 你好" }]);
    expect(report.outcomes[0]?.status).toBe("refused");
    expect(report.outcomes[0]?.reason).toMatch(/built-in fonts/);
    expect(contentText(raw.doc)).toBe(before);
  });

  it("uses an embedded font's own codes for letters it has, and a fallback for the rest", async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(dejavu(), { subset: false });
    doc.addPage([400, 200]).drawText("Hello", { x: 20, y: 100, size: 20, font });
    const reread = await reload(doc);
    // Only the letters of "Hello" are known to be in use with this font, so "Hell" needs nothing else.
    const keepFont = await edit(reread, "Hello", { text: "Hell" });
    expect(keepFont.outcome.mode).toBe("A");
    expect(keepFont.items[0]?.str).toBe("Hell");

    const again = await reload(doc);
    const needsOther = await edit(again, "Hello", { text: "Help" });
    expect(needsOther.outcome.mode).toBe("B");
    expect(needsOther.outcome.fallbackChars).toBe("p");
    expect(needsOther.items.map((i) => i.str).join("")).toBe("Help");
  });
});

describe("existing text: lines made of several runs", () => {
  const content = "BT /F1 12 Tf 10 100 Td (Hello ) Tj /F2 12 Tf (bold) Tj /F1 12 Tf ( world) Tj ET";

  it("groups runs that continue each other into one line", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica, F2: times }, content });
    const lines = linesOf(raw.doc);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe("Hello bold world");
    expect(lines[0]?.runs).toHaveLength(3);
  });

  it("edits inside one run and leaves the others alone", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica, F2: times }, content });
    const { items } = await edit(raw.doc, "Hello bold world", { text: "Hello bold planet" });
    expect(items.map((i) => i.str).join("").replace(/\s/g, "")).toBe("Helloboldplanet");
    const stream = contentText(raw.doc);
    expect(stream).toContain("/F2 12 Tf");
  });

  it("edits across a run boundary", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica, F2: times }, content });
    const { outcome, items } = await edit(raw.doc, "Hello bold world", { text: "Hi world" });
    expect(outcome.status).toBe("applied");
    expect(items.map((i) => i.str).join("").replace(/\s/g, "")).toBe("Hiworld");
  });
});

describe("existing text: alignment and fitting", () => {
  it("keeps the right edge fixed for a right-aligned line", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 14 Tf 400 100 Td (Total) Tj ET" });
    const line = lineWith(raw.doc, "Total");
    const rightBefore = line.origin[0] + line.advance * line.scale;
    const { outcome } = await edit(raw.doc, "Total", { text: "Grand total", style: { align: "right" } });
    expect(outcome.status).toBe("applied");
    const edited = lineWith(raw.doc, "Grand total");
    expect(edited.origin[0] + edited.advance * edited.scale).toBeCloseTo(rightBefore, 1);
    expect(edited.origin[0]).toBeLessThan(400);
  });

  it("keeps the centre fixed for a centred line", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 14 Tf 250 100 Td (Title) Tj ET" });
    const line = lineWith(raw.doc, "Title");
    const centre = line.origin[0] + (line.advance * line.scale) / 2;
    await edit(raw.doc, "Title", { text: "A much longer title", style: { align: "center" } });
    const edited = lineWith(raw.doc, "A much longer title");
    expect(edited.origin[0] + (edited.advance * edited.scale) / 2).toBeCloseTo(centre, 1);
  });

  it("condenses a longer line back to its original width when asked", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 14 Tf 72 100 Td (Short) Tj ET" });
    const original = lineWith(raw.doc, "Short").advance;
    const { outcome } = await edit(raw.doc, "Short", { text: "Much longer text", fit: "condense" });
    expect(outcome.notes.join(" ")).toMatch(/condensed/);
    const edited = lineWith(raw.doc, "Much longer text");
    // Tz scales the text; the reading of the line includes it
    expect(edited.runs[0]?.hScale).toBeLessThan(1);
    expect(edited.advance).toBeCloseTo(original, 1);
    // and the state is put back for what follows
    expect(contentText(raw.doc)).toMatch(/100 Tz/);
  });

  it("shrinks the type instead, for a single-font line", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 14 Tf 72 100 Td (Short) Tj ET" });
    const original = lineWith(raw.doc, "Short").advance;
    await edit(raw.doc, "Short", { text: "Much longer text", fit: "shrink" });
    const edited = lineWith(raw.doc, "Much longer text");
    expect(edited.runs[0]?.fontSize).toBeLessThan(14);
    expect(edited.advance).toBeCloseTo(original, 1);
  });

  it("warns when the longer line would run into the next text on the same baseline", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 12 Tf 72 100 Td (Name) Tj ET BT /F1 12 Tf 130 100 Td (Next column) Tj ET" });
    const { outcome } = await edit(raw.doc, "Name", { text: "A very long name indeed" });
    expect(outcome.status).toBe("applied");
    expect(outcome.warnings.join(" ")).toMatch(/overlap/);
  });

  it("warns when it would run off the page", async () => {
    const raw = await rawPdf({ size: [200, 200], fonts: { F1: helvetica }, content: "BT /F1 12 Tf 120 100 Td (End) Tj ET" });
    const { outcome } = await edit(raw.doc, "End", { text: "End of a very long sentence" });
    expect(outcome.warnings.join(" ")).toMatch(/edge of the page/);
  });
});

describe("existing text: changing the font", () => {
  it("rebuilds the line in a bold fallback when bold is switched on", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 14 Tf 72 100 Td (Make me bold) Tj ET" });
    const { outcome, items } = await edit(raw.doc, "Make me bold", { text: "Make me bold", style: { bold: true } });
    expect(outcome.mode).toBe("B");
    expect(items[0]?.str).toBe("Make me bold");
    const edited = lineWith(raw.doc, "Make me bold");
    expect(edited.runs.some((r) => r.font.bold)).toBe(true);
    expect(edited.origin[0]).toBeCloseTo(72, 3);
  });
});

describe("existing text: what is refused, and why", () => {
  it("refuses invisible text (a scan's hidden OCR layer)", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 12 Tf 3 Tr 72 700 Td (hidden words) Tj ET" });
    const line = lineWith(raw.doc, "hidden words");
    const report = await applyTextEdits(raw.doc, 0, [{ lineId: line.id, text: "other words" }]);
    expect(report.outcomes[0]).toMatchObject({ status: "refused" });
    expect(report.outcomes[0]?.reason).toMatch(/invisible/);
  });

  it("refuses text with an ActualText replacement", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 12 Tf 72 700 Td /Span <</ActualText (Fi)>> BDC (Fi) Tj EMC ET" });
    const line = lineWith(raw.doc, "Fi");
    const report = await applyTextEdits(raw.doc, 0, [{ lineId: line.id, text: "Fo" }]);
    expect(report.outcomes[0]?.reason).toMatch(/ActualText/);
  });

  it("refuses Type 3 fonts", async () => {
    const raw = await rawPdf({
      fonts: { F3: { Type: "Font", Subtype: "Type3", FontBBox: [0, 0, 1000, 1000], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], CharProcs: {}, Encoding: { Type: "Encoding", Differences: [97, "a"] }, FirstChar: 97, LastChar: 97, Widths: [500] } },
      content: "BT /F3 12 Tf 72 700 Td (a) Tj ET",
    });
    const lines = linesOf(raw.doc);
    expect(lines).toHaveLength(1);
    const report = await applyTextEdits(raw.doc, 0, [{ lineId: (lines[0] as TextLine).id, text: "b" }]);
    expect(report.outcomes[0]).toMatchObject({ status: "refused" });
    expect(report.outcomes[0]?.reason).toMatch(/Type 3/);
  });

  it("refuses text in a form that the page draws twice, unless allowed", async () => {
    const raw = await rawPdf({
      fonts: { F1: helvetica },
      content: "q 1 0 0 1 0 0 cm /Fm1 Do Q q 1 0 0 1 0 100 cm /Fm1 Do Q",
      setup: ({ doc, resources }) => {
        const form = doc.context.flateStream("BT /F1 10 Tf 5 5 Td (repeated) Tj ET", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 50], Resources: { Font: { F1: doc.context.obj({ ...helvetica }) } } });
        resources.set(PDFName.of("XObject"), doc.context.obj({ Fm1: doc.context.register(form) }));
      },
    });
    const lines = linesOf(raw.doc);
    expect(lines.length).toBeGreaterThan(0);
    const report = await applyTextEdits(raw.doc, 0, [{ lineId: (lines[0] as TextLine).id, text: "changed" }]);
    expect(report.outcomes[0]?.status).toBe("refused");
    expect(report.outcomes[0]?.reason).toMatch(/draws .* times/);
  });

  it("edits text in a form drawn once, for this page only", async () => {
    const raw = await rawPdf({
      fonts: { F1: helvetica },
      content: "/Fm1 Do",
      setup: ({ doc, resources }) => {
        const form = doc.context.flateStream("BT /F1 10 Tf 5 5 Td (in a form) Tj ET", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 50], Resources: { Font: { F1: doc.context.obj({ ...helvetica }) } } });
        resources.set(PDFName.of("XObject"), doc.context.obj({ Fm1: doc.context.register(form) }));
      },
    });
    const line = linesOf(raw.doc)[0] as TextLine;
    const report = await applyTextEdits(raw.doc, 0, [{ lineId: line.id, text: "edited form" }]);
    expect(report.outcomes[0]).toMatchObject({ status: "applied", verified: true });
    expect(linesOf(raw.doc).map((l) => l.text)).toEqual(["edited form"]);
  });
});
