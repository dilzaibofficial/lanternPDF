import { PDFDocument, PDFName, StandardFonts } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/lib/errors";
import { describePageSize, readMetadata, writeMetadata } from "../../src/lib/pdf/metadata";
import { protectPdf } from "../../src/lib/pdf/security";
import { addPageNumbers, DEFAULT_PAGE_NUMBER_OPTIONS } from "../../src/lib/pdf/pageNumbers";
import { makeImage } from "./helpers/images";
import { makeTextPdf, pageTexts } from "./helpers/pdf";

const input = (name: string, bytes: Uint8Array, password?: string) => ({ name, bytes, password });

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return error as AppError;
  }
  throw new Error(`expected AppError ${code}`);
}

async function richPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle("Annual report");
  doc.setAuthor("A. Writer");
  doc.setSubject("Finance");
  doc.setKeywords(["money", "yearly"]);
  doc.setCreator("Word");
  doc.setProducer("Acme PDF");
  doc.setCreationDate(new Date("2020-01-02T03:04:05Z"));
  doc.setModificationDate(new Date("2021-06-07T08:09:10Z"));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const png = await doc.embedPng(makeImage("png", 20, 20));
  const a4 = doc.addPage([595.28, 841.89]);
  a4.drawText("hello", { x: 20, y: 800, size: 12, font });
  a4.drawImage(png, { x: 20, y: 700, width: 50, height: 50 });
  doc.addPage([595.28, 841.89]);
  doc.addPage([841.89, 595.28]);
  doc.addPage([612, 792]);
  const form = doc.getForm();
  form.createTextField("name").addToPage(a4, { x: 20, y: 600, width: 100, height: 20 });
  await doc.attach(new TextEncoder().encode("attached note"), "notes.txt", { mimeType: "text/plain" });
  const xmp = doc.context.stream("<?xpacket begin='' id='W5M0MpCehiHzreSzNTczkc9d'?><x:xmpmeta xmlns:x='adobe:ns:meta/'/><?xpacket end='w'?>", { Type: "Metadata", Subtype: "XML" });
  doc.catalog.set(PDFName.of("Metadata"), doc.context.register(xmp));
  return doc.save();
}

describe("describePageSize", () => {
  it("names standard sizes in either orientation", () => {
    expect(describePageSize(595.28, 841.89)).toBe("A4 portrait");
    expect(describePageSize(841.89, 595.28)).toBe("A4 landscape");
    expect(describePageSize(612, 792)).toBe("US Letter portrait");
    expect(describePageSize(594.5, 842.5)).toBe("A4 portrait"); // within tolerance
  });

  it("falls back to millimetres for custom sizes", () => {
    expect(describePageSize(300, 200)).toBe("106 × 71 mm");
  });
});

describe("readMetadata", () => {
  it("reports every property of a document", async () => {
    const info = await readMetadata(input("report.pdf", await richPdf()));
    expect(info).toMatchObject({
      title: "Annual report",
      author: "A. Writer",
      subject: "Finance",
      keywords: "money yearly",
      creator: "Word",
      producer: "Acme PDF",
      creationDate: "2020-01-02T03:04:05.000Z",
      modificationDate: "2021-06-07T08:09:10.000Z",
      pageCount: 4,
      version: "1.7",
      linearized: false,
      hasXmp: true,
      hasOutline: false,
      formFieldCount: 1,
      attachmentCount: 1,
      hasJavaScript: false,
      imageCount: 1,
    });
    expect(info.fonts.map((font) => font.name)).toContain("Helvetica");
    expect(info.fileSize).toBeGreaterThan(1000);
  });

  it("groups page sizes and names them", async () => {
    const info = await readMetadata(input("report.pdf", await richPdf()));
    expect(info.pageSizes.map((s) => [s.label, s.count])).toEqual([
      ["A4 portrait", 2],
      ["A4 landscape", 1],
      ["US Letter portrait", 1],
    ]);
  });

  it("says nothing exists when it does not", async () => {
    const info = await readMetadata(input("plain.pdf", await makeTextPdf("P", 1)));
    expect(info).toMatchObject({ pageCount: 1, hasXmp: false, formFieldCount: 0, attachmentCount: 0, imageCount: 0 });
  });

  it("reads an embedded font as embedded", async () => {
    const out = await addPageNumbers(input("plain.pdf", await makeTextPdf("P", 1)), { ...DEFAULT_PAGE_NUMBER_OPTIONS, format: "Страница {n}" });
    const info = await readMetadata(input("u.pdf", out.bytes));
    expect(info.fonts.find((font) => font.name.includes("DejaVu"))?.embedded).toBe(true);
  });

  it("opens protected files with their password", async () => {
    const locked = await protectPdf(input("doc.pdf", await richPdf()), { userPassword: "pw" });
    expect((await readMetadata(input("l.pdf", locked.bytes, "pw"))).title).toBe("Annual report");
    await expectAppError(readMetadata(input("l.pdf", locked.bytes)), "PASSWORD_REQUIRED");
  });
});

describe("writeMetadata", () => {
  it("changes the chosen fields and leaves the rest and the content alone", async () => {
    const out = await writeMetadata(input("report.pdf", await richPdf()), { title: "New title", author: "B. Editor", keywords: "alpha beta" });
    expect(out.name).toBe("report_edited.pdf");
    const info = await readMetadata(input("o.pdf", out.bytes));
    expect(info).toMatchObject({ title: "New title", author: "B. Editor", keywords: "alpha beta", subject: "Finance", creator: "Word", pageCount: 4 });
    expect((await pageTexts(out.bytes))[0]).toContain("hello");
  });

  it("does not overwrite the producer or dates behind the user's back", async () => {
    const out = await writeMetadata(input("report.pdf", await richPdf()), { title: "T" });
    const info = await readMetadata(input("o.pdf", out.bytes));
    expect(info.producer).toBe("Acme PDF");
    expect(info.modificationDate).toBe("2021-06-07T08:09:10.000Z");
  });

  it("removes a field when asked (null) and sets dates", async () => {
    const out = await writeMetadata(input("report.pdf", await richPdf()), { subject: null, creationDate: new Date("2001-02-03T04:05:06Z") });
    const info = await readMetadata(input("o.pdf", out.bytes));
    expect(info.subject).toBeUndefined();
    expect(info.creationDate).toBe("2001-02-03T04:05:06.000Z");
    expect(info.title).toBe("Annual report");
  });

  it("drops the XMP packet when fields change, so no stale copy contradicts them", async () => {
    expect((await readMetadata(input("report.pdf", await richPdf()))).hasXmp).toBe(true);
    const out = await writeMetadata(input("report.pdf", await richPdf()), { title: "Changed" });
    expect((await readMetadata(input("o.pdf", out.bytes))).hasXmp).toBe(false);
  });

  it("can clear everything before sharing", async () => {
    const out = await writeMetadata(input("report.pdf", await richPdf()), { clearAll: true });
    expect(out.name).toBe("report_clean.pdf");
    const info = await readMetadata(input("o.pdf", out.bytes));
    expect(info).toMatchObject({ pageCount: 4, hasXmp: false });
    for (const field of ["title", "author", "subject", "keywords", "creator", "producer", "creationDate", "modificationDate"] as const) {
      expect(info[field], field).toBeUndefined();
    }
  });

  it("works on protected files, writing an unprotected result", async () => {
    const locked = await protectPdf(input("doc.pdf", await richPdf()), { userPassword: "pw" });
    const out = await writeMetadata(input("l.pdf", locked.bytes, "pw"), { title: "Opened" });
    expect((await readMetadata(input("o.pdf", out.bytes))).title).toBe("Opened");
  });

  it("refuses to produce an identical file", async () => {
    const error = await expectAppError(writeMetadata(input("report.pdf", await richPdf()), {}), "INVALID_INPUT");
    expect(error.message).toMatch(/nothing was changed/i);
  });

  it("handles non-Latin titles and long values", async () => {
    const title = "Годовой отчёт — 年次報告書 ✓";
    const out = await writeMetadata(input("report.pdf", await richPdf()), { title, subject: "x".repeat(2000) });
    const info = await readMetadata(input("o.pdf", out.bytes));
    expect(info.title).toBe(title);
    expect(info.subject).toHaveLength(2000);
  });
});
