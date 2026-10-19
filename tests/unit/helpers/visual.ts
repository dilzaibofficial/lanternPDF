import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * Visual regression helpers: render PDF pages with pdf.js (an independent renderer), compare them pixel by pixel,
 * and write before / after / difference images next to the test results when a comparison fails, so the failure
 * can be looked at rather than guessed at.
 */

export interface Raster {
  width: number;
  height: number;
  /** RGBA, row by row. */
  data: Uint8ClampedArray;
  scale: number;
  /** Page height in points, to turn a user-space y into a pixel row. */
  pageHeight: number;
}

export interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const STANDARD_FONTS = `${resolve(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts").replaceAll("\\", "/")}/`;

export async function rasterize(bytes: Uint8Array, pageNumber = 1, scale = 2): Promise<Raster> {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, standardFontDataUrl: STANDARD_FONTS });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport, background: "#ffffff" }).promise;
    const context = canvas.getContext("2d");
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height, data: new Uint8ClampedArray(image.data), scale, pageHeight: viewport.height / scale };
  } finally {
    await task.destroy();
  }
}

/** A rectangle in user space (points, y up) as a pixel region of an unrotated page with its origin at (0, 0). */
export function regionOf(raster: Raster, box: { x: number; y: number; width: number; height: number }, padding = 3): Region {
  const s = raster.scale;
  return {
    x0: Math.max(0, Math.floor(box.x * s - padding)),
    x1: Math.min(raster.width, Math.ceil((box.x + box.width) * s + padding)),
    y0: Math.max(0, Math.floor((raster.pageHeight - (box.y + box.height)) * s - padding)),
    y1: Math.min(raster.height, Math.ceil((raster.pageHeight - box.y) * s + padding)),
  };
}

export const unionRegion = (a: Region, b: Region): Region => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

export interface Difference {
  /** Pixels whose colour differs by more than the threshold in any channel. */
  changed: number;
  total: number;
  bounds: Region | null;
  /** Largest per-channel difference seen. */
  maxDelta: number;
}

const inside = (x: number, y: number, regions: readonly Region[]) => regions.some((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1);

/** Compares two renders of the same size, ignoring `ignore` regions. */
export function difference(a: Raster, b: Raster, options: { threshold?: number; ignore?: readonly Region[]; only?: Region } = {}): Difference {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`renders differ in size: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  const threshold = options.threshold ?? 24;
  const ignore = options.ignore ?? [];
  const area = options.only ?? { x0: 0, y0: 0, x1: a.width, y1: a.height };
  let changed = 0;
  let total = 0;
  let maxDelta = 0;
  const bounds: Region = { x0: Number.POSITIVE_INFINITY, y0: Number.POSITIVE_INFINITY, x1: -1, y1: -1 };
  for (let y = area.y0; y < area.y1; y += 1) {
    for (let x = area.x0; x < area.x1; x += 1) {
      if (inside(x, y, ignore)) continue;
      total += 1;
      const i = (y * a.width + x) * 4;
      const delta = Math.max(Math.abs((a.data[i] as number) - (b.data[i] as number)), Math.abs((a.data[i + 1] as number) - (b.data[i + 1] as number)), Math.abs((a.data[i + 2] as number) - (b.data[i + 2] as number)));
      if (delta > maxDelta) maxDelta = delta;
      if (delta > threshold) {
        changed += 1;
        bounds.x0 = Math.min(bounds.x0, x);
        bounds.y0 = Math.min(bounds.y0, y);
        bounds.x1 = Math.max(bounds.x1, x + 1);
        bounds.y1 = Math.max(bounds.y1, y + 1);
      }
    }
  }
  return { changed, total, bounds: changed > 0 ? bounds : null, maxDelta };
}

function toPng(raster: Raster): Buffer {
  const canvas = createCanvas(raster.width, raster.height);
  const context = canvas.getContext("2d");
  const image = context.createImageData(raster.width, raster.height);
  image.data.set(raster.data);
  context.putImageData(image, 0, 0);
  return canvas.toBuffer("image/png");
}

/** Writes before, after and a red-on-white difference image to test-results/visual and returns the folder. */
export function saveComparison(name: string, before: Raster, after: Raster, ignore: readonly Region[] = []): string {
  const directory = resolve(process.cwd(), "test-results", "visual");
  mkdirSync(directory, { recursive: true });
  const safe = name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  writeFileSync(resolve(directory, `${safe}-before.png`), toPng(before));
  writeFileSync(resolve(directory, `${safe}-after.png`), toPng(after));
  const diff: Raster = { ...after, data: new Uint8ClampedArray(after.data.length) };
  for (let y = 0; y < after.height; y += 1) {
    for (let x = 0; x < after.width; x += 1) {
      const i = (y * after.width + x) * 4;
      const delta = Math.max(Math.abs((before.data[i] as number) - (after.data[i] as number)), Math.abs((before.data[i + 1] as number) - (after.data[i + 1] as number)), Math.abs((before.data[i + 2] as number) - (after.data[i + 2] as number)));
      const ignored = inside(x, y, ignore);
      diff.data[i] = delta > 24 ? 220 : ignored ? 230 : 255;
      diff.data[i + 1] = delta > 24 ? 30 : ignored ? 240 : 255;
      diff.data[i + 2] = delta > 24 ? 30 : ignored ? 255 : 255;
      diff.data[i + 3] = 255;
    }
  }
  writeFileSync(resolve(directory, `${safe}-diff.png`), toPng(diff));
  return directory;
}

/**
 * Asserts the render changed only where the edit was: nothing outside `edited` differs, and something inside does.
 * On failure the three images are saved and the folder is named in the error.
 */
export function expectEditedOnlyIn(name: string, before: Raster, after: Raster, edited: readonly Region[], options: { mustChange?: boolean } = {}): void {
  const outside = difference(before, after, { ignore: edited });
  const inside = edited.map((region) => difference(before, after, { only: region }));
  const visible = inside.some((d) => d.changed > 0);
  if (outside.changed > 0 || (options.mustChange !== false && !visible)) {
    const folder = saveComparison(name, before, after, edited);
    throw new Error(`${name}: ${outside.changed} pixels changed outside the edited area${outside.bounds ? ` (around ${JSON.stringify(outside.bounds)})` : ""}, ${visible ? "edit visible" : "edit NOT visible"}. Images saved in ${folder}`);
  }
}
