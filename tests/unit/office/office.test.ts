import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { AppError } from "../../../src/lib/errors";
import { convertOfficeFile, officeKindOf } from "../../../src/lib/office";
import { parseXml } from "../../../src/lib/office/xml";
import { parseCsv } from "../../../src/lib/office/xlsx/convert";
import { renderPdfPage } from "../helpers/images";
import { type ColorContext, parseColor } from "../../../src/lib/office/pptx/dml";
import { formatNumber } from "../../../src/lib/office/pptx/text";
import { makeDeck, makeWordDocument, makeWorkbook } from "../helpers/officeDocs";
import { pageTexts } from "../helpers/pdf";

async function annotationsOf(bytes: Uint8Array): Promise<{ subtype: string; url?: string }[]> {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  try {
    const doc = await task.promise;
    const found: { subtype: string; url?: string }[] = [];
    for (let i = 1; i <= doc.numPages; i += 1) for (const a of await (await doc.getPage(i)).getAnnotations()) found.push({ subtype: a.subtype, url: a.url });
    return found;
  } finally {
    await task.destroy();
  }
}

async function metadataOf(bytes: Uint8Array): Promise<{ Title?: string; Author?: string }> {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  try {
    const doc = await task.promise;
    return ((await doc.getMetadata()).info ?? {}) as { Title?: string; Author?: string };
  } finally {
    await task.destroy();
  }
}

describe("the XML reader", () => {
  it("reads elements, attributes, entities, CDATA and self-closing tags", () => {
    const root = parseXml(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "boom">]><r a="1 &amp; 2" b='x'><c/><d>&lt;t&gt; &#65;&#x42;<![CDATA[<raw>]]></d><!-- note --></r>`);
    expect(root.name).toBe("r");
    expect(root.attrs).toEqual({ a: "1 & 2", b: "x" });
    const d = root.children.find((child) => typeof child !== "string" && child.name === "d");
    expect(typeof d === "object" && d !== undefined && "children" in d ? d.children.join("") : "").toBe("<t> AB<raw>");
  });

  it("does not expand entities a document defines for itself", () => {
    const root = parseXml(`<!DOCTYPE x [<!ENTITY a "boom">]><r>&a;</r>`);
    expect(root.children).toEqual(["&a;"]);
  });

  it("refuses broken markup instead of guessing", () => {
    expect(() => parseXml("<a><b></a>")).toThrow();
    expect(() => parseXml("<a")).toThrow();
    expect(() => parseXml("")).toThrow();
  });
});

describe("choosing a converter", () => {
  it("knows the Office file types by extension", () => {
    expect(officeKindOf("Report.DOCX")).toBe("docx");
    expect(officeKindOf("books.xlsx")).toBe("xlsx");
    expect(officeKindOf("data.csv")).toBe("csv");
    expect(officeKindOf("Deck.PPTX")).toBe("pptx");
    expect(officeKindOf("old.doc")).toBeNull();
  });
});

describe("Word to PDF", () => {
  it("keeps the text, the list, the table, the header and footer with page numbers, the link and the picture", async () => {
    const result = await convertOfficeFile("summary.docx", await makeWordDocument());
    expect(result.pageCount).toBe(1);
    expect(result.warnings).toEqual([]);
    const [text] = await pageTexts(result.bytes);
    expect(text).toContain("Annual summary");
    expect(text).toContain("Plain, bold and italic text.");
    expect(text).toContain("1.");
    expect(text).toContain("First point");
    expect(text).toContain("Second point");
    expect(text).toContain("Region");
    expect(text).toContain("1,200");
    expect(text).toContain("Confidential header");
    expect(text).toContain("Page 1 of 1");
    expect((await annotationsOf(result.bytes)).some((a) => a.subtype === "Link" && a.url === "https://lanternpdf.com/")).toBe(true);
    // The picture really is painted: its blue is on the page.
    const rendered = await renderPdfPage(result.bytes, 1, 1);
    let blue = 0;
    for (let y = 0; y < rendered.height; y += 3) for (let x = 0; x < rendered.width; x += 3) if (rendered.at(x, y)[2] > 180 && rendered.at(x, y)[0] < 90) blue += 1;
    expect(blue).toBeGreaterThan(50);
    expect(await metadataOf(result.bytes)).toMatchObject({ Title: "Annual summary", Author: "LanternPDF tests" });
  });

  it("flows long text onto more pages and numbers every page", async () => {
    const result = await convertOfficeFile("long.docx", await makeWordDocument({ paragraphs: 12 }));
    expect(result.pageCount).toBeGreaterThan(2);
    const texts = await pageTexts(result.bytes);
    expect(texts).toHaveLength(result.pageCount);
    texts.forEach((text, index) => expect(text).toContain(`Page ${index + 1} of ${result.pageCount}`));
    // Nothing is lost: every paragraph's number appears once across the pages.
    const all = texts.join(" ");
    for (let i = 1; i <= 12; i += 1) expect(all).toContain(`Paragraph ${i}.`);
  });

  it("says why a file cannot be opened instead of failing silently", async () => {
    await expect(convertOfficeFile("broken.docx", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).rejects.toMatchObject({ code: "INVALID_FILE" });
    const old = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    await expect(convertOfficeFile("old.docx", old)).rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringMatching(/older binary/) });
    await expect(convertOfficeFile("old.doc", old)).rejects.toBeInstanceOf(AppError);
  });
});

describe("Excel and CSV to PDF", () => {
  it("applies number, percent and date formats, shows a merged title once, and puts each sheet on its own page", async () => {
    const result = await convertOfficeFile("sales.xlsx", await makeWorkbook());
    expect(result.pageCount).toBe(2);
    const [first, second] = await pageTexts(result.bytes);
    expect(first?.match(/Regional sales/g)).toHaveLength(1);
    expect(first).toContain("$1,234.50");
    expect(first).toContain("25.6%");
    expect(first).toContain("19 Oct 2026");
    expect(first).toContain("2469");
    expect(first).toContain("A long note");
    expect(second).toContain("Second sheet text");
  });

  it("turns CSV into a table with the header row repeated style and numbers kept", async () => {
    const csv = new TextEncoder().encode('name,amount,note\nwidget,4,"has, comma"\ngadget,10.5,"say ""hi"""\n');
    const result = await convertOfficeFile("data.csv", csv);
    expect(result.pageCount).toBe(1);
    const [text] = await pageTexts(result.bytes);
    for (const expected of ["name", "amount", "widget", "has, comma", "gadget", "10.5", 'say "hi"']) expect(text).toContain(expected);
  });

  it("reads CSV quoting and picks the delimiter", () => {
    expect(parseCsv('a;b\n1;"x;y"\n')).toEqual([["a", "b"], ["1", "x;y"]]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv('a,b\r\n"line\nbreak",2')).toEqual([["a", "b"], ["line\nbreak", "2"]]);
  });
});

describe("PowerPoint to PDF", () => {
  it("makes one page per visible slide at the slide size, and keeps the text, bullets, table, link and picture", async () => {
    const result = await convertOfficeFile("review.pptx", await makeDeck());
    expect(result.pageCount).toBe(2);
    expect(result.warnings).toEqual(["1 hidden slide was not included."]);
    const [first, second] = await pageTexts(result.bytes);
    expect(first).toContain("Quarterly review");
    expect(first).toContain("Revenue grew");
    expect(first).toContain("Costs fell");
    expect(first).toContain("Region");
    expect(first).toContain("1,200");
    expect(second).toContain("Second slide with a link");
    expect(second).not.toContain("hidden");
    expect((await annotationsOf(result.bytes)).some((a) => a.subtype === "Link" && a.url === "https://lanternpdf.com/")).toBe(true);
    expect(await metadataOf(result.bytes)).toMatchObject({ Title: "Quarterly review", Author: "LanternPDF tests" });
  });

  it("applies the layout: the master's background, bar and placeholder positions reach the slide", async () => {
    const result = await convertOfficeFile("review.pptx", await makeDeck());
    const rendered = await renderPdfPage(result.bytes, 1, 1);
    // The 16:9 slide is 720 x 405 points.
    expect(rendered.width).toBe(720);
    expect(rendered.height).toBe(405);
    const near = (pixel: number[], expected: number[]) => pixel.slice(0, 3).every((value, index) => Math.abs(value - (expected[index] ?? 0)) < 8);
    expect(near(rendered.at(360, 395), [0x1f, 0x4e, 0x79])).toBe(true); // the master's bar at the bottom
    expect(near(rendered.at(5, 5), [0xf3, 0xf4, 0xf6])).toBe(true); // the master's background
    expect(near(rendered.at(550, 160), [0x3a, 0x3a, 0xd1])).toBe(true); // the ellipse on the slide
    // The title has no position of its own: it sits where the layout's placeholder is (near the top), not at a default place.
    const task = pdfjs.getDocument({ data: new Uint8Array(result.bytes), verbosity: 0 });
    try {
      const page = await (await task.promise).getPage(1);
      const title = (await page.getTextContent()).items.find((item) => "str" in item && item.str.includes("Quarterly"));
      expect(title && "transform" in title ? title.transform[5] : 0).toBeGreaterThan(405 - 90);
    } finally {
      await task.destroy();
    }
  });

  it("reads colours the way PowerPoint does: tints are mixed in linear light", () => {
    const ctx: ColorContext = { theme: { colors: { dk1: "#000000", lt1: "#ffffff", accent1: "#4f81bd" }, fillStyles: [], lineStyles: [], backgroundFillStyles: [] }, colorMap: { tx1: "dk1", bg1: "lt1", accent1: "accent1" } };
    const color = (xml: string) => parseColor(parseXml(`<a:solidFill xmlns:a="x">${xml}</a:solidFill>`), ctx)?.color;
    // Black with a 75% tint is the familiar mid grey of subtitles, not a dark one.
    expect(color(`<a:schemeClr val="tx1"><a:tint val="75000"/></a:schemeClr>`)).toBe("#898989");
    expect(color(`<a:srgbClr val="92D050"/>`)).toBe("#92d050");
    expect(color(`<a:schemeClr val="bg1"><a:lumMod val="50000"/></a:schemeClr>`)).toBe("#808080");
    expect(parseColor(parseXml(`<a:solidFill xmlns:a="x"><a:srgbClr val="FF0000"><a:alpha val="40000"/></a:srgbClr></a:solidFill>`), ctx)?.alpha).toBeCloseTo(0.4);
  });

  it("numbers automatic lists in the formats PowerPoint offers", () => {
    expect(formatNumber("arabicPeriod", 3)).toBe("3.");
    expect(formatNumber("arabicParenR", 12)).toBe("12)");
    expect(formatNumber("romanLcPeriod", 4)).toBe("iv.");
    expect(formatNumber("romanUcParenR", 9)).toBe("IX)");
    expect(formatNumber("alphaLcParenR", 2)).toBe("b)");
    expect(formatNumber("alphaUcPeriod", 27)).toBe("AA.");
  });

  it("says why a presentation cannot be opened", async () => {
    await expect(convertOfficeFile("broken.pptx", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).rejects.toMatchObject({ code: "INVALID_FILE" });
    const old = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    await expect(convertOfficeFile("old.pptx", old)).rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringMatching(/older binary/) });
  });
});

describe("line breaking", () => {
  it("fills a line up to the right edge instead of wrapping a word early", async () => {
    // "class Foo{" is 72 points wide in a 12 point monospaced font and the text area is 75.6 points wide: it must stay on one line.
    const { FontLibrary } = await import("../../../src/lib/office/fontLibrary");
    const { TextShaper, breakLines, buildAtoms } = await import("../../../src/lib/office/textflow");
    const fonts = new FontLibrary();
    await fonts.prepare([{ request: { family: "cousine", bold: false, italic: false }, text: "class Foo{alphbetgmdzkp" }]);
    const shaper = new TextShaper(fonts);
    const style = { family: "cousine" as const, bold: false, italic: false, size: 12, color: "#000000" };
    const atoms = buildAtoms(
      [
        { kind: "text", text: "class ", style },
        { kind: "text", text: "Foo{", style },
      ],
      shaper,
    );
    const lines = breakLines(atoms, { width: 75.6, firstLineOffset: 0, leftIndent: 0, align: "left", tabs: [], defaultTabStop: 72, lineRule: "auto", lineValue: 1, markStyle: style }, shaper);
    expect(lines).toHaveLength(1);
    // A longer text does wrap, and every line is filled to within one short word of the edge.
    const long = buildAtoms([{ kind: "text", text: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma", style }], shaper);
    const wrapped = breakLines(long, { width: 300, firstLineOffset: 0, leftIndent: 0, align: "left", tabs: [], defaultTabStop: 72, lineRule: "auto", lineValue: 1, markStyle: style }, shaper);
    expect(wrapped.length).toBeGreaterThan(1);
    for (const line of wrapped.slice(0, -1)) expect(line.width).toBeGreaterThan(300 - 9 * 7.3);
    for (const line of wrapped) expect(line.width).toBeLessThanOrEqual(300.01);
  });
});
