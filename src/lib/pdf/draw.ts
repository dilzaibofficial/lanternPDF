import { type PDFPage, type RGB, concatTransformationMatrix, popGraphicsState, pushGraphicsState, rgb } from "@cantoo/pdf-lib";
import { AppError } from "../errors";

/** The visible area of a page, as a viewer shows it (after the CropBox and any /Rotate). */
export interface PageFrame {
  /** Position and size of the page box in the PDF's own (unrotated) coordinate system. */
  box: { x: number; y: number; width: number; height: number };
  /** Page rotation in degrees clockwise, normalised to 0, 90, 180 or 270. */
  rotation: 0 | 90 | 180 | 270;
  /** Width and height as the user sees them, i.e. swapped for 90 and 270. */
  displayWidth: number;
  displayHeight: number;
}

export function frameOf(page: PDFPage): PageFrame {
  const box = page.getCropBox();
  const raw = ((Math.round(page.getRotation().angle / 90) * 90) % 360 + 360) % 360;
  const rotation = raw as PageFrame["rotation"];
  const swapped = rotation === 90 || rotation === 270;
  return {
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
    rotation,
    displayWidth: swapped ? box.height : box.width,
    displayHeight: swapped ? box.width : box.height,
  };
}

/**
 * Matrix mapping "display space" (origin at the bottom-left of the page *as shown*, y pointing up,
 * units in points) into the PDF's unrotated user space.
 */
export function displayMatrix(frame: PageFrame): [number, number, number, number, number, number] {
  const { x, y, width: w, height: h } = frame.box;
  switch (frame.rotation) {
    case 90:
      return [0, 1, -1, 0, x + w, y];
    case 180:
      return [-1, 0, 0, -1, x + w, y + h];
    case 270:
      return [0, -1, 1, 0, x, y + h];
    default:
      return [1, 0, 0, 1, x, y];
  }
}

/**
 * Runs `draw` with the page's coordinate system set up so that (0, 0) is the bottom-left corner of what
 * the viewer displays, whatever the page's rotation or box offset. Everything drawn inside is upright
 * and positioned as the user sees it. The graphics state is restored afterwards.
 */
export function inDisplaySpace(page: PDFPage, draw: (frame: PageFrame) => void): void {
  const frame = frameOf(page);
  const [a, b, c, d, e, f] = displayMatrix(frame);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(a, b, c, d, e, f));
  try {
    draw(frame);
  } finally {
    page.pushOperators(popGraphicsState());
  }
}

/** Maps a point (and size) from display space to the user-space rectangle that contains it. */
export function displayRectToUser(frame: PageFrame, rect: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
  const [a, b, c, d, e, f] = displayMatrix(frame);
  const map = (px: number, py: number) => ({ x: a * px + c * py + e, y: b * px + d * py + f });
  const p1 = map(rect.x, rect.y);
  const p2 = map(rect.x + rect.width, rect.y + rect.height);
  return { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), width: Math.abs(p2.x - p1.x), height: Math.abs(p2.y - p1.y) };
}

/** After drawing, moves the page's newest content stream behind the existing content. */
export function sendNewContentToBack(page: PDFPage): void {
  const contents = page.node.Contents();
  // `Contents` is always an array once pdf-lib has drawn on the page (it normalises it).
  if (!contents || !("size" in contents) || typeof (contents as { size: unknown }).size !== "function") return;
  const array = contents as unknown as { size(): number; get(index: number): unknown; remove(index: number): void; insert(index: number, value: unknown): void };
  const last = array.size() - 1;
  if (last < 1) return;
  const ours = array.get(last);
  array.remove(last);
  array.insert(0, ours);
}

/** "#rrggbb" (or "#rgb") to a pdf-lib colour. */
export function parseColor(value: string): RGB {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) throw new AppError("INVALID_INPUT", `“${value}” is not a valid colour. Use a hex value such as #1a2b3c.`);
  const hex = (match[1] as string).length === 3 ? [...(match[1] as string)].map((ch) => ch + ch).join("") : (match[1] as string);
  return rgb(Number.parseInt(hex.slice(0, 2), 16) / 255, Number.parseInt(hex.slice(2, 4), 16) / 255, Number.parseInt(hex.slice(4, 6), 16) / 255);
}
