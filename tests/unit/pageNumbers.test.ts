import { BRAND } from "../../src/config/brand";
import { PDFDocument, degrees } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/lib/errors";
import { DEFAULT_PAGE_NUMBER_OPTIONS, type PageNumberOptions, addPageNumbers, formatPageLabel, toRoman } from "../../src/lib/pdf/pageNumbers";
import { probePdf } from "../../src/lib/pdf/inspect";
import { protectPdf } from "../../src/lib/pdf/security";
import { inkBounds, inkCentroid, renderPdfPage } from "./helpers/images";
import { makeTextPdf, pageTexts } from "./helpers/pdf";

const input = (name: string, bytes: Uint8Array, password?: string) => ({ name, bytes, password });
const options = (overrides: Partial<PageNumberOptions> = {}): PageNumberOptions => ({ ...DEFAULT_PAGE_NUMBER_OPTIONS, ...overrides });

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

/** A blank page of the given size: the only ink on it will be what the operation draws. */
async function blankPdf(pages: number, size: [number, number] = [300, 200], rotations: number[] = []): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage(size);
    if (rotations[i]) page.setRotation(degrees(rotations[i] as number));
  }
  return doc.save();
}

describe("label formatting", () => {
  it("fills in {n} and {total}", () => {
    expect(formatPageLabel("Page {n} of {total}", 3, 10)).toBe("Page 3 of 10");
    expect(formatPageLabel("{n}/{total}", 1, 2)).toBe("1/2");
    expect(formatPageLabel("- {n} -", 7, 7)).toBe("- 7 -");
    expect(formatPageLabel("{unknown} {n}", 2, 2)).toBe("{unknown} 2");
  });

  it("supports roman numerals", () => {
    expect([1, 4, 9, 14, 40, 90, 400, 1994, 3999].map(toRoman)).toEqual(["i", "iv", "ix", "xiv", "xl", "xc", "cd", "mcmxciv", "mmmcmxcix"]);
    expect(formatPageLabel("{n}", 4, 9, "upper-roman")).toBe("IV");
    expect(toRoman(0)).toBe("0");
  });
});

describe("addPageNumbers", () => {
  it("numbers every page and keeps the original content", async () => {
    const out = await addPageNumbers(input("doc.pdf", await makeTextPdf("X", 3)), options());
    expect(out.name).toBe("doc_numbered.pdf");
    expect(out.pageCount).toBe(3);
    const texts = await pageTexts(out.bytes);
    expect(texts[0]).toContain("X p1");
    expect(texts.map((t) => t.endsWith(String(texts.indexOf(t) + 1)))).toEqual([true, true, true]);
  });

  it("uses a template, a start number, and only the chosen pages (counting just those)", async () => {
    const out = await addPageNumbers(input("doc.pdf", await makeTextPdf("X", 4)), options({ format: "Page {n} of {total}", startAt: 5, pages: [2, 3, 4] }));
    const texts = await pageTexts(out.bytes);
    expect(texts[0]).toBe("X p1"); // page 1 untouched
    expect(texts[1]).toContain("Page 5 of 7");
    expect(texts[2]).toContain("Page 6 of 7");
    expect(texts[3]).toContain("Page 7 of 7");
  });

  it("can use roman numerals", async () => {
    const out = await addPageNumbers(input("doc.pdf", await makeTextPdf("X", 3)), options({ style: "roman", format: "{n}" }));
    const texts = await pageTexts(out.bytes);
    expect(texts.map((t) => t.split(" ").pop())).toEqual(["i", "ii", "iii"]);
  });

  describe("positions", () => {
    const cases: [PageNumberOptions["position"], (b: { minX: number; maxX: number; minY: number; maxY: number }, w: number, h: number) => boolean][] = [
      ["bottom-center", (b, w, h) => b.minX > w * 0.4 && b.maxX < w * 0.6 && b.minY > h * 0.8],
      ["bottom-left", (b, w, h) => b.maxX < w * 0.25 && b.minY > h * 0.8],
      ["bottom-right", (b, w, h) => b.minX > w * 0.75 && b.minY > h * 0.8],
      ["top-center", (b, w, h) => b.minX > w * 0.4 && b.maxX < w * 0.6 && b.maxY < h * 0.2],
      ["top-left", (b, w, h) => b.maxX < w * 0.25 && b.maxY < h * 0.2],
      ["top-right", (b, w, h) => b.minX > w * 0.75 && b.maxY < h * 0.2],
    ];
    for (const [position, check] of cases) {
      it(`puts the number at ${position}`, async () => {
        const out = await addPageNumbers(input("b.pdf", await blankPdf(1)), options({ position, fontSize: 14, color: "#000000" }));
        const page = await renderPdfPage(out.bytes, 1, 2);
        const ink = inkBounds(page);
        expect(ink.count).toBeGreaterThan(5);
        expect(check(ink, page.width, page.height)).toBe(true);
      });
    }
  });

  it("puts the number where the page is displayed, upright, even when the page is rotated", async () => {
    // A 300x200 page shown rotated by 0/90/180/270 degrees: the label must still sit in the displayed
    // bottom-right corner and read the right way up. "7" is bar-heavy at the top, so an upright glyph
    // has its ink centred in the upper half of its bounding box.
    for (const rotation of [0, 90, 180, 270]) {
      const out = await addPageNumbers(
        input("r.pdf", await blankPdf(1, [300, 200], [rotation])),
        options({ position: "bottom-right", startAt: 7, fontSize: 24, color: "#000000" }),
      );
      const page = await renderPdfPage(out.bytes, 1, 3);
      const ink = inkBounds(page);
      const label = `rotation ${rotation}`;
      expect(ink.count, label).toBeGreaterThan(20);
      expect(ink.minX, label).toBeGreaterThan(page.width * 0.75); // right
      expect(ink.maxX, label).toBeLessThan(page.width - 20); // inside the margin
      expect(ink.minY, label).toBeGreaterThan(page.height * 0.75); // bottom
      expect(ink.maxY, label).toBeLessThan(page.height - 20);
      expect(ink.maxX - ink.minX, label).toBeLessThan(ink.maxY - ink.minY + 12); // a single digit is no wider than tall
      expect(inkCentroid(page).fy, label).toBeLessThan(0.5); // upright, not upside down or sideways
    }
  });

  it("mirrors the position on even pages for facing-page layouts", async () => {
    const out = await addPageNumbers(input("b.pdf", await blankPdf(2)), options({ position: "bottom-right", facing: true, fontSize: 14, color: "#000000" }));
    const odd = inkBounds(await renderPdfPage(out.bytes, 1, 2));
    const even = inkBounds(await renderPdfPage(out.bytes, 2, 2));
    expect(odd.minX).toBeGreaterThan(300 * 2 * 0.7); // right edge
    expect(even.maxX).toBeLessThan(300 * 2 * 0.3); // left edge
  });

  it("draws in the chosen colour and size", async () => {
    const small = inkBounds(await renderPdfPage((await addPageNumbers(input("b.pdf", await blankPdf(1)), options({ fontSize: 10, color: "#ff0000" }))).bytes, 1, 4));
    const large = inkBounds(await renderPdfPage((await addPageNumbers(input("b.pdf", await blankPdf(1)), options({ fontSize: 40, color: "#ff0000" }))).bytes, 1, 4));
    expect(large.maxY - large.minY).toBeGreaterThan((small.maxY - small.minY) * 2.5);
    const page = await renderPdfPage((await addPageNumbers(input("b.pdf", await blankPdf(1)), options({ fontSize: 40, color: "#ff0000", position: "bottom-center" }))).bytes, 1, 4);
    const ink = inkBounds(page);
    const [r, g, b] = page.at((ink.minX + ink.maxX) / 2, (ink.minY + ink.maxY) / 2);
    expect(r).toBeGreaterThan(g + 40);
    expect(r).toBeGreaterThan(b + 40);
  });

  it("draws text outside Latin-1 (Cyrillic, Greek) with the bundled Unicode font", async () => {
    const out = await addPageNumbers(input("doc.pdf", await makeTextPdf("X", 2)), options({ format: "Стр. {n} · Σελίδα {n}" }));
    const texts = await pageTexts(out.bytes);
    expect(texts[0]).toContain("Стр. 1");
    expect(texts[1]).toContain("Σελίδα 2");
    // The glyphs really are drawn (not empty boxes): the ink of the label has substance.
    const page = await renderPdfPage(out.bytes, 1, 2);
    expect(inkBounds(page, (px) => px.every((c) => c > 235), { x0: 0, y0: page.height * 0.75, x1: page.width, y1: page.height }).count).toBeGreaterThan(100);
  });

  it("works on password-protected files, writing an unprotected result", async () => {
    const locked = await protectPdf(input("doc.pdf", await makeTextPdf("X", 2)), { userPassword: "pw" });
    const out = await addPageNumbers(input("doc_protected.pdf", locked.bytes, "pw"), options());
    expect(await probePdf(out.bytes)).toMatchObject({ state: "ok", pageCount: 2, encrypted: false });
    expect((await pageTexts(out.bytes))[1]).toContain("X p2");
    await expectAppError(addPageNumbers(input("doc_protected.pdf", locked.bytes), options()), "PASSWORD_REQUIRED");
  });

  it("records the producer and keeps existing metadata", async () => {
    const source = await PDFDocument.create();
    source.setTitle("My title");
    source.addPage([300, 200]);
    const out = await addPageNumbers(input("doc.pdf", await source.save()), options());
    const reopened = await PDFDocument.load(out.bytes, { updateMetadata: false });
    expect(reopened.getTitle()).toBe("My title");
    expect(reopened.getProducer()).toBe(BRAND.name);
  });

  it("rejects bad options with clear messages", async () => {
    const doc = await makeTextPdf("X", 2);
    expect((await expectAppError(addPageNumbers(input("d.pdf", doc), options({ format: "page" })), "INVALID_INPUT")).message).toMatch(/\{n\}/);
    await expectAppError(addPageNumbers(input("d.pdf", doc), options({ fontSize: 2 })), "INVALID_INPUT");
    await expectAppError(addPageNumbers(input("d.pdf", doc), options({ margin: -1 })), "INVALID_INPUT");
    await expectAppError(addPageNumbers(input("d.pdf", doc), options({ startAt: -3 })), "INVALID_INPUT");
    await expectAppError(addPageNumbers(input("d.pdf", doc), options({ startAt: 1.5 })), "INVALID_INPUT");
    await expectAppError(addPageNumbers(input("d.pdf", doc), options({ color: "red" })), "INVALID_INPUT");
    await expectAppError(addPageNumbers(input("d.pdf", doc), options({ pages: [3] })), "INVALID_INPUT");
    await expectAppError(addPageNumbers(input("d.pdf", doc), options({ pages: [] })), "INVALID_INPUT");
  });

  it("says when characters cannot be drawn instead of printing boxes", async () => {
    const error = await expectAppError(addPageNumbers(input("d.pdf", await makeTextPdf("X", 1)), options({ format: "第{n}页" })), "INVALID_INPUT");
    expect(error.message).toMatch(/not available in the built-in fonts/i);
  });
});
