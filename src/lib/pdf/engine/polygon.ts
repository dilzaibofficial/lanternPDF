/** Small convex-polygon helpers (points are `[x, y]`), used to decide what lies under a redaction box. */

export type Point = readonly [number, number];
export type Polygon = readonly Point[];

/** Signed area (positive when the points run counter-clockwise in a y-up plane). */
export function signedArea(polygon: Polygon): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const [x1, y1] = polygon[i] as Point;
    const [x2, y2] = polygon[(i + 1) % polygon.length] as Point;
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

export const area = (polygon: Polygon): number => Math.abs(signedArea(polygon));

/** The polygon with its points in counter-clockwise order. */
export function counterClockwise(polygon: Polygon): Polygon {
  return signedArea(polygon) >= 0 ? polygon : [...polygon].reverse();
}

/** The part of `subject` that lies inside the convex polygon `clip` (Sutherland–Hodgman). */
export function clipToConvex(subject: Polygon, clip: Polygon): Point[] {
  const edges = counterClockwise(clip);
  let output: Point[] = [...counterClockwise(subject)];
  for (let i = 0; i < edges.length && output.length > 0; i += 1) {
    const [ax, ay] = edges[i] as Point;
    const [bx, by] = edges[(i + 1) % edges.length] as Point;
    const inside = (p: Point) => (bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax) >= -1e-9;
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j += 1) {
      const current = input[j] as Point;
      const previous = input[(j + input.length - 1) % input.length] as Point;
      const currentIn = inside(current);
      const previousIn = inside(previous);
      if (currentIn !== previousIn) {
        // The edge of `clip` crosses the segment previous → current.
        const dx = current[0] - previous[0];
        const dy = current[1] - previous[1];
        const denominator = (bx - ax) * dy - (by - ay) * dx;
        if (Math.abs(denominator) > 1e-12) {
          const t = ((bx - ax) * (ay - previous[1]) - (by - ay) * (ax - previous[0])) / denominator;
          output.push([previous[0] + t * dx, previous[1] + t * dy]);
        }
      }
      if (currentIn) output.push(current);
    }
  }
  return output;
}

/** How much of `subject` lies inside the convex polygon `clip`, in square units. */
export const overlapArea = (subject: Polygon, clip: Polygon): number => {
  const clipped = clipToConvex(subject, clip);
  return clipped.length < 3 ? 0 : area(clipped);
};

export function contains(polygon: Polygon, point: Point): boolean {
  const edges = counterClockwise(polygon);
  for (let i = 0; i < edges.length; i += 1) {
    const [ax, ay] = edges[i] as Point;
    const [bx, by] = edges[(i + 1) % edges.length] as Point;
    if ((bx - ax) * (point[1] - ay) - (by - ay) * (point[0] - ax) < -1e-9) return false;
  }
  return true;
}

/** True when every point of `inner` is inside the convex polygon `outer`. */
export const containsAll = (outer: Polygon, inner: Polygon): boolean => inner.every((point) => contains(outer, point));

/** An axis-aligned rectangle as a polygon. */
export const rectangle = (x: number, y: number, width: number, height: number): Polygon => [
  [x, y],
  [x + width, y],
  [x + width, y + height],
  [x, y + height],
];
