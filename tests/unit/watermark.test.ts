import { PDFDocument, degrees } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/lib/errors";
import { probePdf } from "../../src/lib/pdf/inspect";
import { protectPdf } from "../../src/lib/pdf/security";
import { DEFAULT_WATERMARK_OPTIONS, type WatermarkOptions, addWatermark } from "../../src/lib/pdf/watermark";
import { inkBounds, isRed, isWhite, makeImage, renderPdfPage } from "./helpers/images";
import { makeColorPdf, makeTextPdf, pageTexts } from "./helpers/pdf";

const input = (name: string, bytes: Uint8Array, password?: string) => ({ name, bytes, password });
const options = (overrides: Partial<WatermarkOptions> = {}): WatermarkOptions => ({ ...DEFAULT_WATERMARK_OPTIONS, ...overrides });
const notRed = (px: [number, number, number]) => isRed(px);

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

const RED_PAGE = () => makeColorPdf([[255, 0, 0]], [400, 300]);
const WHITE_PAGE = async () => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 300]);
  return doc.save();
};

/** White ink on a red page: the bounding box of every pixel that is no longer red. */
async function stampBounds(pdf: Uint8Array, pageNumber = 1) {
  return inkBounds(await renderPdfPage(pdf, pageNumber, 2), notRed);
}

describe("addWatermark (text)", () => {
  const solid = { color: "#ffffff", opacity: 1, rotation: 0, fontSize: 48 };

  it("stamps the text in the middle of the page and keeps the page's own content", async () => {
    const out = await addWatermark(input("doc.pdf", await makeTextPdf("X", 2, [400, 300])), options({ text: "DRAFT" }));
    expect(out.name).toBe("doc_watermarked.pdf");
    expect(out.pageCount).toBe(2);
    const texts = await pageTexts(out.bytes);
    expect(texts[0]).toContain("X p1");
    expect(texts[0]).toContain("DRAFT");
    expect(texts[1]).toContain("DRAFT");
  });

  it("centres an unrotated stamp on the page", async () => {
    const out = await addWatermark(input("r.pdf", await RED_PAGE()), options({ text: "DRAFT", ...solid }));
    const page = await renderPdfPage(out.bytes, 1, 2);
    const ink = inkBounds(page, isRed);
    expect(ink.count).toBeGreaterThan(200);
    expect((ink.minX + ink.maxX) / 2).toBeCloseTo(page.width / 2, -1); // within ~5px
    expect((ink.minY + ink.maxY) / 2).toBeCloseTo(page.height / 2, -1);
    expect(ink.maxX - ink.minX).toBeGreaterThan((ink.maxY - ink.minY) * 2); // a word is wider than tall
  });

  it("turns the stamp by the chosen angle, about its centre", async () => {
    const flat = inkBounds(await renderPdfPage((await addWatermark(input("r.pdf", await RED_PAGE()), options({ text: "DRAFT", ...solid, rotation: 0 }))).bytes, 1, 2), isRed);
    const turned = await addWatermark(input("r.pdf", await RED_PAGE()), options({ text: "DRAFT", ...solid, rotation: 45 }));
    const page = await renderPdfPage(turned.bytes, 1, 2);
    const ink = inkBounds(page, isRed);
    const flatAspect = (flat.maxX - flat.minX) / (flat.maxY - flat.minY);
    const turnedAspect = (ink.maxX - ink.minX) / (ink.maxY - ink.minY);
    expect(turnedAspect).toBeLessThan(flatAspect / 2); // a diagonal word has a squarer bounding box
    // Turned about its own centre, not about a corner: the ink stays within 2% of the page size of the
    // middle (glyph shapes are asymmetric, so a few points of drift is expected; a corner pivot would be tens).
    expect(Math.abs((ink.minX + ink.maxX) / 2 - page.width / 2)).toBeLessThan(page.width * 0.02);
    expect(Math.abs((ink.minY + ink.maxY) / 2 - page.height / 2)).toBeLessThan(page.height * 0.02);
  });

  it("stacks several lines around the centre", async () => {
    const one = inkBounds(await renderPdfPage((await addWatermark(input("r.pdf", await RED_PAGE()), options({ text: "TOP SECRET", ...solid }))).bytes, 1, 2), isRed);
    const two = await addWatermark(input("r.pdf", await RED_PAGE()), options({ text: "TOP SECRET\nDO NOT COPY", ...solid }));
    const page = await renderPdfPage(two.bytes, 1, 2);
    const ink = inkBounds(page, isRed);
    expect(ink.maxY - ink.minY).toBeGreaterThan((one.maxY - one.minY) * 1.8);
    expect((ink.minY + ink.maxY) / 2).toBeCloseTo(page.height / 2, -1);
    expect((await pageTexts(two.bytes))[0]).toMatch(/TOP SECRET.*DO NOT COPY/);
  });

  it("puts it above the content, or behind it", async () => {
    const over = await addWatermark(input("r.pdf", await RED_PAGE()), options({ text: "DRAFT", ...solid, layer: "over" }));
    const under = await addWatermark(input("r.pdf", await RED_PAGE()), options({ text: "DRAFT", ...solid, layer: "under" }));
    expect((await stampBounds(over.bytes)).count).toBeGreaterThan(200); // visible on top of the opaque page
    expect((await stampBounds(under.bytes)).count).toBe(0); // hidden behind it...
    expect((await pageTexts(under.bytes))[0]).toContain("DRAFT"); // ...but still in the file
    // and behind transparent content it shows
    const visible = await addWatermark(input("w.pdf", await WHITE_PAGE()), options({ text: "DRAFT", color: "#000000", opacity: 1, rotation: 0, layer: "under" }));
    expect(inkBounds(await renderPdfPage(visible.bytes, 1, 2), isWhite).count).toBeGreaterThan(200);
  });

  it("makes the stamp see-through by the chosen opacity", async () => {
    const half = await addWatermark(input("w.pdf", await WHITE_PAGE()), options({ text: "WWWW", color: "#000000", opacity: 0.5, rotation: 0, fontSize: 120 }));
    const page = await renderPdfPage(half.bytes, 1, 2);
    const ink = inkBounds(page, isWhite);
    // The darkest pixel of a black stamp at 50% on white is mid-grey, never black.
    let darkest = 255;
    for (let y = ink.minY; y <= ink.maxY; y += 1) for (let x = ink.minX; x <= ink.maxX; x += 1) darkest = Math.min(darkest, page.at(x, y)[0]);
    expect(darkest).toBeGreaterThan(100);
    expect(darkest).toBeLessThan(160);
  });

  describe("positions", () => {
    const cases: [WatermarkOptions["position"], (b: { minX: number; maxX: number; minY: number; maxY: number }, w: number, h: number) => boolean][] = [
      ["top-left", (b, w, h) => b.maxX < w * 0.5 && b.maxY < h * 0.3],
      ["top-right", (b, w, h) => b.minX > w * 0.5 && b.maxY < h * 0.3],
      ["bottom-left", (b, w, h) => b.maxX < w * 0.5 && b.minY > h * 0.7],
      ["bottom-right", (b, w, h) => b.minX > w * 0.5 && b.minY > h * 0.7],
      ["top-center", (b, w, h) => b.minX > w * 0.25 && b.maxX < w * 0.75 && b.maxY < h * 0.3],
      ["middle-left", (b, w, h) => b.maxX < w * 0.5 && b.minY > h * 0.3 && b.maxY < h * 0.7],
    ];
    for (const [position, check] of cases) {
      it(`places the stamp at ${position}`, async () => {
        const out = await addWatermark(input("r.pdf", await RED_PAGE()), options({ text: "STAMP", ...solid, fontSize: 24, position }));
        const page = await renderPdfPage(out.bytes, 1, 2);
        const ink = inkBounds(page, isRed);
        expect(ink.count).toBeGreaterThan(50);
        expect(check(ink, page.width, page.height)).toBe(true);
      });
    }

    it("keeps a turned stamp inside the margins, judging it by its turned outline", async () => {
      const margin = 30;
      for (const position of ["top-left", "top-right", "bottom-left", "bottom-right"] as const) {
        const out = await addWatermark(input("r.pdf", await RED_PAGE()), options({ text: "STAMP", ...solid, fontSize: 30, rotation: 45, position, margin }));
        const page = await renderPdfPage(out.bytes, 1, 2);
        const ink = inkBounds(page, isRed);
        expect(ink.count, position).toBeGreaterThan(50);
        const edge = (margin - 1) * 2; // a point of slack for anti-aliasing, at two pixels per point
        expect(ink.minX, position).toBeGreaterThanOrEqual(edge);
        expect(ink.minY, position).toBeGreaterThanOrEqual(edge);
        expect(ink.maxX, position).toBeLessThanOrEqual(page.width - edge);
        expect(ink.maxY, position).toBeLessThanOrEqual(page.height - edge);
      }
    });

    it("places it by what the viewer displays on a rotated page", async () => {
      const doc = await PDFDocument.load(await RED_PAGE());
      doc.getPage(0).setRotation(degrees(90)); // displayed 300x400
      const out = await addWatermark(input("r.pdf", await doc.save()), options({ text: "STAMP", ...solid, fontSize: 24, position: "top-left" }));
      const page = await renderPdfPage(out.bytes, 1, 2);
      const ink = inkBounds(page, isRed);
      expect(ink.maxX).toBeLessThan(page.width * 0.5);
      expect(ink.maxY).toBeLessThan(page.height * 0.2);
      expect(ink.maxX - ink.minX).toBeGreaterThan((ink.maxY - ink.minY) * 2); // still horizontal text
    });
  });

  it("repeats the stamp across the page when tiled", async () => {
    const out = await addWatermark(input("r.pdf", await RED_PAGE()), options({ text: "COPY", ...solid, fontSize: 24, rotation: 30, position: "tiled" }));
    const page = await renderPdfPage(out.bytes, 1, 2);
    for (const [x0, y0, x1, y1] of [
      [0, 0, 0.5, 0.5],
      [0.5, 0, 1, 0.5],
      [0, 0.5, 0.5, 1],
      [0.5, 0.5, 1, 1],
    ] as const) {
      const ink = inkBounds(page, isRed, { x0: x0 * page.width, y0: y0 * page.height, x1: x1 * page.width, y1: y1 * page.height });
      expect(ink.count, `quadrant ${x0},${y0}`).toBeGreaterThan(100);
    }
  });

  it("stamps only the chosen pages", async () => {
    const out = await addWatermark(input("r.pdf", await makeColorPdf([[255, 0, 0], [255, 0, 0], [255, 0, 0]], [400, 300])), options({ text: "ONLY", ...solid, pages: [2] }));
    expect((await stampBounds(out.bytes, 1)).count).toBe(0);
    expect((await stampBounds(out.bytes, 2)).count).toBeGreaterThan(100);
    expect((await stampBounds(out.bytes, 3)).count).toBe(0);
  });

  it("draws Cyrillic and Greek text", async () => {
    const out = await addWatermark(input("r.pdf", await RED_PAGE()), options({ text: "ЧЕРНОВИК Σχέδιο", ...solid, fontSize: 40 }));
    expect((await pageTexts(out.bytes))[0]).toContain("ЧЕРНОВИК Σχέδιο");
    expect((await stampBounds(out.bytes)).count).toBeGreaterThan(300);
  });
});

describe("addWatermark (image)", () => {
  const logo = (color: string) =>
    makeImage("png", 40, 40, (context, w, h) => {
      context.fillStyle = color;
      context.fillRect(0, 0, w, h);
    });

  it("places a PNG at the chosen corner, size and opacity", async () => {
    const out = await addWatermark(
      input("w.pdf", await WHITE_PAGE()),
      options({ kind: "image", image: { name: "logo.png", bytes: logo("#0000ff") }, imageScale: 20, opacity: 0.5, rotation: 0, position: "bottom-right", margin: 20 }),
    );
    const page = await renderPdfPage(out.bytes, 1, 2);
    const ink = inkBounds(page, isWhite);
    expect(ink.minX).toBeGreaterThan(page.width * 0.7);
    expect(ink.minY).toBeGreaterThan(page.height * 0.6); // an 80pt square, 20pt above the bottom edge of a 300pt page
    expect(ink.maxY).toBeLessThan(page.height * 0.95);
    expect(ink.maxX - ink.minX).toBeGreaterThan(page.width * 0.19); // 20% of the width
    expect(ink.maxX - ink.minX).toBeLessThan(page.width * 0.22);
    const [r, g, b] = page.at((ink.minX + ink.maxX) / 2, (ink.minY + ink.maxY) / 2);
    expect(r).toBeGreaterThan(110); // 50% blue over white = (127, 127, 255)
    expect(r).toBeLessThan(150);
    expect(g).toBeGreaterThan(110);
    expect(b).toBeGreaterThan(240);
  });

  it("accepts JPEG and WebP logos too, and rotates them about their centre", async () => {
    for (const format of ["jpeg", "webp"] as const) {
      const bytes = makeImage(format, 60, 30);
      const out = await addWatermark(input("w.pdf", await WHITE_PAGE()), options({ kind: "image", image: { name: `logo.${format}`, bytes }, imageScale: 30, opacity: 1, rotation: 90, position: "center" }));
      const page = await renderPdfPage(out.bytes, 1, 2);
      const ink = inkBounds(page, isWhite);
      expect((ink.minX + ink.maxX) / 2).toBeCloseTo(page.width / 2, -1);
      expect((ink.minY + ink.maxY) / 2).toBeCloseTo(page.height / 2, -1);
      expect(ink.maxY - ink.minY).toBeGreaterThan(ink.maxX - ink.minX); // a wide logo turned on its side
    }
  });

  it("never lets the image get taller than the page", async () => {
    const tall = makeImage("png", 20, 400);
    const out = await addWatermark(input("w.pdf", await WHITE_PAGE()), options({ kind: "image", image: { name: "tall.png", bytes: tall }, imageScale: 100, opacity: 1, rotation: 0, position: "center" }));
    const page = await renderPdfPage(out.bytes, 1, 2);
    const ink = inkBounds(page, isWhite);
    expect(ink.maxY - ink.minY).toBeLessThanOrEqual(page.height * 0.96);
  });
});

describe("addWatermark (inputs and errors)", () => {
  it("works on protected files and writes an unprotected result", async () => {
    const locked = await protectPdf(input("doc.pdf", await makeTextPdf("X", 1, [400, 300])), { userPassword: "pw" });
    const out = await addWatermark(input("doc_protected.pdf", locked.bytes, "pw"), options());
    expect(await probePdf(out.bytes)).toMatchObject({ state: "ok", encrypted: false });
    await expectAppError(addWatermark(input("doc_protected.pdf", locked.bytes), options()), "PASSWORD_REQUIRED");
  });

  it("rejects invalid settings with clear messages", async () => {
    const doc = await makeTextPdf("X", 2, [400, 300]);
    await expectAppError(addWatermark(input("d.pdf", doc), options({ text: "   " })), "INVALID_INPUT");
    await expectAppError(addWatermark(input("d.pdf", doc), options({ text: "x".repeat(401) })), "INVALID_INPUT");
    await expectAppError(addWatermark(input("d.pdf", doc), options({ fontSize: 1 })), "INVALID_INPUT");
    await expectAppError(addWatermark(input("d.pdf", doc), options({ opacity: 0 })), "INVALID_INPUT");
    await expectAppError(addWatermark(input("d.pdf", doc), options({ opacity: 1.5 })), "INVALID_INPUT");
    await expectAppError(addWatermark(input("d.pdf", doc), options({ rotation: 400 })), "INVALID_INPUT");
    await expectAppError(addWatermark(input("d.pdf", doc), options({ color: "nope" })), "INVALID_INPUT");
    await expectAppError(addWatermark(input("d.pdf", doc), options({ pages: [3] })), "INVALID_INPUT");
    await expectAppError(addWatermark(input("d.pdf", doc), options({ kind: "image" })), "INVALID_INPUT");
    await expectAppError(addWatermark(input("d.pdf", doc), options({ kind: "image", image: { name: "x.png", bytes: new TextEncoder().encode("not an image") } })), "INVALID_FILE");
  });
});
