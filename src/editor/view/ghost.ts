import type { Box, OrientedPlacement } from "../model/types";

/**
 * Moving, resizing or removing something the page already draws is shown at once by lifting it off the page: the pixels
 * it covers are copied from the canvas, the place they leave is painted over with the colour around it, and the copy is
 * drawn where the object now is. A moment later the page is redrawn for real with the change made in the file, and the
 * lifted copy is dropped. Nothing here changes the file; it only hides the time the real redraw takes.
 */

export interface Ghost {
  /** The object it was lifted from. */
  id: string;
  /** A picture (data URL) of the area the object covered, as the canvas showed it. */
  url: string;
  /** Where that area is, in base points. */
  area: Box;
  /** Where the object was when it was lifted: the picture belongs to this placement. */
  from: OrientedPlacement;
  /** The colour painted over the area it left. */
  patch: string;
}

const hex = (value: number) => Math.round(value).toString(16).padStart(2, "0");

/**
 * The colour just outside a region: the most common one among points on a ring around it, as #rrggbb. `scratch` holds the
 * region with a margin around it; `x`, `y`, `w`, `h` say where the region is inside it.
 */
function surroundingColour(scratch: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): string {
  const { width, height } = scratch.canvas;
  const data = scratch.getImageData(0, 0, width, height);
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  const sample = (px: number, py: number) => {
    const cx = Math.min(width - 1, Math.max(0, Math.round(px)));
    const cy = Math.min(height - 1, Math.max(0, Math.round(py)));
    const at = (cy * width + cx) * 4;
    const [r, g, b, a] = [data.data[at] as number, data.data[at + 1] as number, data.data[at + 2] as number, data.data[at + 3] as number];
    // Where nothing is drawn the paper shows through: white.
    const [pr, pg, pb] = a < 128 ? [255, 255, 255] : [r, g, b];
    const key = ((pr >> 3) << 10) | ((pg >> 3) << 5) | (pb >> 3);
    const entry = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    entry.n += 1;
    entry.r += pr;
    entry.g += pg;
    entry.b += pb;
    counts.set(key, entry);
  };
  const steps = 14;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    sample(x + t * w, y - 2);
    sample(x + t * w, y + h + 2);
    sample(x - 2, y + t * h);
    sample(x + w + 2, y + t * h);
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const entry of counts.values()) if (!best || entry.n > best.n) best = entry;
  return best ? `#${hex(best.r / best.n)}${hex(best.g / best.n)}${hex(best.b / best.n)}` : "#ffffff";
}

/** Copies the part of the canvas an object covers. Null when the canvas has nothing drawn yet. */
export function lift(canvas: HTMLCanvasElement | null, page: { width: number; height: number }, id: string, from: OrientedPlacement, bounds: Box): Ghost | null {
  if (!canvas || canvas.width < 2 || canvas.height < 2) return null;
  const sx = canvas.width / page.width;
  const sy = canvas.height / page.height;
  const pad = 2;
  const margin = 3;
  const x = Math.max(0, Math.floor((bounds.x - pad) * sx));
  const y = Math.max(0, Math.floor((bounds.y - pad) * sy));
  const w = Math.min(canvas.width - x, Math.ceil((bounds.width + 2 * pad) * sx));
  const h = Math.min(canvas.height - y, Math.ceil((bounds.height + 2 * pad) * sy));
  if (w < 1 || h < 1 || w * h > 16_000_000) return null;
  // The region and a margin go into a scratch canvas made for reading back, so the page's own canvas is never read.
  const left = Math.max(0, x - margin);
  const top = Math.max(0, y - margin);
  const scratch = document.createElement("canvas");
  scratch.width = Math.min(canvas.width, x + w + margin) - left;
  scratch.height = Math.min(canvas.height, y + h + margin) - top;
  const reader = scratch.getContext("2d", { willReadFrequently: true });
  if (!reader) return null;
  reader.drawImage(canvas, left, top, scratch.width, scratch.height, 0, 0, scratch.width, scratch.height);
  const patch = surroundingColour(reader, x - left, y - top, w, h);
  const copy = document.createElement("canvas");
  copy.width = w;
  copy.height = h;
  copy.getContext("2d")?.drawImage(scratch, x - left, y - top, w, h, 0, 0, w, h);
  const url = copy.toDataURL("image/png");
  copy.width = 0;
  copy.height = 0;
  scratch.width = 0;
  scratch.height = 0;
  return { id, url, area: { x: x / sx, y: y / sy, width: w / sx, height: h / sy }, from, patch };
}

/** The SVG transform that carries what was lifted from its old placement onto the new one. */
export function ghostTransform(from: OrientedPlacement, to: OrientedPlacement): string {
  const fromX = from.x + from.width / 2;
  const fromY = from.y + from.height / 2;
  const toX = to.x + to.width / 2;
  const toY = to.y + to.height / 2;
  const sx = to.width / Math.max(1e-6, from.width);
  const sy = to.height / Math.max(1e-6, from.height);
  return `translate(${toX} ${toY}) rotate(${to.rotation}) scale(${sx} ${sy}) rotate(${-from.rotation}) translate(${-fromX} ${-fromY})`;
}
