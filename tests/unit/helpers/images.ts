import { resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { ImageCodec, RasterImage } from "../../../src/lib/pdf/codec";

type Draw = (context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>, width: number, height: number) => void;

const halves: Draw = (context, width, height) => {
  context.fillStyle = "#ff0000";
  context.fillRect(0, 0, width / 2, height);
  context.fillStyle = "#0000ff";
  context.fillRect(width / 2, 0, width / 2, height);
};

/** A test image: by default the left half is red and the right half is blue. */
export function makeImage(format: "png" | "jpeg" | "webp" | "avif", width = 40, height = 20, draw: Draw = halves, options: { alpha?: boolean } = {}): Uint8Array {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  if (options.alpha) context.clearRect(0, 0, width, height);
  draw(context, width, height);
  const mime = `image/${format}` as const;
  return new Uint8Array(format === "png" ? canvas.toBuffer("image/png") : canvas.toBuffer(mime as "image/jpeg", format === "avif" ? 60 : 92));
}

/** A solid-colour 24-bit BMP, written by hand (no library encodes BMP). */
export function makeBmp(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + rowSize * height;
  const buffer = Buffer.alloc(size);
  buffer.write("BM", 0);
  buffer.writeUInt32LE(size, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(rowSize * height, 34);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = 54 + y * rowSize + x * 3;
      buffer[at] = rgb[2];
      buffer[at + 1] = rgb[1];
      buffer[at + 2] = rgb[0];
    }
  }
  return new Uint8Array(buffer);
}

/** Inserts an EXIF APP1 segment carrying an orientation tag (1 to 8) right after the JPEG's SOI marker. */
export function withExifOrientation(jpeg: Uint8Array, orientation: number, bigEndian = false): Uint8Array {
  const tiff = bigEndian
    ? Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0])
    : Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const segment = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  return new Uint8Array(Buffer.concat([Buffer.from(jpeg.subarray(0, 2)), segment, Buffer.from(jpeg.subarray(2))]));
}

/** The image codec for Node tests. @napi-rs/canvas applies EXIF orientation when decoding, like browsers do. */
export const nodeCodec: ImageCodec = {
  async decode(bytes): Promise<RasterImage> {
    const image = await loadImage(Buffer.from(bytes));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height);
    return { width: data.width, height: data.height, rgba: new Uint8ClampedArray(data.data) };
  },
  async encode(image, format, quality = 0.92) {
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    const target = context.createImageData(image.width, image.height);
    target.data.set(image.rgba);
    context.putImageData(target, 0, 0);
    return new Uint8Array(format === "png" ? canvas.toBuffer("image/png") : canvas.toBuffer("image/jpeg", Math.round(quality * 100)));
  },
};

export interface RenderedPage {
  width: number;
  height: number;
  /** RGB at pixel (x, y). */
  at(x: number, y: number): [number, number, number];
}

// Without the standard font files pdf.js substitutes some system font for Helvetica/Times/Courier, whose
// glyph widths differ from the PDF's own metrics. Using the real ones keeps text geometry faithful.
const STANDARD_FONTS = `${resolve(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts").replaceAll("\\", "/")}/`;

/** Renders a PDF page with pdf.js (an independent renderer) so tests can look at real pixels. */
export async function renderPdfPage(bytes: Uint8Array, pageNumber = 1, scale = 1): Promise<RenderedPage> {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, standardFontDataUrl: STANDARD_FONTS });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport, background: "#ffffff" }).promise;
    const context = canvas.getContext("2d");
    const data = context.getImageData(0, 0, canvas.width, canvas.height);
    return {
      width: canvas.width,
      height: canvas.height,
      at: (x, y) => {
        const i = (Math.min(canvas.height - 1, Math.max(0, Math.floor(y))) * canvas.width + Math.min(canvas.width - 1, Math.max(0, Math.floor(x)))) * 4;
        return [data.data[i] as number, data.data[i + 1] as number, data.data[i + 2] as number];
      },
    };
  } finally {
    await task.destroy();
  }
}

export interface InkBounds {
  count: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Bounding box of the pixels that are not `background` (white by default). `count` is 0 when there are none. */
export function inkBounds(page: RenderedPage, background: (rgb: [number, number, number]) => boolean = isWhite, region?: { x0: number; y0: number; x1: number; y1: number }): InkBounds {
  const bounds: InkBounds = { count: 0, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  const { x0, y0, x1, y1 } = region ?? { x0: 0, y0: 0, x1: page.width, y1: page.height };
  for (let y = Math.floor(y0); y < Math.min(page.height, Math.ceil(y1)); y += 1) {
    for (let x = Math.floor(x0); x < Math.min(page.width, Math.ceil(x1)); x += 1) {
      if (background(page.at(x, y))) continue;
      bounds.count += 1;
      bounds.minX = Math.min(bounds.minX, x);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxY = Math.max(bounds.maxY, y);
    }
  }
  return bounds;
}

/** Where the "mass" of the ink sits inside its bounding box: 0..1 from the left/top. Shows glyph orientation. */
export function inkCentroid(page: RenderedPage, background: (rgb: [number, number, number]) => boolean = isWhite): { fx: number; fy: number } {
  const bounds = inkBounds(page, background);
  let sumX = 0;
  let sumY = 0;
  let weight = 0;
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const [r, g, b] = page.at(x, y);
      const ink = 255 - (r + g + b) / 3;
      sumX += x * ink;
      sumY += y * ink;
      weight += ink;
    }
  }
  return {
    fx: (sumX / weight - bounds.minX) / Math.max(1, bounds.maxX - bounds.minX),
    fy: (sumY / weight - bounds.minY) / Math.max(1, bounds.maxY - bounds.minY),
  };
}

export const isRed = ([r, g, b]: [number, number, number]) => r > 200 && g < 60 && b < 60;
export const isBlue = ([r, g, b]: [number, number, number]) => b > 200 && r < 60 && g < 60;
export const isWhite = ([r, g, b]: [number, number, number]) => r > 245 && g > 245 && b > 245;
