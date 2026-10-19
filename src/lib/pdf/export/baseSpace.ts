import { type PDFPage, concatTransformationMatrix, popGraphicsState, pushGraphicsState } from "@cantoo/pdf-lib";
import { type PageFrame, displayMatrix, frameOf } from "../draw";
import type { Rotation } from "../types";

/**
 * The editor places everything in **base space**: the page as it was first displayed, before the editor turned it,
 * origin at the top-left, y down, one unit one point. When a file is exported the editor's turns have already been
 * written into the page's `/Rotate`, so base space is the displayed page *un-turned* by that much.
 */

export function baseFrame(page: PDFPage, editorRotation: Rotation): PageFrame {
  const shown = frameOf(page);
  const rotation = ((((shown.rotation - editorRotation) % 360) + 360) % 360) as PageFrame["rotation"];
  const swapped = rotation === 90 || rotation === 270;
  return { box: shown.box, rotation, displayWidth: swapped ? shown.box.height : shown.box.width, displayHeight: swapped ? shown.box.width : shown.box.height };
}

/** Matrix from base space (y down) into the PDF's own space for a frame. */
export function baseToUser(frame: PageFrame): [number, number, number, number, number, number] {
  const [a, b, c, d, e, f] = displayMatrix(frame);
  // base (x, y down) -> display-up (x, H - y) -> user
  return [a, b, -c, -d, c * frame.displayHeight + e, d * frame.displayHeight + f];
}

export function toUser(frame: PageFrame, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = baseToUser(frame);
  return [a * x + c * y + e, b * x + d * y + f];
}

/** Runs `draw` with coordinates in display space of `frame` (origin bottom-left, y up, as the viewer shows that orientation). */
export function inFrame(page: PDFPage, frame: PageFrame, draw: () => void): void {
  const [a, b, c, d, e, f] = displayMatrix(frame);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(a, b, c, d, e, f));
  try {
    draw();
  } finally {
    page.pushOperators(popGraphicsState());
  }
}
