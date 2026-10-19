import { PDFDocument, PDFName, type PDFRawStream, PDFRef, StandardFonts, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { type ImageUsage, scanImageUsage } from "../../src/lib/pdf/contentScan";
import { addRawImage } from "./helpers/pdfImages";

const pixels = (width: number, height: number) => new Uint8Array(width * height * 3).fill(120);

/** Usage by image size in pixels, read from a saved-and-reloaded file (as the compressor sees it). */
async function usageBySize(bytes: Uint8Array): Promise<{ bySize: Map<string, ImageUsage>; unreadable: number }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const report = scanImageUsage(doc);
  const bySize = new Map<string, ImageUsage>();
  for (const [key, usage] of report.images) {
    const [number, generation] = key.split(" ").map(Number);
    const object = doc.context.lookup(PDFRef.of(number as number, generation as number)) as PDFRawStream;
    bySize.set(`${object.dict.get(PDFName.of("Width"))}x${object.dict.get(PDFName.of("Height"))}`, usage);
  }
  return { bySize, unreadable: report.unreadable };
}

const sized = (usage: ImageUsage | undefined) => ({ width: Math.round((usage?.width ?? 0) * 100) / 100, height: Math.round((usage?.height ?? 0) * 100) / 100, uses: usage?.uses });

describe("scanImageUsage", () => {
  it("measures an image by how large it is painted", async () => {
    const doc = await PDFDocument.create();
    addRawImage(doc, doc.addPage([300, 200]), { width: 60, height: 40, components: 3, pixels: pixels(60, 40) }, { x: 10, y: 20, width: 120, height: 80 });
    const { bySize } = await usageBySize(await doc.save());
    expect(sized(bySize.get("60x40"))).toEqual({ width: 120, height: 80, uses: 1 });
  });

  it("follows nested transforms and restores them with Q, keeping the largest use", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    addRawImage(doc, page, { width: 50, height: 50, components: 3, pixels: pixels(50, 50) }, { x: 0, y: 0, width: 10, height: 10 }, "Im1");
    // q 2 0 0 2 0 0 cm  q 30 0 0 20 5 5 cm /Im1 Do Q Q   -> painted at 60 x 40
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(2, 0, 0, 2, 0, 0), pushGraphicsState(), concatTransformationMatrix(30, 0, 0, 20, 5, 5), drawObject("Im1"), popGraphicsState(), popGraphicsState());
    // after Q the scale is gone: a second, smaller use
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(8, 0, 0, 8, 0, 0), drawObject("Im1"), popGraphicsState());
    const { bySize } = await usageBySize(await doc.save());
    expect(sized(bySize.get("50x50"))).toEqual({ width: 60, height: 40, uses: 3 }); // the 10x10 draw from addRawImage, the 60x40 and the 8x8
  });

  it("measures turned and skewed placements by their edge lengths", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    // a 90 degree turn: the image's width runs up the page. Edges are (0,50) and (-80,0).
    addRawImage(doc, page, { width: 20, height: 20, components: 3, pixels: pixels(20, 20) }, { x: 0, y: 0, width: 1, height: 1 }, "Turned");
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(0, 50, -80, 0, 100, 0), drawObject("Turned"), popGraphicsState());
    const { bySize } = await usageBySize(await doc.save());
    expect(sized(bySize.get("20x20"))).toMatchObject({ width: 50, height: 80 });
  });

  it("reads images inside form XObjects, scaled by the form's placement", async () => {
    const source = await PDFDocument.create();
    addRawImage(source, source.addPage([100, 100]), { width: 70, height: 70, components: 3, pixels: pixels(70, 70) }, { x: 0, y: 0, width: 100, height: 100 });
    const target = await PDFDocument.create();
    const [embedded] = await target.embedPdf(await PDFDocument.load(await source.save()));
    const page = target.addPage([500, 500]);
    page.drawPage(embedded as NonNullable<typeof embedded>, { x: 10, y: 10, xScale: 2, yScale: 2 });
    page.drawPage(embedded as NonNullable<typeof embedded>, { x: 300, y: 300, xScale: 0.5, yScale: 0.5 });
    const { bySize } = await usageBySize(await target.save());
    expect(sized(bySize.get("70x70"))).toEqual({ width: 200, height: 200, uses: 2 });
  });

  it("is not confused by text that looks like operators, comments or inline images", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("q Q 9 0 0 9 0 0 cm /Im1 Do (nested) \\) [x]", { x: 10, y: 250, size: 8, font });
    addRawImage(doc, page, { width: 40, height: 40, components: 3, pixels: pixels(40, 40) }, { x: 0, y: 0, width: 90, height: 90 }, "Im1");
    // A hand-written stream: a comment, an inline image whose data contains " EI " followed by binary,
    // and then a real use of the image.
    const body = Buffer.concat([
      Buffer.from("% /Im1 Do 1 0 0 1 0 0 cm\nq BI /W 4 /H 4 /CS /G /BPC 8 ID ", "latin1"),
      Buffer.from([0x01, 0x20, 0x45, 0x49, 0x20, 0xff, 0xfe, 0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87]),
      Buffer.from(" EI Q\nq 33 0 0 33 0 0 cm /Im1 Do Q\n", "latin1"),
    ]);
    page.node.addContentStream(doc.context.register(doc.context.stream(new Uint8Array(body))));
    const { bySize, unreadable } = await usageBySize(await doc.save());
    expect(unreadable).toBe(0);
    expect(sized(bySize.get("40x40"))).toEqual({ width: 90, height: 90, uses: 2 }); // 90x90 from addRawImage, 33x33 after the inline image
  });

  it("reports an image that no page paints as having no use", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    const page = doc.addPage([100, 100]);
    const ref = addRawImage(doc, page, { width: 30, height: 30, components: 3, pixels: pixels(30, 30) }, { x: 0, y: 0, width: 30, height: 30 });
    const orphan = doc.context.register(doc.context.stream(pixels(20, 20), { Type: "XObject", Subtype: "Image", Width: 20, Height: 20, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }));
    const reloaded = await PDFDocument.load(await doc.save(), { updateMetadata: false });
    const { images } = scanImageUsage(reloaded);
    expect(images.has(ref.toString())).toBe(true);
    expect(images.has(orphan.toString())).toBe(false);
  });

  it("counts a content stream it cannot decode instead of guessing", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([100, 100]);
    const broken = doc.context.register(doc.context.stream(new Uint8Array([1, 2, 3, 4]), { Filter: "DCTDecode" }));
    page.node.addContentStream(broken);
    const { unreadable } = await usageBySize(await doc.save());
    expect(unreadable).toBe(1);
  });
});
