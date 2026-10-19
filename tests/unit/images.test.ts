import { BRAND } from "../../src/config/brand";
import { PDFDocument } from "@cantoo/pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { AppError } from "../../src/lib/errors";
import { setImageCodec } from "../../src/lib/pdf/codec";
import { jpegOrientation } from "../../src/lib/pdf/exif";
import { type ImagesToPdfOptions, imagesToPdf } from "../../src/lib/pdf/images";
import { isBlue, isRed, isWhite, makeBmp, makeImage, nodeCodec, renderPdfPage, withExifOrientation } from "./helpers/images";
import { pageGeometry } from "./helpers/pdf";

beforeAll(() => setImageCodec(nodeCodec));

const defaults: ImagesToPdfOptions = { pageSize: "a4", orientation: "auto", margin: "none", output: "single" };

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

describe("jpegOrientation", () => {
  const jpeg = makeImage("jpeg");

  it("is 1 for a JPEG without EXIF and for non-JPEG data", () => {
    expect(jpegOrientation(jpeg)).toBe(1);
    expect(jpegOrientation(makeImage("png"))).toBe(1);
    expect(jpegOrientation(new Uint8Array(0))).toBe(1);
  });

  it("reads every orientation value, in both byte orders", () => {
    for (const value of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(jpegOrientation(withExifOrientation(jpeg, value))).toBe(value);
      expect(jpegOrientation(withExifOrientation(jpeg, value, true))).toBe(value);
    }
  });

  it("ignores out-of-range values and truncated data", () => {
    expect(jpegOrientation(withExifOrientation(jpeg, 9))).toBe(1);
    expect(jpegOrientation(withExifOrientation(jpeg, 6).subarray(0, 14))).toBe(1);
  });
});

describe("imagesToPdf", () => {
  it("embeds a JPEG without recompressing it", async () => {
    const jpeg = makeImage("jpeg", 60, 40);
    const [out] = await imagesToPdf([{ name: "photo.jpg", bytes: jpeg }], defaults);
    expect(out?.name).toBe("photo.pdf");
    expect(out?.pageCount).toBe(1);
    // The original JPEG stream appears byte-for-byte inside the PDF.
    expect(Buffer.from(out!.bytes).includes(Buffer.from(jpeg))).toBe(true);
  });

  it("draws the picture on the page, not a blank sheet", async () => {
    const [out] = await imagesToPdf([{ name: "a.png", bytes: makeImage("png", 80, 40) }], { ...defaults, pageSize: "fit" });
    const page = await renderPdfPage(out!.bytes, 1, 4);
    expect(isRed(page.at(page.width * 0.25, page.height / 2))).toBe(true);
    expect(isBlue(page.at(page.width * 0.75, page.height / 2))).toBe(true);
  });

  it("keeps PNG transparency", async () => {
    const png = makeImage("png", 40, 40, (context) => {
      context.fillStyle = "#ff0000";
      context.fillRect(0, 0, 20, 40); // right half stays transparent
    }, { alpha: true });
    const [out] = await imagesToPdf([{ name: "alpha.png", bytes: png }], { ...defaults, pageSize: "fit" });
    expect(Buffer.from(out!.bytes).includes("/SMask")).toBe(true);
    const page = await renderPdfPage(out!.bytes, 1, 4);
    expect(isRed(page.at(page.width * 0.25, page.height / 2))).toBe(true);
    expect(isWhite(page.at(page.width * 0.75, page.height / 2))).toBe(true);
  });

  it("converts WebP, AVIF and BMP images so PDF can hold them", async () => {
    const files = [
      { name: "w.webp", bytes: makeImage("webp", 40, 20) },
      { name: "a.avif", bytes: makeImage("avif", 40, 20) },
      { name: "b.bmp", bytes: makeBmp(40, 20, [255, 0, 0]) },
    ];
    const [out] = await imagesToPdf(files, { ...defaults, pageSize: "fit" });
    expect(out?.pageCount).toBe(3);
    const first = await renderPdfPage(out!.bytes, 1, 4);
    expect(isRed(first.at(first.width * 0.25, first.height / 2))).toBe(true);
    expect(isBlue(first.at(first.width * 0.75, first.height / 2))).toBe(true);
    const bmp = await renderPdfPage(out!.bytes, 3, 4);
    expect(isRed(bmp.at(bmp.width / 2, bmp.height / 2))).toBe(true);
  });

  it("straightens phone photos whose EXIF says they are rotated", async () => {
    // Stored 40x20 (red left, blue right). EXIF 6 = rotate 90 degrees clockwise to view it, so the
    // red half ends up on top of an upright 20x40 picture.
    const rotated = withExifOrientation(makeImage("jpeg", 40, 20), 6);
    const [out] = await imagesToPdf([{ name: "phone.jpg", bytes: rotated }], { ...defaults, pageSize: "fit" });
    const [geometry] = await pageGeometry(out!.bytes);
    expect(geometry!.height).toBeGreaterThan(geometry!.width); // portrait, as it was taken
    const page = await renderPdfPage(out!.bytes, 1, 6);
    expect(isRed(page.at(page.width / 2, page.height * 0.25))).toBe(true);
    expect(isBlue(page.at(page.width / 2, page.height * 0.75))).toBe(true);
  });

  it("does not touch images whose EXIF orientation is already 1", async () => {
    const jpeg = withExifOrientation(makeImage("jpeg", 40, 20), 1);
    const [out] = await imagesToPdf([{ name: "plain.jpg", bytes: jpeg }], { ...defaults, pageSize: "fit" });
    expect(Buffer.from(out!.bytes).includes(Buffer.from(jpeg))).toBe(true);
  });

  describe("page layout", () => {
    const landscape = { name: "wide.png", bytes: makeImage("png", 80, 40) };
    const portrait = { name: "tall.png", bytes: makeImage("png", 40, 80) };

    it("uses A4 and picks the orientation from the image", async () => {
      const [out] = await imagesToPdf([landscape, portrait], defaults);
      const geometry = await pageGeometry(out!.bytes);
      expect(geometry).toEqual([
        { width: 842, height: 595, rotation: 0 },
        { width: 595, height: 842, rotation: 0 },
      ]);
    });

    it("can force an orientation", async () => {
      const [out] = await imagesToPdf([landscape], { ...defaults, orientation: "portrait" });
      expect(await pageGeometry(out!.bytes)).toEqual([{ width: 595, height: 842, rotation: 0 }]);
      const [out2] = await imagesToPdf([portrait], { ...defaults, orientation: "landscape" });
      expect(await pageGeometry(out2!.bytes)).toEqual([{ width: 842, height: 595, rotation: 0 }]);
    });

    it("supports the standard page sizes", async () => {
      const sizes: Record<string, [number, number]> = { a3: [842, 1191], a5: [420, 595], letter: [612, 792], legal: [612, 1008] };
      for (const [pageSize, [w, h]] of Object.entries(sizes)) {
        const [out] = await imagesToPdf([portrait], { ...defaults, pageSize: pageSize as ImagesToPdfOptions["pageSize"] });
        expect(await pageGeometry(out!.bytes)).toEqual([{ width: w, height: h, rotation: 0 }]);
      }
    });

    it("sizes the page to the image for 'fit' (96 dpi), margins included", async () => {
      const [none] = await imagesToPdf([{ name: "p.png", bytes: makeImage("png", 200, 100) }], { ...defaults, pageSize: "fit" });
      expect(await pageGeometry(none!.bytes)).toEqual([{ width: 150, height: 75, rotation: 0 }]);
      const [small] = await imagesToPdf([{ name: "p.png", bytes: makeImage("png", 200, 100) }], { ...defaults, pageSize: "fit", margin: "small" });
      expect(await pageGeometry(small!.bytes)).toEqual([{ width: 186, height: 111, rotation: 0 }]);
    });

    it("centres the image inside the margins and leaves the margin white", async () => {
      const [out] = await imagesToPdf([{ name: "sq.png", bytes: makeImage("png", 100, 100, (c) => { c.fillStyle = "#ff0000"; c.fillRect(0, 0, 100, 100); }) }], {
        ...defaults,
        pageSize: "letter",
        margin: "large",
      });
      const page = await renderPdfPage(out!.bytes, 1, 1);
      expect(isWhite(page.at(10, 10))).toBe(true); // inside the 36pt margin
      expect(isWhite(page.at(page.width - 10, page.height / 2))).toBe(true);
      expect(isRed(page.at(page.width / 2, page.height / 2))).toBe(true);
      expect(isRed(page.at(40, page.height / 2))).toBe(true); // image reaches the margin edge (it scales to fit the width)
    });
  });

  it("creates one PDF per image when asked, with unique names", async () => {
    const files = [
      { name: "scan.png", bytes: makeImage("png") },
      { name: "scan.png", bytes: makeImage("png") },
      { name: "other.jpg", bytes: makeImage("jpeg") },
    ];
    const outputs = await imagesToPdf(files, { ...defaults, output: "separate" });
    expect(outputs.map((o) => o.name)).toEqual(["scan.pdf", "scan (2).pdf", "other.pdf"]);
    expect(outputs.every((o) => o.pageCount === 1)).toBe(true);
  });

  it("records who made the PDF, not the underlying library", async () => {
    const [out] = await imagesToPdf([{ name: "a.png", bytes: makeImage("png") }], defaults);
    const doc = await PDFDocument.load(out!.bytes, { updateMetadata: false });
    expect(doc.getProducer()).toBe(BRAND.name);
    expect(doc.getCreator()).toBe(BRAND.name);
  });

  it("rejects bad input with the file's name", async () => {
    await expectAppError(imagesToPdf([], defaults), "INVALID_INPUT");
    const text = { name: "notes.png", bytes: new TextEncoder().encode("definitely not an image") };
    const error = await expectAppError(imagesToPdf([text], defaults), "INVALID_FILE");
    expect(error.message).toContain("notes.png");
    const corrupt = { name: "broken.jpg", bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 0xff, 0xd9]) };
    await expectAppError(imagesToPdf([corrupt], defaults), "INVALID_FILE");
  });
});
