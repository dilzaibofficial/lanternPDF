import { type PageFrame, displayMatrix } from "../draw";
import { type Matrix, type Rect, apply, applyVector, invert, multiply } from "./matrix";

/**
 * Display space is what the editor works in: points, origin at the top-left corner of the page as it is shown (after
 * the CropBox and any /Rotate), y pointing down. User space is the PDF's own (y up, unrotated). These helpers convert
 * between them for one page.
 */

export interface DisplayBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A box turned about its centre: `x`, `y`, `width`, `height` describe it before the turn, `rotation` is in degrees clockwise on screen. */
export interface OrientedBox extends DisplayBox {
  rotation: number;
}

/** The matrix that maps display space (y down) to user space. */
export function displayToUserMatrix(frame: PageFrame): Matrix {
  return multiply([1, 0, 0, -1, 0, frame.displayHeight], displayMatrix(frame) as Matrix);
}

/** Converts points of the PDF's user space to display space. */
export function userToDisplay(frame: PageFrame): (x: number, y: number) => [number, number] {
  const inverse = invert(displayToUserMatrix(frame)) as Matrix;
  return (x, y) => apply(inverse, x, y);
}

/** The reverse of `userToDisplay`. */
export function displayToUser(frame: PageFrame): (x: number, y: number) => [number, number] {
  const matrix = displayToUserMatrix(frame);
  return (x, y) => apply(matrix, x, y);
}

/** The display-space bounds of a rectangle given in user space. */
export function boxToDisplay(frame: PageFrame, rect: Rect): DisplayBox {
  const map = userToDisplay(frame);
  const corners = [map(rect.x, rect.y), map(rect.x + rect.width, rect.y), map(rect.x, rect.y + rect.height), map(rect.x + rect.width, rect.y + rect.height)];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** The user-space rectangle that bounds a display-space box. */
export function userRectOf(frame: PageFrame, box: DisplayBox): Rect {
  const map = displayToUser(frame);
  const corners = [map(box.x, box.y), map(box.x + box.width, box.y), map(box.x, box.y + box.height), map(box.x + box.width, box.y + box.height)];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/** Degrees clockwise on screen for a direction given in user space. */
export function screenAngle(frame: PageFrame, dx: number, dy: number): number {
  const inverse = invert(displayToUserMatrix(frame)) as Matrix;
  const [vx, vy] = applyVector(inverse, dx, dy);
  return (Math.atan2(vy, vx) * 180) / Math.PI;
}

// ---- boxes and the transform between two of them ---------------------------------------------------------------------------

const RAD = Math.PI / 180;

/** Turns by `degrees` clockwise on screen about the origin (display space has y pointing down). */
export function turn(degrees: number): Matrix {
  const c = Math.cos(degrees * RAD);
  const s = Math.sin(degrees * RAD);
  return [c, s, -s, c, 0, 0];
}

export const centreOfBox = (box: DisplayBox): [number, number] => [box.x + box.width / 2, box.y + box.height / 2];

/**
 * The transform (in display space) that carries `from` onto `to`: turn it back upright, size it, turn it to its new angle
 * and put its centre at the new centre. Returns null when `from` has no size.
 */
export function boxTransform(from: OrientedBox, to: OrientedBox): Matrix | null {
  if (from.width < 1e-9 || from.height < 1e-9) return null;
  const [cx0, cy0] = centreOfBox(from);
  const [cx1, cy1] = centreOfBox(to);
  const scale: Matrix = [to.width / from.width, 0, 0, to.height / from.height, 0, 0];
  let m: Matrix = [1, 0, 0, 1, -cx0, -cy0];
  m = multiply(m, turn(-from.rotation));
  m = multiply(m, scale);
  m = multiply(m, turn(to.rotation));
  return multiply(m, [1, 0, 0, 1, cx1, cy1]);
}

/** Conjugates a display-space transform into user space. */
export function toUserTransform(frame: PageFrame, displayTransform: Matrix): Matrix | null {
  const forward = displayToUserMatrix(frame);
  const back = invert(forward);
  if (!back) return null;
  return multiply(multiply(back, displayTransform), forward);
}

/**
 * The oriented box of something drawn with `matrix` (the image of the unit square), in display space. A placement that is
 * turned or flipped keeps its angle; one that is sheared falls back to the bounds of the parallelogram.
 */
export function orientedBoxOf(frame: PageFrame, matrix: Matrix): OrientedBox {
  const map = userToDisplay(frame);
  const p0 = map(matrix[4], matrix[5]);
  const p1 = map(matrix[0] + matrix[4], matrix[1] + matrix[5]);
  const p2 = map(matrix[2] + matrix[4], matrix[3] + matrix[5]);
  const wx = p1[0] - p0[0];
  const wy = p1[1] - p0[1];
  const hx = p2[0] - p0[0];
  const hy = p2[1] - p0[1];
  const width = Math.hypot(wx, wy);
  const height = Math.hypot(hx, hy);
  if (width > 1e-9 && height > 1e-9 && Math.abs(wx * hx + wy * hy) <= 0.02 * width * height) {
    const cx = p0[0] + (wx + hx) / 2;
    const cy = p0[1] + (wy + hy) / 2;
    let rotation = (Math.atan2(wy, wx) * 180) / Math.PI;
    if (Math.abs(rotation) < 1e-6) rotation = 0;
    return { x: cx - width / 2, y: cy - height / 2, width, height, rotation };
  }
  const xs = [p0[0], p1[0], p2[0], p1[0] + hx];
  const ys = [p0[1], p1[1], p2[1], p1[1] + hy];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, rotation: 0 };
}

/** The axis-aligned bounds of an oriented box. */
export function boundsOfOriented(box: OrientedBox): DisplayBox {
  if (box.rotation === 0) return { x: box.x, y: box.y, width: box.width, height: box.height };
  const [cx, cy] = centreOfBox(box);
  const c = Math.cos(box.rotation * RAD);
  const s = Math.sin(box.rotation * RAD);
  const hw = box.width / 2;
  const hh = box.height / 2;
  const ex = Math.abs(hw * c) + Math.abs(hh * s);
  const ey = Math.abs(hw * s) + Math.abs(hh * c);
  return { x: cx - ex, y: cy - ey, width: ex * 2, height: ey * 2 };
}
