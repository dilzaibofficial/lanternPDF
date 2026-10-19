/**
 * Affine matrices in PDF's row-vector convention: a point (x, y) maps to (a·x + c·y + e, b·x + d·y + f), and
 * "apply m first, then n" is `multiply(m, n)`. Shared by the content-stream interpreters.
 */

export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Applies `m` first and then `n`. A `cm` operator with operand `m` is `multiply(m, ctm)`. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

export function translation(tx: number, ty: number): Matrix {
  return [1, 0, 0, 1, tx, ty];
}

export function scaling(sx: number, sy: number): Matrix {
  return [sx, 0, 0, sy, 0, 0];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Applies only the linear part (no translation): for directions and sizes. */
export function applyVector(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
}

export function determinant(m: Matrix): number {
  return m[0] * m[3] - m[1] * m[2];
}

/** The inverse, or `null` when the matrix collapses space (determinant ~ 0), as a degenerate `cm` can. */
export function invert(m: Matrix): Matrix | null {
  const det = determinant(m);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)];
}

/** The lengths of the matrix's two unit vectors: how large a 1x1 square becomes. */
export function unitSquareSize(m: Matrix): { width: number; height: number } {
  return { width: Math.hypot(m[0], m[1]), height: Math.hypot(m[2], m[3]) };
}

/** Rotation of the x axis in degrees counter-clockwise (PDF's y axis points up), in (-180, 180]. */
export function rotationOf(m: Matrix): number {
  return (Math.atan2(m[1], m[0]) * 180) / Math.PI;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The axis-aligned rectangle enclosing the image of `rect` under `m`. */
export function transformRect(m: Matrix, rect: Rect): Rect {
  const corners = [
    apply(m, rect.x, rect.y),
    apply(m, rect.x + rect.width, rect.y),
    apply(m, rect.x, rect.y + rect.height),
    apply(m, rect.x + rect.width, rect.y + rect.height),
  ];
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let left = Number.POSITIVE_INFINITY;
  let bottom = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    left = Math.min(left, r.x);
    bottom = Math.min(bottom, r.y);
    right = Math.max(right, r.x + r.width);
    top = Math.max(top, r.y + r.height);
  }
  return { x: left, y: bottom, width: right - left, height: top - bottom };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Area of the overlap of two rectangles (0 when they do not overlap). */
export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function isFiniteMatrix(m: Matrix): boolean {
  return m.every((value) => Number.isFinite(value));
}
