import { PDFDocument } from "@cantoo/pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { EngineSession } from "../../../src/lib/pdf/engine/session";
import { fixtureBytes, hasFixture } from "../../fixtures/build";
import { rawPdf, helvetica } from "../helpers/rawPdf";

const open = (name: string) => EngineSession.open({ name, bytes: fixtureBytes(name) });

async function items(bytes: Uint8Array) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    return content.items.filter((i) => "str" in i && i.str.trim() !== "").map((i) => {
      const it = i as { str: string; transform: number[]; width: number };
      return { str: it.str, x: it.transform[4] as number, y: it.transform[5] as number, width: it.width };
    });
  } finally {
    await task.destroy();
  }
}

describe("EngineSession: analysing pages", () => {
  it("describes the document and its pages", async () => {
    const session = await open("pdflib-rotated.pdf");
    expect(session.info()).toMatchObject({ pageCount: 1, signed: false });
    // a CropBox of 380x260 and a 90 degree rotation: shown as 260 wide and 380 tall
    expect(session.info().sizes[0]).toEqual({ width: 260, height: 380, rotation: 90 });
  });

  it("gives line boxes in display space (top-left origin, y down) that match where pdf.js puts the text", async () => {
    const session = await open("pdfkit-standard.pdf");
    const analysis = session.analyze(0);
    const title = analysis.lines.find((l) => l.text === "Annual Report");
    expect(title).toBeDefined();
    expect(analysis.width).toBeCloseTo(595.28, 1);
    // pdf.js reports the baseline origin in PDF user space; the display baseline is H - y
    const reference = (await items(fixtureBytes("pdfkit-standard.pdf"))).find((i) => i.str === "Annual Report");
    expect(title?.origin.x).toBeCloseTo(reference?.x ?? Number.NaN, 1);
    expect(title?.origin.y).toBeCloseTo(analysis.height - (reference?.y ?? Number.NaN), 1);
    expect(title?.box.y).toBeLessThan(title?.origin.y ?? 0);
    expect(title?.size).toBeCloseTo(24, 3);
    expect(title?.angle).toBeCloseTo(0, 3);
  });

  it("maps lines on a rotated, cropped page into the page as displayed", async () => {
    const session = await open("pdflib-rotated.pdf");
    const analysis = session.analyze(0);
    const line = analysis.lines.find((l) => l.text === "Lower left text");
    expect(line).toBeDefined();
    // inside the displayed page
    expect(line?.box.x).toBeGreaterThanOrEqual(-1);
    expect(line?.box.y).toBeGreaterThanOrEqual(-1);
    expect((line?.box.x ?? 0) + (line?.box.width ?? 0)).toBeLessThanOrEqual(analysis.width + 1);
    expect((line?.box.y ?? 0) + (line?.box.height ?? 0)).toBeLessThanOrEqual(analysis.height + 1);
    // the page is turned a quarter, so text that ran left to right now runs top to bottom
    expect(Math.abs(Math.abs(line?.angle ?? 0) - 90)).toBeLessThan(1);
  });

  it("guesses alignment from the page: centred, right-aligned and left", async () => {
    const session = await open("pdfkit-standard.pdf");
    const align = (text: string) => session.analyze(0).lines.find((l) => l.text === text)?.align;
    expect(align("Fiscal year 2026")).toBe("center");
    expect(align("Right aligned total: 815,500")).toBe("right");
    expect(align("Annual Report")).toBe("left");
    expect(align("Revenue   1,204,000")).toBe("left");
  });

  it.skipIf(!hasFixture("chromium-article.pdf"))("guesses alignment on a Chromium page", async () => {
    const session = await open("chromium-article.pdf");
    const lines = session.analyze(0).lines;
    expect(lines.find((l) => l.text === "Fiscal year 2026 — Confidential draft")?.align).toBe("center");
    expect(lines.find((l) => l.text === "Prepared by Finance — page one")?.align).toBe("right");
    expect(lines.find((l) => l.text === "Quarterly Report")?.align).toBe("left");
  });

  it("reports editability and the reason when a line cannot be edited", async () => {
    const raw = await rawPdf({ fonts: { F1: helvetica }, content: "BT /F1 12 Tf 72 700 Td (visible) Tj ET BT /F1 12 Tf 3 Tr 72 600 Td (hidden layer) Tj ET" });
    const session = await EngineSession.open({ name: "x.pdf", bytes: await raw.doc.save() });
    const lines = session.analyze(0).lines;
    expect(lines.find((l) => l.text === "visible")?.verdict).toBe("A");
    const hidden = lines.find((l) => l.text === "hidden layer");
    expect(hidden?.verdict).toBe("C");
    expect(hidden?.reason).toMatch(/invisible/);
  });

  it("lists the characters the line's font can draw, so the editor can flag letters that need a fallback", async () => {
    const session = await open("pdfkit-embedded.pdf");
    const line = session.analyze(0).lines.find((l) => l.text.startsWith("The quick brown fox"));
    expect(line?.availableChars).toContain("q");
    expect(line?.availableChars).not.toContain("§");
  });

  it("finds images, links and annotations", async () => {
    const session = await open("pdfkit-standard.pdf");
    const analysis = session.analyze(0);
    expect(analysis.links.some((l) => l.uri === "https://example.com/")).toBe(true);
    const scan = await open("scan.pdf");
    expect(scan.analyze(0).objects.filter((o) => o.kind === "image")).toHaveLength(1);
    expect(scan.analyze(0).lines).toHaveLength(0);
  });

  it("gives per-character offsets that line up with the text", async () => {
    const session = await open("pdfkit-standard.pdf");
    const line = session.analyze(0).lines.find((l) => l.text === "Annual Report");
    expect(line?.charOffsets).toHaveLength(Array.from("Annual Report").length + 1);
    expect(line?.charOffsets[0]).toBe(0);
    expect(line?.charOffsets.at(-1)).toBeCloseTo(line?.length ?? 0, 2);
    const offsets = line?.charOffsets ?? [];
    for (let i = 1; i < offsets.length; i += 1) expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1] as number);
  });

  it("warns about a signed document", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    // a signature field with a value
    const signature = doc.context.obj({ FT: "Sig", T: "sig", V: { Type: "Sig", Filter: "Adobe.PPKLite", ByteRange: [0, 0, 0, 0] } });
    const ref = doc.context.register(signature);
    const form = doc.context.obj({ Fields: [ref] });
    doc.catalog.set((await import("@cantoo/pdf-lib")).PDFName.of("AcroForm"), form);
    const session = await EngineSession.open({ name: "signed.pdf", bytes: await doc.save() });
    expect(session.signed).toBe(true);
    expect(session.analyze(0).warnings.join(" ")).toMatch(/digitally signed/);
  });
});

describe("EngineSession: deriving a page with edits", () => {
  it("returns a one-page PDF with the edit applied and leaves the source untouched", async () => {
    const session = await open("pdfkit-standard.pdf");
    const line = session.analyze(0).lines.find((l) => l.text === "Annual Report");
    const { bytes, report } = await session.derivePage(0, [{ lineId: line?.id ?? "", text: "Annual Summary" }]);
    expect(report?.outcomes[0]).toMatchObject({ status: "applied", verified: true });
    const derived = await items(bytes);
    expect(derived.map((i) => i.str).join(" ")).toContain("Annual Summary");
    // the source session still reads the original text
    const again = new Map(session.analyze(0).lines.map((l) => [l.text, l]));
    expect(again.has("Annual Report")).toBe(true);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it("uses what the whole document knows about a font: a letter used elsewhere is not a fallback", async () => {
    const session = await open("pdfkit-embedded.pdf");
    // "p" appears in "jumps"/"Embedded"; the first line "Embedded font sample" uses a subset font shared by the page
    const line = session.analyze(0).lines.find((l) => l.text === "Embedded font sample");
    expect(line).toBeDefined();
    const { report } = await session.derivePage(0, [{ lineId: line?.id ?? "", text: "Embedded font simple" }]);
    expect(report?.outcomes[0]?.status).toBe("applied");
    expect(report?.outcomes[0]?.mode).toBe("A");
  });

  it("returns an unedited copy when there are no edits", async () => {
    const session = await open("pdflib-standard.pdf");
    const { bytes, report } = await session.derivePage(0, []);
    expect(report).toBeNull();
    expect((await items(bytes)).map((i) => i.str)).toContain("Hello World");
  });

  it("refuses a page that does not exist", async () => {
    const session = await open("pdflib-standard.pdf");
    expect(() => session.analyze(5)).toThrow(/does not exist/);
    await expect(session.derivePage(-1, [])).rejects.toThrow(/does not exist/);
  });
});
