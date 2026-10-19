import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { type ConvertContext, type PageRenderer, checkOfficeFile, pdfToDocx, pdfToPptx, pdfToXlsx } from "../../src/lib/convert/convert";
import { AppError } from "../../src/lib/errors";
import { A4, docx, docxParagraphs, fontsOf, makeReport, makeScan, makeTable, makeTwoColumns, nonEmpty, put, sheetsOf, textOf, unzip } from "./helpers/documents";
import { makeImage } from "./helpers/images";

// ---- helpers -----------------------------------------------------------------------------------------------

async function withPdf<T>(bytes: Uint8Array, work: (doc: PDFDocumentProxy) => Promise<T>): Promise<T> {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  try {
    return await work((await task.promise) as unknown as PDFDocumentProxy);
  } finally {
    await task.destroy();
  }
}

const progress = (): { ctx: ConvertContext; seen: number[] } => {
  const seen: number[] = [];
  return { seen, ctx: { onProgress: (fraction) => seen.push(fraction) } };
};

async function expectAppError(promise: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    if (message) expect((error as AppError).message).toMatch(message);
    return;
  }
  throw new Error(`expected AppError ${code}`);
}

// ---- Word -----------------------------------------------------------------------------------------------------

describe("PDF to Word", () => {
  it("rebuilds headings, centred lines, paragraphs, bullets and pages from a report", async () => {
    const { ctx, seen } = progress();
    const result = await withPdf(await makeReport(), (doc) => pdfToDocx(doc, "report.pdf", ctx));
    expect(result.file.name).toBe("report.docx");
    expect(result.file.mime).toContain("wordprocessingml");
    expect(result.pages).toBe(2);
    expect(seen.at(-1)).toBe(1);

    const paragraphs = docxParagraphs(result.file.bytes);
    const texts = nonEmpty(paragraphs);
    expect(texts[0]).toBe("Annual Report");
    expect(paragraphs.find((p) => p.text === "Annual Report")?.xml).toContain('w:val="Heading1"');
    expect(paragraphs.find((p) => p.text === "Fiscal year 2025")?.xml).toContain('<w:jc w:val="center"/>');
    expect(paragraphs.find((p) => p.text === "Overview")?.xml).toMatch(/Heading2/); // the next size down is a level-2 heading
    // the three lines of the paragraph are one paragraph, in order
    expect(texts).toContain("The company grew steadily during the year and expanded into three new markets while keeping costs under control. Customer satisfaction reached an all-time high in the autumn survey.");
    expect(texts).toContain("Revenue up 12%");
    expect(texts).toContain("Costs down 3%");
    expect(paragraphs.find((p) => p.text === "Revenue up 12%")?.xml).toContain("<w:numPr>");
    expect(texts).toContain("Looking ahead, we expect the trend to continue into the next period.");
    // the second PDF page starts on a new page
    expect(paragraphs.find((p) => p.text === "Details")?.xml).toContain("w:pageBreakBefore");
    expect(texts).toContain("Second page text goes here with some more words in the line.");
    // bold text stays bold
    expect(paragraphs.find((p) => p.text === "Annual Report")?.xml).toContain("<w:b/>");
  });

  it("sizes the Word page like the PDF page", async () => {
    const result = await withPdf(await makeReport(), (doc) => pdfToDocx(doc, "report.pdf"));
    const xml = textOf(unzip(result.file.bytes)["word/document.xml"]);
    expect(xml).toContain('w:w="11900"'); // 595 pt
    expect(xml).toContain('w:h="16840"'); // 842 pt
  });

  it("reads two columns one after the other, not line by line across", async () => {
    const result = await withPdf(await makeTwoColumns(), (doc) => pdfToDocx(doc, "article.pdf"));
    const joined = nonEmpty(docxParagraphs(result.file.bytes)).join("\n");
    expect(joined.indexOf("A Two Column Article Title")).toBeLessThan(joined.indexOf("Left column sentence number 1"));
    expect(joined.indexOf("Left column sentence number 8")).toBeLessThan(joined.indexOf("Right column sentence number 1"));
    expect(joined).not.toMatch(/Left column sentence number 1 flows\s+Right column/); // never joined across
  });

  it("turns a table into a real Word table with the right cells", async () => {
    const result = await withPdf(await makeTable(), (doc) => pdfToDocx(doc, "prices.pdf"));
    const xml = textOf(unzip(result.file.bytes)["word/document.xml"]);
    expect(xml).toContain("<w:tbl>");
    expect((xml.match(/<w:gridCol /g) ?? []).length).toBe(3);
    const cells = nonEmpty(docxParagraphs(result.file.bytes));
    for (const expected of ["Item", "Qty", "Price", "Widget", "Gadget with a long name", "1,200", "$129.50", "Prices exclude tax."]) expect(cells).toContain(expected);
    expect(result.notes.join(" ")).toMatch(/1 table was detected/);
  });

  it("refuses a PDF that has no text, and says why", async () => {
    await expectAppError(withPdf(await makeScan(), (doc) => pdfToDocx(doc, "scan.pdf")), "UNSUPPORTED", /no text that can be read.*OCR/s);
  });

  it("reports pages without text and text it could not place", async () => {
    const doc = await PDFDocument.create();
    const f = await fontsOf(doc);
    const one = doc.addPage(A4);
    put(one, "First page has words on it that can be read normally.", 72, 100, 12, f.regular);
    put(one, "Sideways text", 40, 600, 12, f.regular, 90);
    doc.addPage(A4); // blank
    const three = doc.addPage(A4);
    put(three, "Third page has words too, and they are found as well.", 72, 100, 12, f.regular);
    const result = await withPdf(await doc.save(), (d) => pdfToDocx(d, "mixed.pdf"));
    expect(result.notes.join(" ")).toMatch(/Page 2 has no text/);
    expect(result.notes.join(" ")).toMatch(/1 piece of vertical or diagonal text .* left out/);
    const paragraphs = docxParagraphs(result.file.bytes);
    expect(nonEmpty(paragraphs).join(" ")).not.toContain("Sideways");
    expect(paragraphs.filter((p) => p.xml.includes("w:pageBreakBefore")).length).toBe(2); // the blank page still gets its page
  });

  it("can be cancelled between pages", async () => {
    const controller = new AbortController();
    controller.abort();
    await expectAppError(withPdf(await makeReport(), (doc) => pdfToDocx(doc, "r.pdf", { signal: controller.signal })), "CANCELLED");
  });

  it("writes XML that Word can open: no forbidden control characters", async () => {
    const doc = await PDFDocument.create();
    doc.addPage(A4).drawText("Plain ASCII line that is long enough to count as text.", { x: 72, y: 700, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
    const result = await withPdf(await doc.save(), (d) => pdfToDocx(d, "plain.pdf"));
    const xml = textOf(unzip(result.file.bytes)["word/document.xml"]);
    const forbidden = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(0xb, 0xc)}${String.fromCharCode(0xe)}-${String.fromCharCode(0x1f)}]`);
    expect(forbidden.test(xml)).toBe(false);
    expect(xml).toContain("Plain ASCII line");
  });
});

// ---- Excel ----------------------------------------------------------------------------------------------------

describe("PDF to Excel", () => {
  it("finds the table, keeps its cells, and reads clear numbers as numbers", async () => {
    const result = await withPdf(await makeTable(), (doc) => pdfToXlsx(doc, "prices.pdf", { layout: "per-page", numbers: true }));
    expect(result.file.name).toBe("prices.xlsx");
    const [sheet] = await sheetsOf(result.file.bytes);
    expect(sheet?.name).toBe("Page 1");
    const rows = sheet?.rows ?? [];
    expect(rows[0]).toEqual(["Price list", null, null]);
    expect(rows.slice(1, 6)).toEqual([
      ["Item", "Qty", "Price"],
      ["Widget", 4, 9.99],
      ["Gadget with a long name", 1200, 129.5],
      ["Gizmo", 12, 0.12],
      ["Part 007", 3, -250],
    ]);
    expect(sheet?.numFmt(4, 2)).toBe("#,##0"); // 1,200 in the Gadget row
    expect(sheet?.numFmt(4, 3)).toBe("$#,##0.00"); // $129.50
    expect(sheet?.numFmt(5, 3)).toBe("0%"); // 12% in the Gizmo row
    expect(rows[6]?.[0]).toBe("Prices exclude tax.");
    expect(result.notes.join(" ")).toMatch(/1 table was found/);
    expect(result.notes.join(" ")).toMatch(/clearly numbers/);
  });

  it("keeps everything as text when asked, so nothing is reinterpreted", async () => {
    const result = await withPdf(await makeTable(), (doc) => pdfToXlsx(doc, "prices.pdf", { layout: "per-page", numbers: false }));
    const [sheet] = await sheetsOf(result.file.bytes);
    expect(sheet?.rows.slice(1, 4)).toEqual([
      ["Item", "Qty", "Price"],
      ["Widget", "4", "$9.99"],
      ["Gadget with a long name", "1,200", "$129.50"],
    ]);
  });

  it("makes one sheet per page, or one sheet for everything", async () => {
    const report = await makeReport();
    const perPage = await sheetsOf((await withPdf(report, (doc) => pdfToXlsx(doc, "r.pdf", { layout: "per-page", numbers: true }))).file.bytes);
    expect(perPage.map((sheet) => sheet.name)).toEqual(["Page 1", "Page 2"]);
    const single = await sheetsOf((await withPdf(report, (doc) => pdfToXlsx(doc, "r.pdf", { layout: "single", numbers: true }))).file.bytes);
    expect(single).toHaveLength(1);
    expect(single[0]?.name).toBe("r");
    const column = single[0]?.rows.map((row) => row[0]) ?? [];
    expect(column).toContain("Annual Report");
    expect(column).toContain("Details");
    expect(column.indexOf("Annual Report")).toBeLessThan(column.indexOf("Details"));
    expect(column).toContain(null); // a blank row separates the pages
  });

  it("explains when there are no tables, and refuses scans", async () => {
    const result = await withPdf(await makeReport(), (doc) => pdfToXlsx(doc, "r.pdf", { layout: "per-page", numbers: true }));
    expect(result.notes.join(" ")).toMatch(/No tables were found/);
    await expectAppError(withPdf(await makeScan(), (doc) => pdfToXlsx(doc, "scan.pdf", { layout: "per-page", numbers: true })), "UNSUPPORTED", /no text that can be read/);
  });
});

// ---- PowerPoint -----------------------------------------------------------------------------------------------

describe("PDF to PowerPoint", () => {
  /** Stands in for the browser's canvas renderer: a small picture of the right shape for each page. */
  const renderer = (doc: PDFDocumentProxy): PageRenderer => async (number) => {
    const page = await doc.getPage(number);
    const view = page.getViewport({ scale: 1 });
    return { jpeg: makeImage("jpeg", 200, Math.round((200 * view.height) / view.width)), width: view.width, height: view.height };
  };

  it("makes one slide per page, sized like the page, with the page's text in the notes", async () => {
    const { ctx, seen } = progress();
    const result = await withPdf(await makeReport(), (doc) => pdfToPptx(doc, "report.pdf", renderer(doc), ctx));
    expect(result.file.name).toBe("report.pptx");
    expect(result.file.mime).toContain("presentationml");
    expect(result.pages).toBe(2);
    expect(seen.at(-1)).toBe(1);

    const entries = unzip(result.file.bytes);
    expect(Object.keys(entries).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(2);
    expect(Object.keys(entries).filter((name) => /^ppt\/media\/[^/]+\.jpe?g$/i.test(name))).toHaveLength(2); // a picture per slide
    const presentation = textOf(entries["ppt/presentation.xml"]);
    expect(presentation).toContain(`cx="${Math.round((595 / 72) * 914400)}"`); // slide width = page width
    const notes = Object.entries(entries)
      .filter(([name]) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))
      .map(([, bytes]) => textOf(bytes))
      .join(" ");
    expect(notes).toContain("Annual Report");
    expect(notes).toContain("Second page text goes here");
  });

  it("works on a scan: the slides are the pictures, and there is no text to put in notes", async () => {
    const result = await withPdf(await makeScan(), (doc) => pdfToPptx(doc, "scan.pdf", renderer(doc)));
    expect(result.pages).toBe(1);
    expect(Object.keys(unzip(result.file.bytes)).some((name) => /^ppt\/slides\/slide1\.xml$/.test(name))).toBe(true);
  });

  it("stops when cancelled, and reports a renderer that fails", async () => {
    const controller = new AbortController();
    controller.abort();
    await expectAppError(withPdf(await makeReport(), (doc) => pdfToPptx(doc, "r.pdf", renderer(doc), { signal: controller.signal })), "CANCELLED");
    const failing: PageRenderer = async () => {
      throw new AppError("ENGINE_FAILED", "The page could not be drawn.");
    };
    await expectAppError(withPdf(await makeReport(), (doc) => pdfToPptx(doc, "r.pdf", failing)), "ENGINE_FAILED", /could not be drawn/);
  });
});

// ---- checking files that come from the server ------------------------------------------------------------------

describe("checkOfficeFile", () => {
  it("accepts what has the parts of its type, and rejects the rest", async () => {
    const real = (await withPdf(await makeReport(), (doc) => pdfToDocx(doc, "r.pdf"))).file.bytes;
    expect(() => checkOfficeFile(real, "docx", "r.pdf")).not.toThrow();
    expect(() => checkOfficeFile(real, "pptx", "r.pdf")).toThrow(/incomplete/); // a Word file is not a presentation
    expect(() => checkOfficeFile(new Uint8Array(10), "docx", "r.pdf")).toThrow(/empty/);
    expect(() => checkOfficeFile(new TextEncoder().encode("x".repeat(200)), "docx", "r.pdf")).toThrow(/could not be opened again/);
    expect(() => checkOfficeFile(docx("hello"), "docx", "r.pdf")).not.toThrow(); // the test fixture has the parts
  });
});
