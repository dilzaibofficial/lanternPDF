import { PDFDocument, type PDFPage, PDFName, type PDFRef, StandardFonts, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState } from "@cantoo/pdf-lib";
import { zlibSync } from "fflate";
import { type RenderedPage, makeImage } from "./images";

/** Deterministic pseudo-random numbers, so fixtures are the same on every run. */
export function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** RGBA pixels of a smooth photograph-like picture: gradients, soft shapes and fine noise. */
export function photoPixels(width: number, height: number, seed = 1): Uint8ClampedArray {
  const next = random(seed);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = x / width;
      const v = y / height;
      const i = (y * width + x) * 4;
      const wave = Math.sin(u * 9) * Math.cos(v * 7);
      const noise = (next() - 0.5) * 14;
      out[i] = 128 + 90 * Math.sin(u * 5 + v * 2) + 25 * wave + noise;
      out[i + 1] = 120 + 80 * Math.cos(v * 4 - u) + 25 * wave + noise;
      out[i + 2] = 110 + 70 * Math.sin((u + v) * 3) - 25 * wave + noise;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** A flat-colour picture (few tones), like a chart or a screenshot of a form. */
export function graphicPixels(width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  const palette = [
    [255, 255, 255],
    [30, 64, 175],
    [220, 38, 38],
    [22, 163, 74],
    [250, 204, 21],
  ] as const;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const band = Math.floor((x / width) * 5) % 5;
      const inside = Math.abs(y / height - 0.5) < 0.2 + 0.1 * Math.sin((x / width) * 10);
      const colour = palette[inside ? (band + 1) % 5 : 0] as readonly [number, number, number];
      const i = (y * width + x) * 4;
      out[i] = colour[0];
      out[i + 1] = colour[1];
      out[i + 2] = colour[2];
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Draws RGBA pixels with the canvas library, for use with `makeImage`'s draw callback. */
export const drawPixels =
  (pixels: Uint8ClampedArray) =>
  (context: { createImageData(w: number, h: number): { data: Uint8ClampedArray }; putImageData(data: never, x: number, y: number): void }, width: number, height: number) => {
    const target = context.createImageData(width, height);
    target.data.set(pixels);
    context.putImageData(target as never, 0, 0);
  };

/** A JPEG of a smooth photograph-like picture (high quality, so there is plenty to compress). */
export const photoJpeg = (width: number, height: number, seed = 1): Uint8Array => makeImage("jpeg", width, height, drawPixels(photoPixels(width, height, seed)));

/** One page with a JPEG painted over all of it, plus an optional line of text on top. */
export async function jpegPage(jpeg: Uint8Array, pageWidth = 200, pageHeight = 150, label?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([pageWidth, pageHeight]);
  page.drawImage(await doc.embedJpg(jpeg), { x: 0, y: 0, width: pageWidth, height: pageHeight });
  if (label) page.drawText(label, { x: 12, y: pageHeight - 30, size: 18, font: await doc.embedFont(StandardFonts.HelveticaBold) });
  return doc.save();
}

export interface RawImage {
  width: number;
  height: number;
  components: 1 | 3;
  /** `components` bytes per pixel, row by row. */
  pixels: Uint8Array;
  /** Flate-compress the data (default true). */
  deflate?: boolean;
  /** Store with PNG "Sub" row filters and /Predictor 15, as PNG-derived images are. */
  predictor?: boolean;
  /** Replace the colour space entry (for building unsupported cases). */
  colorSpace?: string;
}

/** Adds an image XObject straight from raw samples and paints it at `at` (in points). Returns its reference. */
export function addRawImage(doc: PDFDocument, page: PDFPage, image: RawImage, at: { x: number; y: number; width: number; height: number }, name = `Raw${Math.floor(Math.random() * 1e9)}`): PDFRef {
  let data = image.pixels;
  const dict: Record<string, unknown> = {
    Type: "XObject",
    Subtype: "Image",
    Width: image.width,
    Height: image.height,
    ColorSpace: image.colorSpace ?? (image.components === 1 ? "DeviceGray" : "DeviceRGB"),
    BitsPerComponent: 8,
  };
  if (image.predictor) {
    const rowBytes = image.width * image.components;
    const filtered = new Uint8Array((rowBytes + 1) * image.height);
    for (let r = 0; r < image.height; r += 1) {
      filtered[r * (rowBytes + 1)] = 1; // Sub
      for (let i = 0; i < rowBytes; i += 1) {
        const left = i >= image.components ? (image.pixels[r * rowBytes + i - image.components] as number) : 0;
        filtered[r * (rowBytes + 1) + 1 + i] = ((image.pixels[r * rowBytes + i] as number) - left) & 255;
      }
    }
    data = filtered;
    dict.DecodeParms = { Predictor: 15, Colors: image.components, BitsPerComponent: 8, Columns: image.width };
  }
  if (image.deflate !== false) {
    data = zlibSync(data, { level: 6 });
    dict.Filter = "FlateDecode";
  }
  const ref = doc.context.register(doc.context.stream(data, dict as never));
  page.node.setXObject(PDFName.of(name), ref);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(at.width, 0, 0, at.height, at.x, at.y), drawObject(name), popGraphicsState());
  return ref;
}

/** RGB bytes from RGBA pixels. */
export function rgbOf(rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array((rgba.length / 4) * 3);
  for (let p = 0; p < rgba.length / 4; p += 1) {
    out[p * 3] = rgba[p * 4] as number;
    out[p * 3 + 1] = rgba[p * 4 + 1] as number;
    out[p * 3 + 2] = rgba[p * 4 + 2] as number;
  }
  return out;
}

/** Mean absolute difference per colour channel between two equally sized renders, 0 (identical) to 255. */
export function meanAbsDiff(a: RenderedPage, b: RenderedPage): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`renders differ in size: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  let total = 0;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const p = a.at(x, y);
      const q = b.at(x, y);
      total += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
    }
  }
  return total / (a.width * a.height * 3);
}

/** The image XObjects of a PDF as `{ width, height, filter }`, largest data first, for inspecting what compression did. */
export async function imageObjects(bytes: Uint8Array): Promise<{ ref: string; width: number; height: number; filter: string; colorSpace: string; length: number; hasSMask: boolean }[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const found: { ref: string; width: number; height: number; filter: string; colorSpace: string; length: number; hasSMask: boolean }[] = [];
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    const dict = (object as { dict?: { get(key: PDFName): unknown; has(key: PDFName): boolean } }).dict;
    if (!dict || String(dict.get(PDFName.of("Subtype"))) !== "/Image") continue;
    found.push({
      ref: ref.toString(),
      width: Number(String(dict.get(PDFName.of("Width")))),
      height: Number(String(dict.get(PDFName.of("Height")))),
      filter: String(dict.get(PDFName.of("Filter")) ?? ""),
      colorSpace: String(dict.get(PDFName.of("ColorSpace")) ?? ""),
      length: (object as unknown as { contents: Uint8Array }).contents.length,
      hasSMask: dict.has(PDFName.of("SMask")),
    });
  }
  return found.sort((a, b) => b.length - a.length);
}
