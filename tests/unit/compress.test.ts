import { PDFBool, PDFDocument, PDFName, PDFStream, rgb } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/lib/errors";
import { type CompressLevel, type CompressResult, IMAGE_PROFILES, compressPdf } from "../../src/lib/pdf/compress";
import { probePdf } from "../../src/lib/pdf/inspect";
import { protectPdf } from "../../src/lib/pdf/security";
import { makeImage, renderPdfPage, withExifOrientation } from "./helpers/images";
import { makeTextPdf, pageTexts } from "./helpers/pdf";
import { addRawImage, drawPixels, graphicPixels, imageObjects, jpegPage, meanAbsDiff, photoJpeg, photoPixels, random, rgbOf } from "./helpers/pdfImages";

const input = (name: string, bytes: Uint8Array, password?: string) => ({ name, bytes, password });
const run = (bytes: Uint8Array, level: CompressLevel, password?: string): Promise<CompressResult> => compressPdf(input("doc.pdf", bytes, password), { level });

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

describe("compressPdf: images", () => {
  it("brings an oversized photo down to the target resolution and keeps it looking the same", async () => {
    const original = await jpegPage(photoJpeg(1200, 900)); // 432 dpi on a 200 x 150 pt page
    const result = await run(original, "balanced");

    expect(result.smaller).toBe(true);
    expect(result.file.name).toBe("doc_compressed.pdf");
    expect(result.file.bytes.length).toBeLessThan(original.length * 0.4);
    expect(result.images).toMatchObject({ total: 1, optimized: 1, downsampled: 1 });
    expect(result.images.bytesSaved).toBeGreaterThan(0);
    expect(result.file.pageCount).toBe(1);

    const [image] = await imageObjects(result.file.bytes);
    expect(image).toMatchObject({ width: 417, filter: "/DCTDecode" }); // 200 pt at 150 dpi
    expect(image?.height).toBeGreaterThanOrEqual(312);
    expect(image?.height).toBeLessThanOrEqual(313);

    const before = await renderPdfPage(original, 1, 2);
    const after = await renderPdfPage(result.file.bytes, 1, 2);
    expect(meanAbsDiff(before, after)).toBeLessThan(6);
  });

  it("goes further at the strong level", async () => {
    const original = await jpegPage(photoJpeg(1200, 900));
    const balanced = await run(original, "balanced");
    const strong = await run(original, "strong");
    expect(strong.file.bytes.length).toBeLessThan(balanced.file.bytes.length);
    const [image] = await imageObjects(strong.file.bytes);
    expect(image?.width).toBe(Math.round((1200 * IMAGE_PROFILES.strong.maxDpi) / 432)); // 267
    const after = await renderPdfPage(strong.file.bytes, 1, 2);
    expect(meanAbsDiff(await renderPdfPage(original, 1, 2), after)).toBeLessThan(10);
  });

  it("leaves a photo alone that is already at a sensible resolution and bit rate", async () => {
    // 300 x 200 px at 300 x 200 pt is 72 dpi, and a q92 JPEG of this size is dense, so only re-encoding could help
    const original = await jpegPage(photoJpeg(300, 200), 300, 200);
    const result = await run(original, "balanced");
    const [before] = await imageObjects(original);
    const [after] = await imageObjects(result.file.bytes);
    expect(after?.width).toBe(300); // never resampled
    if (result.images.optimized === 0) expect(after?.length).toBe(before?.length);
    expect(result.file.bytes.length).toBeLessThanOrEqual(original.length);
  });

  it("measures the on-page size, so one image shown big and small is sized for its largest use", async () => {
    const doc = await PDFDocument.create();
    const jpeg = await doc.embedJpg(photoJpeg(1200, 900));
    doc.addPage([400, 300]).drawImage(jpeg, { x: 0, y: 0, width: 400, height: 300 }); // 216 dpi
    doc.addPage([100, 75]).drawImage(jpeg, { x: 0, y: 0, width: 100, height: 75 }); // 864 dpi
    const result = await run(await doc.save(), "balanced");
    const [image] = await imageObjects(result.file.bytes);
    expect(image?.width).toBe(Math.round((1200 * 150) / 216)); // 833: sharp enough for the 400 pt page
    expect(result.images.downsampled).toBe(1);
  });

  it("keeps flat graphics lossless: Flate with a predictor, nothing blurred", async () => {
    const width = 900;
    const height = 600;
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]); // 216 dpi
    const pixels = rgbOf(graphicPixels(width, height));
    addRawImage(doc, page, { width, height, components: 3, pixels, deflate: false }, { x: 0, y: 0, width: 300, height: 200 });
    const original = await doc.save();

    const result = await run(original, "balanced");
    expect(result.smaller).toBe(true);
    expect(result.file.bytes.length).toBeLessThan(original.length * 0.1);
    const [image] = await imageObjects(result.file.bytes);
    expect(image?.filter).toBe("/FlateDecode"); // not JPEG
    expect(image?.width).toBe(625); // 300 pt at 150 dpi
    // Flat areas stay exactly their palette colour (JPEG would smear them), and the picture is unchanged overall.
    const after = await renderPdfPage(result.file.bytes, 1, 1);
    expect(after.at(30, 100)).toEqual([30, 64, 175]); // the middle of the first (blue) band
    expect(after.at(10, 5)).toEqual([255, 255, 255]); // background
    expect(meanAbsDiff(await renderPdfPage(original, 1, 1), after)).toBeLessThan(4);
  });

  it("recompresses PNG-style (predictor) and uncompressed raw images, and plain grey ones", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const rgba = photoPixels(800, 400, 3);
    addRawImage(doc, page, { width: 800, height: 400, components: 3, pixels: rgbOf(rgba), predictor: true }, { x: 0, y: 150, width: 300, height: 150 });
    const grey = new Uint8Array(600 * 300);
    const next = random(9);
    for (let i = 0; i < grey.length; i += 1) grey[i] = 128 + Math.round(Math.sin((i % 600) / 40) * 60 + (next() - 0.5) * 20);
    addRawImage(doc, page, { width: 600, height: 300, components: 1, pixels: grey, deflate: false }, { x: 0, y: 0, width: 300, height: 150 });
    const original = await doc.save();

    const result = await run(original, "balanced");
    // The RGB picture is 192 dpi and is reduced to 150 dpi; the grey one is already 144 dpi, so it keeps its size.
    expect(result.images).toMatchObject({ total: 2, optimized: 2, downsampled: 1 });
    expect(result.file.bytes.length).toBeLessThan(original.length * 0.25);
    const images = (await imageObjects(result.file.bytes)).sort((a, b) => a.width - b.width);
    expect(images.map((i) => i.width)).toEqual([600, 625]);
    expect(images[0]).toMatchObject({ filter: "/DCTDecode", colorSpace: "/DeviceRGB" }); // grey photo-like data became equal-valued RGB JPEG
    expect(images[1]).toMatchObject({ filter: "/DCTDecode" });
  });

  it("preserves a soft mask, so transparency still works", async () => {
    // RGBA photo whose left half is fully transparent
    const width = 800;
    const height = 600;
    const rgba = photoPixels(width, height, 6);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width / 2; x += 1) rgba[(y * width + x) * 4 + 3] = 0;
    const png = makeImage("png", width, height, drawPixels(rgba), { alpha: true });

    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 150]);
    page.drawRectangle({ x: 0, y: 0, width: 200, height: 150, color: rgb(1, 0, 0) });
    page.drawImage(await doc.embedPng(png), { x: 0, y: 0, width: 200, height: 150 });
    const original = await doc.save();
    expect((await imageObjects(original)).some((i) => i.hasSMask)).toBe(true);

    const result = await run(original, "balanced");
    expect(result.smaller).toBe(true);
    const compressed = await imageObjects(result.file.bytes);
    expect(compressed.some((i) => i.hasSMask)).toBe(true); // the mask is still attached
    const rendered = await renderPdfPage(result.file.bytes, 1, 1);
    const [r, g, b] = rendered.at(40, 75); // transparent half: the red rectangle shows through
    expect(r).toBeGreaterThan(240);
    expect(g).toBeLessThan(20);
    expect(b).toBeLessThan(20);
    const [, pg, pb] = rendered.at(150, 75); // opaque half: the photo, not red
    expect(pg + pb).toBeGreaterThan(60);
    expect(meanAbsDiff(await renderPdfPage(original, 1, 1), rendered)).toBeLessThan(8);
  });

  it("does not touch CMYK, masked or rotated-by-EXIF images, and says so", async () => {
    const jpeg = photoJpeg(1200, 900);
    const doc = await PDFDocument.create();
    const cmyk = await doc.embedJpg(jpeg);
    await cmyk.embed();
    doc.context.lookup(cmyk.ref, PDFStream).dict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceCMYK"));
    doc.addPage([200, 150]).drawImage(cmyk, { x: 0, y: 0, width: 200, height: 150 });
    const turned = await doc.embedJpg(jpeg);
    await turned.embed();
    doc.context.lookup(turned.ref, PDFStream).dict.set(PDFName.of("ImageMask"), PDFBool.True);
    doc.addPage([200, 150]).drawImage(turned, { x: 0, y: 0, width: 200, height: 150 });
    const original = await doc.save();

    const result = await run(original, "balanced");
    // the two XObjects are identical apart from the dictionary entry we changed, so none can be merged
    expect(result.images.optimized).toBe(0);
    expect(result.images.skipped.colour).toBe(1);
    expect(result.images.skipped.mask).toBe(1);
    expect(result.notes.join(" ")).toMatch(/CMYK/);
    for (const image of await imageObjects(result.file.bytes)) expect(image.width).toBe(1200);
  });

  it("skips a JPEG that carries an EXIF rotation tag, because viewers ignore it and decoders do not", async () => {
    const jpeg = withExifOrientation(photoJpeg(1200, 900), 6);
    const result = await run(await jpegPage(jpeg), "balanced");
    expect(result.images.optimized).toBe(0);
    expect(result.images.skipped.orientation).toBe(1);
    expect(result.notes.join(" ")).toMatch(/rotation tag/);
    expect((await imageObjects(result.file.bytes))[0]?.width).toBe(1200);
  });

  it("leaves images that no page paints (and counts them)", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    const unused = await doc.embedJpg(photoJpeg(1000, 800));
    await unused.embed();
    const result = await run(await doc.save(), "balanced");
    expect(result.images.total).toBe(1);
    expect(result.images.skipped.unused).toBe(1);
    expect(result.images.optimized).toBe(0);
  });
});

describe("compressPdf: lossless level", () => {
  it("merges duplicate embedded images and compresses raw streams without changing a pixel", async () => {
    const doc = await PDFDocument.create();
    const jpeg = photoJpeg(400, 300);
    for (let i = 0; i < 3; i += 1) {
      const image = await doc.embedJpg(jpeg); // three separate, identical XObjects
      doc.addPage([200, 150]).drawImage(image, { x: 0, y: 0, width: 200, height: 150 });
    }
    // an uncompressed raw image on a fourth page
    addRawImage(doc, doc.addPage([200, 150]), { width: 200, height: 150, components: 3, pixels: rgbOf(graphicPixels(200, 150)), deflate: false }, { x: 0, y: 0, width: 200, height: 150 });
    const original = await doc.save();
    expect((await imageObjects(original)).length).toBe(4);

    const result = await run(original, "lossless");
    expect(result.smaller).toBe(true);
    expect(result.duplicatesRemoved).toBe(2);
    expect((await imageObjects(result.file.bytes)).length).toBe(2);
    expect(result.file.bytes.length).toBeLessThan(original.length * 0.7);
    expect(result.images.total).toBe(0); // lossless never looks at images
    for (let page = 1; page <= 4; page += 1) {
      expect(meanAbsDiff(await renderPdfPage(original, page, 1), await renderPdfPage(result.file.bytes, page, 1))).toBe(0);
    }
  });

  it("keeps the text, the pages and the page order", async () => {
    const original = await makeTextPdf("Report", 6, [300, 200]);
    const result = await run(original, "lossless");
    expect(result.file.pageCount).toBe(6);
    expect(await pageTexts(result.file.bytes)).toEqual(await pageTexts(original));
  });

  it("returns the original, untouched, when it cannot be made at least 1% smaller", async () => {
    // an incompressible payload: random bytes are already as small as they will get
    const doc = await PDFDocument.create();
    const next = random(5);
    const noise = Uint8Array.from({ length: 150_000 }, () => Math.floor(next() * 256));
    addRawImage(doc, doc.addPage([200, 200]), { width: 250, height: 200, components: 3, pixels: noise }, { x: 0, y: 0, width: 200, height: 200 });
    const original = await doc.save();

    const result = await run(original, "lossless");
    expect(result.smaller).toBe(false);
    expect(result.file.bytes).toEqual(original); // exactly the input
    expect(result.file.name).toBe("doc_compressed.pdf");
    expect(result.notes.join(" ")).toMatch(/already stored compactly/);
  });

  it("never returns a file larger than the input", async () => {
    for (const level of ["lossless", "balanced", "strong"] as const) {
      const original = await makeTextPdf("Tiny", 1);
      const result = await run(original, level);
      expect(result.file.bytes.length).toBeLessThanOrEqual(original.length);
      expect(result.smaller).toBe(result.file.bytes.length < original.length);
    }
  });

  it("drops page thumbnails", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const thumb = doc.context.register(doc.context.stream(new Uint8Array(30_000).map((_, i) => (i * 7919) % 251), { Type: "XObject", Subtype: "Image", Width: 100, Height: 100, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }));
    page.node.set(PDFName.of("Thumb"), thumb);
    const original = await doc.save();
    const result = await run(original, "lossless");
    expect(result.smaller).toBe(true);
    expect((await imageObjects(result.file.bytes)).length).toBe(0);
  });
});

describe("compressPdf: inputs and outputs", () => {
  it("accepts a password-protected PDF, and the result is a normal unprotected file", async () => {
    const source = await jpegPage(photoJpeg(1200, 900));
    const locked = (await protectPdf(input("locked.pdf", source), { userPassword: "s3cret" })).bytes;
    const result = await run(locked, "balanced", "s3cret");
    expect(result.smaller).toBe(true);
    const probe = await probePdf(result.file.bytes);
    expect(probe).toMatchObject({ state: "ok", pageCount: 1, encrypted: false });
  });

  it("asks for the password, and rejects a wrong one", async () => {
    const locked = (await protectPdf(input("locked.pdf", await makeTextPdf("L", 1)), { userPassword: "s3cret" })).bytes;
    await expectAppError(run(locked, "balanced"), "PASSWORD_REQUIRED");
    await expectAppError(run(locked, "balanced", "nope"), "WRONG_PASSWORD");
  });

  it("rejects files that are not PDFs or are damaged, and bad levels", async () => {
    await expectAppError(run(new TextEncoder().encode("hello, this is not a PDF"), "balanced"), "DAMAGED_PDF");
    await expectAppError(run(new Uint8Array(0), "balanced"), "DAMAGED_PDF");
    await expectAppError(compressPdf(input("x.pdf", await makeTextPdf("X", 1)), { level: "extreme" as CompressLevel }), "INVALID_INPUT");
  });

  it("reports steady progress that ends at 1", async () => {
    const seen: number[] = [];
    await compressPdf(input("p.pdf", await jpegPage(photoJpeg(800, 600))), { level: "balanced" }, { onProgress: (fraction) => seen.push(fraction) });
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.at(-1)).toBe(1);
    for (let i = 1; i < seen.length; i += 1) expect(seen[i] as number).toBeGreaterThanOrEqual((seen[i - 1] as number) - 1e-9);
  });

  it("verifies its own output: the result opens and has the same page count", async () => {
    const doc = await PDFDocument.create();
    const jpeg = await doc.embedJpg(photoJpeg(900, 600));
    for (let i = 0; i < 5; i += 1) doc.addPage([300, 200]).drawImage(jpeg, { x: 0, y: 0, width: 300, height: 200 });
    const result = await run(await doc.save(), "balanced");
    expect(result.file.pageCount).toBe(5);
    expect((await PDFDocument.load(result.file.bytes)).getPageCount()).toBe(5);
  });
});
