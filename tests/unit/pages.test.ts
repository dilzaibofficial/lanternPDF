import { PDFDocument } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/lib/errors";
import { probePdf } from "../../src/lib/pdf/inspect";
import { arrangePages, mergePdfs, rotatePdf, selectPages, splitPdf } from "../../src/lib/pdf/pages";
import { protectPdf } from "../../src/lib/pdf/security";
import type { PageItem } from "../../src/lib/pdf/pages";
import { makeTextPdf, pageGeometry, pageTexts } from "./helpers/pdf";

const input = (name: string, bytes: Uint8Array, password?: string) => ({ name, bytes, password });

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return error as AppError;
  }
  throw new Error(`expected AppError ${code}, but the call succeeded`);
}

describe("mergePdfs", () => {
  it("concatenates in order and keeps each file's page size", async () => {
    const a = await makeTextPdf("A", 2);
    const b = await makeTextPdf("B", 3, [400, 300]);
    const out = await mergePdfs([input("a.pdf", a), input("b.pdf", b)]);

    expect(out.name).toBe("merged.pdf");
    expect(out.pageCount).toBe(5);
    expect(await pageTexts(out.bytes)).toEqual(["A p1", "A p2", "B p1", "B p2", "B p3"]);
    expect((await pageGeometry(out.bytes)).map((g) => `${g.width}x${g.height}`)).toEqual([
      "300x200",
      "300x200",
      "400x300",
      "400x300",
      "400x300",
    ]);
  });

  it("respects the order it is given, including repeats of the same file", async () => {
    const a = await makeTextPdf("A", 1);
    const b = await makeTextPdf("B", 1);
    const out = await mergePdfs([input("b.pdf", b), input("a.pdf", a), input("b2.pdf", b)]);
    expect(await pageTexts(out.bytes)).toEqual(["B p1", "A p1", "B p1"]);
  });

  it("needs at least two files", async () => {
    const a = await makeTextPdf("A", 1);
    await expectAppError(mergePdfs([input("a.pdf", a)]), "INVALID_INPUT");
    await expectAppError(mergePdfs([]), "INVALID_INPUT");
  });

  it("names the damaged file instead of failing vaguely", async () => {
    const good = await makeTextPdf("A", 1);
    const bad = new TextEncoder().encode("%PDF-1.4\nthis is not really a pdf");
    const error = await expectAppError(mergePdfs([input("good.pdf", good), input("bad.pdf", bad)]), "DAMAGED_PDF");
    expect(error.fileName).toBe("bad.pdf");
    expect(error.message).toContain("bad.pdf");
  });

  it("merges password-protected files when their passwords are supplied", async () => {
    const a = await makeTextPdf("A", 2);
    const b = await makeTextPdf("B", 1);
    const protectedB = await protectPdf(input("b.pdf", b), { userPassword: "s3cret" });

    const out = await mergePdfs([input("a.pdf", a), input("b_protected.pdf", protectedB.bytes, "s3cret")]);
    expect(await pageTexts(out.bytes)).toEqual(["A p1", "A p2", "B p1"]);
    // The merged result is a new, unprotected document.
    expect(await probePdf(out.bytes)).toMatchObject({ state: "ok", encrypted: false });
  });

  it("asks for the password of a protected file, and rejects a wrong one", async () => {
    const a = await makeTextPdf("A", 1);
    const b = await makeTextPdf("B", 1);
    const protectedB = await protectPdf(input("b.pdf", b), { userPassword: "right" });

    const missing = await expectAppError(
      mergePdfs([input("a.pdf", a), input("b_protected.pdf", protectedB.bytes)]),
      "PASSWORD_REQUIRED",
    );
    expect(missing.fileName).toBe("b_protected.pdf");

    const wrong = await expectAppError(
      mergePdfs([input("a.pdf", a), input("b_protected.pdf", protectedB.bytes, "wrong")]),
      "WRONG_PASSWORD",
    );
    expect(wrong.fileName).toBe("b_protected.pdf");
  });

  it("reports progress from 0 to 1 and never goes backwards", async () => {
    const a = await makeTextPdf("A", 1);
    const b = await makeTextPdf("B", 1);
    const seen: number[] = [];
    await mergePdfs([input("a.pdf", a), input("b.pdf", b)], { onProgress: (f) => seen.push(f) });
    expect(seen.length).toBeGreaterThan(2);
    expect(seen[seen.length - 1]).toBe(1);
    expect([...seen].sort((x, y) => x - y)).toEqual(seen);
  });
});

describe("selectPages", () => {
  it("extracts pages in the requested order, repeats included", async () => {
    const doc = await makeTextPdf("X", 4);
    const out = await selectPages(input("doc.pdf", doc), { pages: [3, 1, 1] });
    expect(out.pageCount).toBe(3);
    expect(out.name).toBe("doc_pages.pdf");
    expect(await pageTexts(out.bytes)).toEqual(["X p3", "X p1", "X p1"]);
  });

  it("can delete pages by selecting the complement", async () => {
    const doc = await makeTextPdf("X", 5);
    const out = await selectPages(input("doc.pdf", doc), { pages: [1, 3, 5] });
    expect(await pageTexts(out.bytes)).toEqual(["X p1", "X p3", "X p5"]);
  });

  it("rejects pages that do not exist, and empty selections", async () => {
    const doc = await makeTextPdf("X", 3);
    const error = await expectAppError(selectPages(input("doc.pdf", doc), { pages: [4] }), "INVALID_INPUT");
    expect(error.message).toMatch(/page 4 is out of range.*3 pages/i);
    await expectAppError(selectPages(input("doc.pdf", doc), { pages: [0] }), "INVALID_INPUT");
    await expectAppError(selectPages(input("doc.pdf", doc), { pages: [] }), "INVALID_INPUT");
  });

  it("keeps the document metadata when working on a single file", async () => {
    const source = await PDFDocument.create();
    source.setTitle("Quarterly report");
    source.setAuthor("A. Writer");
    source.addPage([300, 200]);
    source.addPage([300, 200]);
    const out = await selectPages(input("report.pdf", await source.save()), { pages: [2] });
    const reopened = await PDFDocument.load(out.bytes);
    expect(reopened.getTitle()).toBe("Quarterly report");
    expect(reopened.getAuthor()).toBe("A. Writer");
  });

  it("opens a protected file with its password and writes an unprotected result", async () => {
    const doc = await makeTextPdf("X", 3);
    const protectedDoc = await protectPdf(input("doc.pdf", doc), { userPassword: "pw" });
    const out = await selectPages(input("doc_protected.pdf", protectedDoc.bytes, "pw"), { pages: [2, 3] });
    expect(await pageTexts(out.bytes)).toEqual(["X p2", "X p3"]);
    expect(await probePdf(out.bytes)).toMatchObject({ state: "ok", encrypted: false });
  });
});

describe("splitPdf", () => {
  it("creates one file per range and names them by page numbers", async () => {
    const doc = await makeTextPdf("D", 6);
    const files = await splitPdf(input("doc.pdf", doc), {
      mode: "ranges",
      ranges: [
        { start: 1, end: 2 },
        { start: 4, end: 4 },
        { start: 5, end: 6 },
      ],
    });
    expect(files.map((f) => f.name)).toEqual(["doc_pages-1-2.pdf", "doc_page-4.pdf", "doc_pages-5-6.pdf"]);
    expect(files.map((f) => f.pageCount)).toEqual([2, 1, 2]);
    expect(await pageTexts(files[0]!.bytes)).toEqual(["D p1", "D p2"]);
    expect(await pageTexts(files[1]!.bytes)).toEqual(["D p4"]);
    expect(await pageTexts(files[2]!.bytes)).toEqual(["D p5", "D p6"]);
  });

  it("can merge all ranges into a single file", async () => {
    const doc = await makeTextPdf("D", 6);
    const files = await splitPdf(input("doc.pdf", doc), {
      mode: "ranges",
      mergeAll: true,
      ranges: [
        { start: 1, end: 2 },
        { start: 5, end: 6 },
      ],
    });
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe("doc_extracted.pdf");
    expect(await pageTexts(files[0]!.bytes)).toEqual(["D p1", "D p2", "D p5", "D p6"]);
  });

  it("splits every N pages, with a shorter final file when needed", async () => {
    const doc = await makeTextPdf("D", 5);
    const files = await splitPdf(input("doc.pdf", doc), { mode: "every", n: 2 });
    expect(files.map((f) => f.name)).toEqual(["doc_pages-1-2.pdf", "doc_pages-3-4.pdf", "doc_page-5.pdf"]);
    expect(files.map((f) => f.pageCount)).toEqual([2, 2, 1]);
    expect(await pageTexts(files[2]!.bytes)).toEqual(["D p5"]);
  });

  it("splits into single pages", async () => {
    const doc = await makeTextPdf("D", 3);
    const files = await splitPdf(input("doc.pdf", doc), { mode: "every", n: 1 });
    expect(files.map((f) => f.name)).toEqual(["doc_page-1.pdf", "doc_page-2.pdf", "doc_page-3.pdf"]);
    for (const [index, file] of files.entries()) {
      expect(await pageTexts(file.bytes)).toEqual([`D p${index + 1}`]);
    }
  });

  it("sorts parts numerically for large documents (zero-padded names)", async () => {
    const doc = await makeTextPdf("D", 12);
    const files = await splitPdf(input("doc.pdf", doc), { mode: "every", n: 1 });
    expect(files.map((f) => f.name)).toEqual(Array.from({ length: 12 }, (_, i) => `doc_page-${i + 1}.pdf`));
  });

  it("rejects invalid plans", async () => {
    const doc = await makeTextPdf("D", 3);
    await expectAppError(splitPdf(input("doc.pdf", doc), { mode: "every", n: 0 }), "INVALID_INPUT");
    await expectAppError(splitPdf(input("doc.pdf", doc), { mode: "every", n: 1.5 }), "INVALID_INPUT");
    // splitting a 3-page document every 3 pages would yield one file identical to the input
    await expectAppError(splitPdf(input("doc.pdf", doc), { mode: "every", n: 3 }), "INVALID_INPUT");
    await expectAppError(splitPdf(input("doc.pdf", doc), { mode: "ranges", ranges: [] }), "INVALID_INPUT");
    await expectAppError(splitPdf(input("doc.pdf", doc), { mode: "ranges", ranges: [{ start: 2, end: 9 }] }), "INVALID_INPUT");
  });
});

describe("arrangePages", () => {
  const page = (source: number, number: number, rotate: 0 | 90 | 180 | 270 = 0): PageItem => ({ kind: "page", source, page: number, rotate });

  it("reorders and deletes pages of a single file", async () => {
    const doc = await makeTextPdf("A", 4);
    const out = await arrangePages([input("a.pdf", doc)], [page(0, 4), page(0, 2)]);
    expect(out.pageCount).toBe(2);
    expect(await pageTexts(out.bytes)).toEqual(["A p4", "A p2"]);
  });

  it("applies rotation on top of each page's existing rotation", async () => {
    const source = await PDFDocument.create();
    for (let i = 0; i < 3; i += 1) source.addPage([300, 200]);
    const { degrees } = await import("@cantoo/pdf-lib");
    source.getPage(1).setRotation(degrees(90));
    const out = await arrangePages(
      [input("a.pdf", await source.save())],
      [page(0, 1, 90), page(0, 2, 90), page(0, 3, 270)],
    );
    expect((await pageGeometry(out.bytes)).map((g) => g.rotation)).toEqual([90, 180, 270]);
  });

  it("inserts blank pages with the requested size", async () => {
    const doc = await makeTextPdf("A", 2);
    const out = await arrangePages(
      [input("a.pdf", doc)],
      [page(0, 1), { kind: "blank", width: 200, height: 100, rotate: 0 }, page(0, 2)],
    );
    expect(await pageTexts(out.bytes)).toEqual(["A p1", "", "A p2"]);
    expect((await pageGeometry(out.bytes)).map((g) => `${g.width}x${g.height}`)).toEqual(["300x200", "200x100", "300x200"]);
  });

  it("mixes pages from several files in any order", async () => {
    const a = await makeTextPdf("A", 2);
    const b = await makeTextPdf("B", 2);
    const out = await arrangePages([input("a.pdf", a), input("b.pdf", b)], [page(1, 1), page(0, 2), page(1, 2), page(0, 1)]);
    expect(await pageTexts(out.bytes)).toEqual(["B p1", "A p2", "B p2", "A p1"]);
  });

  it("can repeat a page", async () => {
    const doc = await makeTextPdf("A", 2);
    const out = await arrangePages([input("a.pdf", doc)], [page(0, 1), page(0, 1), page(0, 2)]);
    expect(await pageTexts(out.bytes)).toEqual(["A p1", "A p1", "A p2"]);
  });

  it("rotates individual pages of a multi-file result by their output position", async () => {
    const a = await makeTextPdf("A", 1);
    const b = await makeTextPdf("B", 1);
    const out = await arrangePages([input("a.pdf", a), input("b.pdf", b)], [page(1, 1, 180), page(0, 1, 0)]);
    expect((await pageGeometry(out.bytes)).map((g) => g.rotation)).toEqual([180, 0]);
    expect(await pageTexts(out.bytes)).toEqual(["B p1", "A p1"]);
  });

  it("refuses an empty result and references to missing pages or files", async () => {
    const doc = await makeTextPdf("A", 2);
    await expectAppError(arrangePages([input("a.pdf", doc)], []), "INVALID_INPUT");
    await expectAppError(arrangePages([input("a.pdf", doc)], [page(0, 3)]), "INVALID_INPUT");
    await expectAppError(arrangePages([input("a.pdf", doc)], [page(1, 1)]), "INVALID_INPUT");
  });
});

describe("rotatePdf", () => {
  it("rotates every page", async () => {
    const doc = await makeTextPdf("R", 3);
    const out = await rotatePdf(input("doc.pdf", doc), { angle: 90, pages: null });
    expect(out.name).toBe("doc_rotated.pdf");
    expect((await pageGeometry(out.bytes)).map((g) => g.rotation)).toEqual([90, 90, 90]);
    expect(await pageTexts(out.bytes)).toEqual(["R p1", "R p2", "R p3"]);
  });

  it("rotates only the chosen pages", async () => {
    const doc = await makeTextPdf("R", 3);
    const out = await rotatePdf(input("doc.pdf", doc), { angle: 180, pages: [2] });
    expect((await pageGeometry(out.bytes)).map((g) => g.rotation)).toEqual([0, 180, 0]);
  });

  it("rejects empty or out-of-range selections", async () => {
    const doc = await makeTextPdf("R", 2);
    await expectAppError(rotatePdf(input("doc.pdf", doc), { angle: 90, pages: [] }), "INVALID_INPUT");
    await expectAppError(rotatePdf(input("doc.pdf", doc), { angle: 90, pages: [3] }), "INVALID_INPUT");
  });
});
