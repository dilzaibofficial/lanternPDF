import { PDFDocument, PDFName, degrees, rgb } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/lib/errors";
import { type CropOptions, cropPdf } from "../../src/lib/pdf/crop";
import { isBlue, isRed, renderPdfPage } from "./helpers/images";
import { makeTextPdf, pageGeometry, pageTexts } from "./helpers/pdf";

const input = (name: string, bytes: Uint8Array) => ({ name, bytes });
const crop = (margins: Partial<CropOptions["margins"]>, extra: Partial<CropOptions> = {}): CropOptions => ({
  margins: { top: 0, right: 0, bottom: 0, left: 0, ...margins },
  unit: "pt",
  pages: null,
  ...extra,
});

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

/** 300x200 page: blue everywhere, a red strip down the left edge (50pt) and a green strip along the top (30pt). */
async function stripedPdf(pages = 1, rotation = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage([300, 200]);
    page.drawRectangle({ x: 0, y: 0, width: 300, height: 200, color: rgb(0, 0, 1) });
    page.drawRectangle({ x: 0, y: 0, width: 50, height: 200, color: rgb(1, 0, 0) });
    page.drawRectangle({ x: 0, y: 170, width: 300, height: 30, color: rgb(0, 1, 0) });
    if (rotation) page.setRotation(degrees(rotation));
  }
  return doc.save();
}

describe("cropPdf", () => {
  it("removes the requested margins from each edge", async () => {
    const out = await cropPdf(input("doc.pdf", await stripedPdf()), crop({ left: 50, right: 30, top: 30, bottom: 40 }));
    expect(out.name).toBe("doc_cropped.pdf");
    expect(await pageGeometry(out.bytes)).toEqual([{ width: 220, height: 130, rotation: 0 }]);
    // the 50pt red strip and the 30pt green strip are gone: the whole page is blue
    const page = await renderPdfPage(out.bytes, 1, 2);
    expect(isBlue(page.at(2, 2))).toBe(true);
    expect(isBlue(page.at(page.width - 3, page.height - 3))).toBe(true);
    expect(isBlue(page.at(page.width / 2, page.height / 2))).toBe(true);
  });

  it("keeps what is inside the box exactly where it was", async () => {
    // Crop only 20pt from the left: the red strip is 50pt wide, so 30pt of it remains at the new left edge.
    const out = await cropPdf(input("doc.pdf", await stripedPdf()), crop({ left: 20 }));
    const page = await renderPdfPage(out.bytes, 1, 2);
    expect(isRed(page.at(2, page.height / 2))).toBe(true);
    expect(isRed(page.at(2 * 25, page.height / 2))).toBe(true); // x = 25pt: still red (50 - 20 = 30pt wide)
    expect(isBlue(page.at(2 * 40, page.height / 2))).toBe(true); // x = 40pt: past the strip
    expect(await pageGeometry(out.bytes)).toEqual([{ width: 280, height: 200, rotation: 0 }]);
  });

  it("sets both the CropBox and the MediaBox, and drops the other boxes", async () => {
    const source = await PDFDocument.load(await stripedPdf());
    source.getPage(0).setTrimBox(0, 0, 300, 200);
    source.getPage(0).setBleedBox(0, 0, 300, 200);
    const out = await cropPdf(input("doc.pdf", await source.save()), crop({ left: 10, bottom: 10 }));
    const page = (await PDFDocument.load(out.bytes)).getPage(0);
    expect(page.getCropBox()).toEqual({ x: 10, y: 10, width: 290, height: 190 });
    expect(page.getMediaBox()).toEqual({ x: 10, y: 10, width: 290, height: 190 });
    expect(page.node.has(PDFName.of("TrimBox"))).toBe(false);
    expect(page.node.has(PDFName.of("BleedBox"))).toBe(false);
  });

  it("supports percentages of each page", async () => {
    const out = await cropPdf(input("doc.pdf", await stripedPdf()), crop({ left: 10, right: 10, top: 10, bottom: 10 }, { unit: "percent" }));
    expect(await pageGeometry(out.bytes)).toEqual([{ width: 240, height: 160, rotation: 0 }]);
  });

  it("crops the page as it is displayed when the page is rotated", async () => {
    // Rotated 90 degrees clockwise, the stored left edge (the red strip) is displayed at the TOP.
    const rotated = await stripedPdf(1, 90);
    const before = await renderPdfPage(rotated, 1, 2);
    expect(isRed(before.at(before.width / 2, 2))).toBe(true);

    const out = await cropPdf(input("doc.pdf", rotated), crop({ top: 50 }));
    const page = await renderPdfPage(out.bytes, 1, 2);
    expect(isRed(page.at(page.width / 2, 2))).toBe(false); // red strip removed from the top
    expect(isBlue(page.at(page.width / 2, 2))).toBe(true);
    // displayed size was 200x300; now 200x250
    expect(page.width).toBe(400);
    expect(page.height).toBe(500);
    // "left" means the displayed left edge for every rotation: the cropped view equals the full view
    // shifted by 40 points, pixel for pixel.
    for (const rotation of [0, 90, 180, 270]) {
      const source = await stripedPdf(1, rotation);
      const cropped = await cropPdf(input("doc.pdf", source), crop({ left: 40 }));
      const view = await renderPdfPage(cropped.bytes, 1, 1);
      const full = await renderPdfPage(source, 1, 1);
      expect(view.width, `rotation ${rotation}`).toBe(full.width - 40);
      expect(view.height, `rotation ${rotation}`).toBe(full.height);
      for (const [x, y] of [[5, 5], [60, 30], [view.width - 6, 20], [view.width / 2, view.height - 8], [view.width - 6, view.height - 6]] as const) {
        const a = view.at(x, y);
        const b = full.at(x + 40, y);
        expect(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]), `rotation ${rotation} at ${x},${y}`).toBeLessThan(40);
      }
    }
  });

  it("can crop only some pages", async () => {
    const out = await cropPdf(input("doc.pdf", await stripedPdf(3)), crop({ left: 50 }, { pages: [2] }));
    expect((await pageGeometry(out.bytes)).map((g) => g.width)).toEqual([300, 250, 300]);
  });

  it("keeps the page text", async () => {
    const out = await cropPdf(input("doc.pdf", await makeTextPdf("T", 2, [300, 200])), crop({ top: 5 }));
    expect(await pageTexts(out.bytes)).toEqual(["T p1", "T p2"]);
  });

  it("rejects settings that make no sense", async () => {
    const doc = await stripedPdf(2);
    expect((await expectAppError(cropPdf(input("d.pdf", doc), crop({})), "INVALID_INPUT")).message).toMatch(/nothing would be cropped/i);
    await expectAppError(cropPdf(input("d.pdf", doc), crop({ left: -5 })), "INVALID_INPUT");
    await expectAppError(cropPdf(input("d.pdf", doc), crop({ left: Number.NaN })), "INVALID_INPUT");
    await expectAppError(cropPdf(input("d.pdf", doc), crop({ left: 60, right: 40 }, { unit: "percent" })), "INVALID_INPUT");
    const tooMuch = await expectAppError(cropPdf(input("d.pdf", doc), crop({ left: 150, right: 145 })), "INVALID_INPUT");
    expect(tooMuch.message).toMatch(/page 1/);
    await expectAppError(cropPdf(input("d.pdf", doc), crop({ left: 5 }, { pages: [5] })), "INVALID_INPUT");
  });
});
