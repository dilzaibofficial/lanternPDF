import { PDFDocument } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { engineContext, ensureScanned } from "../../../src/lib/pdf/engine/context";
import { interpret } from "../../../src/lib/pdf/engine/interpret";
import { type TextLine, buildLines } from "../../../src/lib/pdf/engine/lines";
import { IDENTITY } from "../../../src/lib/pdf/engine/matrix";
import { pruneUnreachable } from "../../../src/lib/pdf/engine/prune";
import { readPageContent } from "../../../src/lib/pdf/engine/streams";
import { type LineEditRequest, applyTextEdits } from "../../../src/lib/pdf/engine/textEdit";
import { fixtureBytes, hasFixture } from "../../fixtures/build";
import { type Region, difference, expectEditedOnlyIn, rasterize, regionOf, unionRegion } from "../helpers/visual";

/**
 * Visual regression: render the page before and after an edit with pdf.js, and require that nothing changed
 * except where the edited line was or now is. The unedited rest of the page must be pixel-identical.
 */

function linesOf(doc: PDFDocument): TextLine[] {
  const context = engineContext(doc);
  ensureScanned(context);
  return buildLines(interpret(doc, readPageContent(doc, doc.getPage(0)), IDENTITY, context.fonts, {}, { formSources: context.formSources }).runs);
}

async function visualEdit(fixture: string, lineText: string, request: Omit<LineEditRequest, "lineId">, name: string) {
  const doc = await PDFDocument.load(fixtureBytes(fixture));
  const original = await doc.save();
  const line = linesOf(doc).find((l) => l.text === lineText);
  if (!line) throw new Error(`no line “${lineText}”`);
  const before = await rasterize(original);
  const report = await applyTextEdits(doc, 0, [{ lineId: line.id, ...request }]);
  const outcome = report.outcomes[0];
  expect(outcome?.status, outcome?.reason).toBe("applied");
  pruneUnreachable(doc);
  const after = await rasterize(await doc.save());
  const region: Region = unionRegion(regionOf(before, line.box, 4), regionOf(before, outcome?.box ?? line.box, 4));
  // The tail of a longer or shorter line moves, so widen the region along the baseline by the width change.
  const widened = { ...region, x1: Math.min(before.width, Math.max(region.x1, region.x0 + Math.ceil(((outcome?.widthAfter ?? 0) + 8) * before.scale))) };
  expectEditedOnlyIn(name, before, after, [widened]);
  return { before, after, region: widened, outcome };
}

describe("the harness", () => {
  it("renders the same bytes identically twice", async () => {
    const bytes = fixtureBytes("pdfkit-standard.pdf");
    const a = await rasterize(bytes);
    const b = await rasterize(bytes);
    expect(difference(a, b).changed).toBe(0);
  });

  it("notices a change that is outside the region it was told about", async () => {
    const doc = await PDFDocument.load(fixtureBytes("pdfkit-standard.pdf"));
    const before = await rasterize(await doc.save());
    const a = linesOf(doc).find((l) => l.text === "Annual Report") as TextLine;
    const b = linesOf(doc).find((l) => l.text === "Costs       388,500") as TextLine;
    await applyTextEdits(doc, 0, [{ lineId: a.id, text: "Annual Reports" }]);
    const after = await rasterize(await doc.save());
    expect(() => expectEditedOnlyIn("negative-control", before, after, [regionOf(before, b.box)])).toThrow(/pixels changed outside/);
  });
});

describe("pdfkit: nothing outside the edited line changes", () => {
  it("replacing a word in a heading", async () => {
    await visualEdit("pdfkit-standard.pdf", "Annual Report", { text: "Annual Summary" }, "pdfkit heading word");
  });

  it("deleting characters from monospaced text", async () => {
    await visualEdit("pdfkit-standard.pdf", "Revenue   1,204,000", { text: "Revenue   1,204" }, "pdfkit mono delete");
  });

  it("changing one word of a justified line, with the other word gaps kept", async () => {
    const doc = await PDFDocument.load(fixtureBytes("pdfkit-standard.pdf"));
    const line = linesOf(doc).find((l) => l.text.startsWith("keeping costs")) as TextLine;
    await visualEdit("pdfkit-standard.pdf", line.text, { text: line.text.replace("costs", "spend") }, "pdfkit justified word");
  });

  it("a longer right-aligned line grows to the left", async () => {
    await visualEdit("pdfkit-standard.pdf", "Right aligned total: 815,500", { text: "Right aligned total: 1,815,500", style: { align: "right" } }, "pdfkit right aligned");
  });
});

describe("pdf-lib: nothing outside the edited line changes", () => {
  it("replacing a word in a heading", async () => {
    await visualEdit("pdflib-standard.pdf", "Hello World", { text: "Hello There" }, "pdflib heading");
  });

  it("drawing a character the font lacks in a fallback", async () => {
    const { outcome } = await visualEdit("pdflib-standard.pdf", "Hello World", { text: "Hello Мир" }, "pdflib fallback");
    expect(outcome?.mode).toBe("B");
  });
});

describe.skipIf(!hasFixture("chromium-article.pdf"))("Chromium: nothing outside the edited line changes", () => {
  it("deleting letters from the title", async () => {
    await visualEdit("chromium-article.pdf", "Quarterly Report", { text: "Quarterly Repo" }, "chromium title delete");
  });

  it("a replacement needing a letter the subset lacks", async () => {
    await visualEdit("chromium-article.pdf", "Quarterly Report", { text: "Quarterly Results" }, "chromium title fallback");
  });

  it("editing a table cell", async () => {
    await visualEdit("chromium-article.pdf", "$129.50", { text: "$130.00" }, "chromium table cell");
  });

  it("editing the rotated note", async () => {
    // Rotated text: the region test is on the axis-aligned box, which still contains the edited text.
    await visualEdit("chromium-article.pdf", "Rotated margin note", { text: "Rotated margin notes" }, "chromium rotated note");
  });

  it("editing a word in the middle of a paragraph line", async () => {
    const full = "The company grew steadily during the year and expanded into three new markets while keeping";
    await visualEdit("chromium-article.pdf", full, { text: full.replace("steadily", "slowly") }, "chromium paragraph word");
  });
});
