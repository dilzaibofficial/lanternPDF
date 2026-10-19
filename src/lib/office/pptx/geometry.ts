/**
 * The outlines of PowerPoint shapes. A shape names a preset ("roundRect", "rightArrow"...) with a few adjustment values,
 * or carries its own path. Both become lists of drawing commands in points, relative to the shape's top-left corner.
 */
import type { CustomPath, GeometryM } from "./model";

export interface DrawPath {
  commands: ("M" | "L" | "C" | "Z")[];
  points: number[];
  fill: boolean;
  stroke: boolean;
  evenOdd?: boolean;
  /** Lightens (positive) or darkens (negative) the fill: the extra faces of shapes that look three-dimensional. */
  shade?: number;
}

const KAPPA = 0.5522847498307936;
const RAD = Math.PI / 180;

class Pb {
  commands: DrawPath["commands"] = [];
  points: number[] = [];
  private x = 0;
  private y = 0;

  constructor(
    private readonly fill = true,
    private readonly stroke = true,
    private readonly shade = 0,
    private readonly evenOdd = false,
  ) {}

  m(x: number, y: number): this {
    this.commands.push("M");
    this.points.push(x, y);
    this.x = x;
    this.y = y;
    return this;
  }

  l(x: number, y: number): this {
    this.commands.push("L");
    this.points.push(x, y);
    this.x = x;
    this.y = y;
    return this;
  }

  c(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): this {
    this.commands.push("C");
    this.points.push(x1, y1, x2, y2, x3, y3);
    this.x = x3;
    this.y = y3;
    return this;
  }

  /** A quadratic curve, written as the equivalent cubic. */
  q(cx: number, cy: number, x: number, y: number): this {
    return this.c(this.x + (2 / 3) * (cx - this.x), this.y + (2 / 3) * (cy - this.y), x + (2 / 3) * (cx - x), y + (2 / 3) * (cy - y), x, y);
  }

  z(): this {
    this.commands.push("Z");
    return this;
  }

  get current(): [number, number] {
    return [this.x, this.y];
  }

  /** Arc of an ellipse about (cx, cy) from parametric angle `start` for `sweep` degrees (clockwise on the page is positive). Draws from the current point. */
  arc(cx: number, cy: number, rx: number, ry: number, start: number, sweep: number): this {
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / 90));
    const each = (sweep / steps) * RAD;
    const k = (4 / 3) * Math.tan(each / 4);
    for (let i = 0; i < steps; i += 1) {
      const t0 = (start + (sweep / steps) * i) * RAD;
      const t1 = t0 + each;
      const x0 = cx + rx * Math.cos(t0);
      const y0 = cy + ry * Math.sin(t0);
      const x3 = cx + rx * Math.cos(t1);
      const y3 = cy + ry * Math.sin(t1);
      this.c(x0 - k * rx * Math.sin(t0), y0 + k * ry * Math.cos(t0), x3 + k * rx * Math.sin(t1), y3 - k * ry * Math.cos(t1), x3, y3);
    }
    return this;
  }

  /** Starts a new subpath at the point of the ellipse at parametric angle `start`, and arcs from there. */
  arcFrom(cx: number, cy: number, rx: number, ry: number, start: number, sweep: number): this {
    return this.m(cx + rx * Math.cos(start * RAD), cy + ry * Math.sin(start * RAD)).arc(cx, cy, rx, ry, start, sweep);
  }

  poly(points: readonly (readonly [number, number])[]): this {
    points.forEach(([px, py], index) => (index === 0 ? this.m(px, py) : this.l(px, py)));
    return this.z();
  }

  rect(x: number, y: number, w: number, h: number): this {
    return this.poly([
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ]);
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, reverse = false): this {
    const kx = rx * KAPPA;
    const ky = ry * KAPPA;
    if (!reverse) {
      return this.m(cx + rx, cy).c(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry).c(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy).c(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry).c(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy).z();
    }
    return this.m(cx + rx, cy).c(cx + rx, cy - ky, cx + kx, cy - ry, cx, cy - ry).c(cx - kx, cy - ry, cx - rx, cy - ky, cx - rx, cy).c(cx - rx, cy + ky, cx - kx, cy + ry, cx, cy + ry).c(cx + kx, cy + ry, cx + rx, cy + ky, cx + rx, cy).z();
  }

  done(): DrawPath {
    return { commands: this.commands, points: this.points, fill: this.fill, stroke: this.stroke, evenOdd: this.evenOdd || undefined, shade: this.shade || undefined };
  }
}

const solid = () => new Pb();
const outline = () => new Pb(false, true);
const faceOnly = (shade: number) => new Pb(true, true, shade);

type Adjust = Record<string, number>;
type Maker = (w: number, h: number, adj: (name: string, fallback: number) => number) => DrawPath[];

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

function roundedRectPath(p: Pb, w: number, h: number, tl: number, tr: number, br: number, bl: number): Pb {
  p.m(tl, 0).l(w - tr, 0);
  if (tr > 0) p.arc(w - tr, tr, tr, tr, 270, 90);
  p.l(w, h - br);
  if (br > 0) p.arc(w - br, h - br, br, br, 0, 90);
  p.l(bl, h);
  if (bl > 0) p.arc(bl, h - bl, bl, bl, 90, 90);
  p.l(0, tl);
  if (tl > 0) p.arc(tl, tl, tl, tl, 180, 90);
  return p.z();
}

/** A regular polygon (or star) that fills the box, the way PowerPoint fits these shapes. */
function fitted(points: [number, number][], w: number, h: number): [number, number][] {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return points.map(([x, y]) => [((x - minX) / (maxX - minX || 1)) * w, ((y - minY) / (maxY - minY || 1)) * h]);
}

function regularPolygon(sides: number, w: number, h: number): DrawPath[] {
  const points: [number, number][] = [];
  for (let i = 0; i < sides; i += 1) {
    const angle = (-90 + (360 / sides) * i) * RAD;
    points.push([Math.cos(angle), Math.sin(angle)]);
  }
  return [solid().poly(fitted(points, w, h)).done()];
}

function star(points: number, w: number, h: number, ratio: number): DrawPath[] {
  const vertices: [number, number][] = [];
  for (let i = 0; i < points * 2; i += 1) {
    const angle = (-90 + (180 / points) * i) * RAD;
    const radius = i % 2 === 0 ? 1 : ratio;
    vertices.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  return [solid().poly(fitted(vertices, w, h)).done()];
}

function calloutBody(w: number, h: number, radius: number, tipX: number, tipY: number): Pb {
  const p = new Pb();
  const dx = tipX - w / 2;
  const dy = tipY - h / 2;
  const horizontal = Math.abs(dx / (w || 1)) > Math.abs(dy / (h || 1));
  const r = clamp(radius, 0, Math.min(w, h) / 2);
  // Where the tail leaves the edge: a short stretch about a third of the way along, on the side the tip points to.
  const sideX = dx > 0 ? [w * (7 / 12), w * (10 / 12)] : [w * (2 / 12), w * (5 / 12)];
  const sideY = dy > 0 ? [h * (7 / 12), h * (10 / 12)] : [h * (2 / 12), h * (5 / 12)];
  p.m(r, 0);
  if (!horizontal && dy < 0) p.l(sideX[0] as number, 0).l(tipX, tipY).l(sideX[1] as number, 0);
  p.l(w - r, 0);
  if (r > 0) p.arc(w - r, r, r, r, 270, 90);
  if (horizontal && dx > 0) p.l(w, sideY[0] as number).l(tipX, tipY).l(w, sideY[1] as number);
  p.l(w, h - r);
  if (r > 0) p.arc(w - r, h - r, r, r, 0, 90);
  if (!horizontal && dy > 0) p.l(sideX[1] as number, h).l(tipX, tipY).l(sideX[0] as number, h);
  p.l(r, h);
  if (r > 0) p.arc(r, h - r, r, r, 90, 90);
  if (horizontal && dx < 0) p.l(0, sideY[1] as number).l(tipX, tipY).l(0, sideY[0] as number);
  p.l(0, r);
  if (r > 0) p.arc(r, r, r, r, 180, 90);
  return p.z();
}

const PRESETS: Record<string, Maker> = {
  rect: (w, h) => [solid().rect(0, 0, w, h).done()],
  roundRect: (w, h, a) => {
    const r = (Math.min(w, h) * clamp(a("adj", 16667), 0, 50000)) / 100000;
    return [roundedRectPath(solid(), w, h, r, r, r, r).done()];
  },
  round1Rect: (w, h, a) => {
    const r = (Math.min(w, h) * clamp(a("adj", 16667), 0, 50000)) / 100000;
    return [roundedRectPath(solid(), w, h, 0, r, 0, 0).done()];
  },
  round2SameRect: (w, h, a) => {
    const top = (Math.min(w, h) * clamp(a("adj1", 16667), 0, 50000)) / 100000;
    const bottom = (Math.min(w, h) * clamp(a("adj2", 0), 0, 50000)) / 100000;
    return [roundedRectPath(solid(), w, h, top, top, bottom, bottom).done()];
  },
  round2DiagRect: (w, h, a) => {
    const first = (Math.min(w, h) * clamp(a("adj1", 16667), 0, 50000)) / 100000;
    const second = (Math.min(w, h) * clamp(a("adj2", 0), 0, 50000)) / 100000;
    return [roundedRectPath(solid(), w, h, first, second, first, second).done()];
  },
  snip1Rect: (w, h, a) => {
    const d = (Math.min(w, h) * clamp(a("adj", 16667), 0, 50000)) / 100000;
    return [
      solid()
        .poly([
          [0, 0],
          [w - d, 0],
          [w, d],
          [w, h],
          [0, h],
        ])
        .done(),
    ];
  },
  snip2SameRect: (w, h, a) => {
    const t = (Math.min(w, h) * clamp(a("adj1", 16667), 0, 50000)) / 100000;
    const b = (Math.min(w, h) * clamp(a("adj2", 0), 0, 50000)) / 100000;
    return [
      solid()
        .poly([
          [t, 0],
          [w - t, 0],
          [w, t],
          [w, h - b],
          [w - b, h],
          [b, h],
          [0, h - b],
          [0, t],
        ])
        .done(),
    ];
  },
  snip2DiagRect: (w, h, a) => {
    const first = (Math.min(w, h) * clamp(a("adj1", 0), 0, 50000)) / 100000;
    const second = (Math.min(w, h) * clamp(a("adj2", 16667), 0, 50000)) / 100000;
    return [
      solid()
        .poly([
          [first, 0],
          [w - second, 0],
          [w, second],
          [w, h - first],
          [w - first, h],
          [second, h],
          [0, h - second],
          [0, first],
        ])
        .done(),
    ];
  },
  snipRoundRect: (w, h, a) => {
    const round = (Math.min(w, h) * clamp(a("adj1", 16667), 0, 50000)) / 100000;
    const snip = (Math.min(w, h) * clamp(a("adj2", 16667), 0, 50000)) / 100000;
    const p = solid().m(round, 0).l(w - snip, 0).l(w, snip).l(w, h).l(0, h).l(0, round);
    if (round > 0) p.arc(round, round, round, round, 180, 90);
    return [p.z().done()];
  },
  ellipse: (w, h) => [solid().ellipse(w / 2, h / 2, w / 2, h / 2).done()],
  triangle: (w, h, a) => {
    const x = (w * clamp(a("adj", 50000), 0, 100000)) / 100000;
    return [
      solid()
        .poly([
          [0, h],
          [x, 0],
          [w, h],
        ])
        .done(),
    ];
  },
  rtTriangle: (w, h) => [
    solid()
      .poly([
        [0, h],
        [0, 0],
        [w, h],
      ])
      .done(),
  ],
  diamond: (w, h) => [
    solid()
      .poly([
        [0, h / 2],
        [w / 2, 0],
        [w, h / 2],
        [w / 2, h],
      ])
      .done(),
  ],
  parallelogram: (w, h, a) => {
    const x = Math.min(w, (Math.min(w, h) * a("adj", 25000)) / 100000);
    return [
      solid()
        .poly([
          [0, h],
          [x, 0],
          [w, 0],
          [w - x, h],
        ])
        .done(),
    ];
  },
  trapezoid: (w, h, a) => {
    const x = Math.min(w / 2, (Math.min(w, h) * a("adj", 25000)) / 100000);
    return [
      solid()
        .poly([
          [0, h],
          [x, 0],
          [w - x, 0],
          [w, h],
        ])
        .done(),
    ];
  },
  pentagon: (w, h) => regularPolygon(5, w, h),
  heptagon: (w, h) => regularPolygon(7, w, h),
  decagon: (w, h) => regularPolygon(10, w, h),
  dodecagon: (w, h) => regularPolygon(12, w, h),
  hexagon: (w, h, a) => {
    const x = Math.min(w / 2, (Math.min(w, h) * a("adj", 25000)) / 100000);
    return [
      solid()
        .poly([
          [0, h / 2],
          [x, 0],
          [w - x, 0],
          [w, h / 2],
          [w - x, h],
          [x, h],
        ])
        .done(),
    ];
  },
  octagon: (w, h, a) => {
    const x = Math.min(w / 2, h / 2, (Math.min(w, h) * a("adj", 29289)) / 100000);
    return [
      solid()
        .poly([
          [0, x],
          [x, 0],
          [w - x, 0],
          [w, x],
          [w, h - x],
          [w - x, h],
          [x, h],
          [0, h - x],
        ])
        .done(),
    ];
  },
  plus: (w, h, a) => {
    const x = Math.min(w / 2, h / 2, (Math.min(w, h) * a("adj", 25000)) / 100000);
    return [
      solid()
        .poly([
          [0, x],
          [x, x],
          [x, 0],
          [w - x, 0],
          [w - x, x],
          [w, x],
          [w, h - x],
          [w - x, h - x],
          [w - x, h],
          [x, h],
          [x, h - x],
          [0, h - x],
        ])
        .done(),
    ];
  },
  star4: (w, h, a) => star(4, w, h, a("adj", 12500) / 50000),
  star5: (w, h, a) => star(5, w, h, a("adj", 19098) / 50000),
  star6: (w, h, a) => star(6, w, h, a("adj", 28868) / 50000),
  star7: (w, h, a) => star(7, w, h, a("adj", 34601) / 50000),
  star8: (w, h, a) => star(8, w, h, a("adj", 37500) / 50000),
  star10: (w, h, a) => star(10, w, h, a("adj", 42533) / 50000),
  star12: (w, h, a) => star(12, w, h, a("adj", 37500) / 50000),
  star16: (w, h, a) => star(16, w, h, a("adj", 37500) / 50000),
  star24: (w, h, a) => star(24, w, h, a("adj", 37500) / 50000),
  star32: (w, h, a) => star(32, w, h, a("adj", 37500) / 50000),
  rightArrow: (w, h, a) => {
    const shaft = (h * clamp(a("adj1", 50000), 0, 100000)) / 200000;
    const head = Math.min(w, (Math.min(w, h) * a("adj2", 50000)) / 100000);
    const y1 = h / 2 - shaft;
    const y2 = h / 2 + shaft;
    const x1 = w - head;
    return [
      solid()
        .poly([
          [0, y1],
          [x1, y1],
          [x1, 0],
          [w, h / 2],
          [x1, h],
          [x1, y2],
          [0, y2],
        ])
        .done(),
    ];
  },
  leftArrow: (w, h, a) => {
    const shaft = (h * clamp(a("adj1", 50000), 0, 100000)) / 200000;
    const head = Math.min(w, (Math.min(w, h) * a("adj2", 50000)) / 100000);
    const y1 = h / 2 - shaft;
    const y2 = h / 2 + shaft;
    return [
      solid()
        .poly([
          [w, y1],
          [head, y1],
          [head, 0],
          [0, h / 2],
          [head, h],
          [head, y2],
          [w, y2],
        ])
        .done(),
    ];
  },
  upArrow: (w, h, a) => {
    const shaft = (w * clamp(a("adj1", 50000), 0, 100000)) / 200000;
    const head = Math.min(h, (Math.min(w, h) * a("adj2", 50000)) / 100000);
    const x1 = w / 2 - shaft;
    const x2 = w / 2 + shaft;
    return [
      solid()
        .poly([
          [x1, h],
          [x1, head],
          [0, head],
          [w / 2, 0],
          [w, head],
          [x2, head],
          [x2, h],
        ])
        .done(),
    ];
  },
  downArrow: (w, h, a) => {
    const shaft = (w * clamp(a("adj1", 50000), 0, 100000)) / 200000;
    const head = Math.min(h, (Math.min(w, h) * a("adj2", 50000)) / 100000);
    const x1 = w / 2 - shaft;
    const x2 = w / 2 + shaft;
    const y1 = h - head;
    return [
      solid()
        .poly([
          [x1, 0],
          [x1, y1],
          [0, y1],
          [w / 2, h],
          [w, y1],
          [x2, y1],
          [x2, 0],
        ])
        .done(),
    ];
  },
  leftRightArrow: (w, h, a) => {
    const shaft = (h * clamp(a("adj1", 50000), 0, 100000)) / 200000;
    const head = Math.min(w / 2, (Math.min(w, h) * a("adj2", 50000)) / 100000);
    const y1 = h / 2 - shaft;
    const y2 = h / 2 + shaft;
    return [
      solid()
        .poly([
          [0, h / 2],
          [head, 0],
          [head, y1],
          [w - head, y1],
          [w - head, 0],
          [w, h / 2],
          [w - head, h],
          [w - head, y2],
          [head, y2],
          [head, h],
        ])
        .done(),
    ];
  },
  upDownArrow: (w, h, a) => {
    const shaft = (w * clamp(a("adj1", 50000), 0, 100000)) / 200000;
    const head = Math.min(h / 2, (Math.min(w, h) * a("adj2", 50000)) / 100000);
    const x1 = w / 2 - shaft;
    const x2 = w / 2 + shaft;
    return [
      solid()
        .poly([
          [w / 2, 0],
          [w, head],
          [x2, head],
          [x2, h - head],
          [w, h - head],
          [w / 2, h],
          [0, h - head],
          [x1, h - head],
          [x1, head],
          [0, head],
        ])
        .done(),
    ];
  },
  chevron: (w, h, a) => {
    const x = Math.min(w, (Math.min(w, h) * a("adj", 50000)) / 100000);
    return [
      solid()
        .poly([
          [0, 0],
          [w - x, 0],
          [w, h / 2],
          [w - x, h],
          [0, h],
          [x, h / 2],
        ])
        .done(),
    ];
  },
  homePlate: (w, h, a) => {
    const x = Math.min(w, (Math.min(w, h) * a("adj", 50000)) / 100000);
    return [
      solid()
        .poly([
          [0, 0],
          [w - x, 0],
          [w, h / 2],
          [w - x, h],
          [0, h],
        ])
        .done(),
    ];
  },
  can: (w, h, a) => {
    const ry = Math.min(h / 2, (Math.min(w, h) * clamp(a("adj", 25000), 0, 50000)) / 100000 / 1);
    const e = ry / 1;
    const body = solid().m(0, e).arc(w / 2, e, w / 2, e, 180, 180).l(w, h - e).arc(w / 2, h - e, w / 2, e, 0, 180).l(0, e).z().done();
    return [body, faceOnly(0.25).ellipse(w / 2, e, w / 2, e).done()];
  },
  cube: (w, h, a) => {
    const d = Math.min(w, h) * (clamp(a("adj", 25000), 0, 100000) / 100000);
    return [
      solid().rect(0, d, w - d, h - d).done(),
      faceOnly(0.3)
        .poly([
          [0, d],
          [d, 0],
          [w, 0],
          [w - d, d],
        ])
        .done(),
      faceOnly(-0.25)
        .poly([
          [w - d, d],
          [w, 0],
          [w, h - d],
          [w - d, h],
        ])
        .done(),
    ];
  },
  donut: (w, h, a) => {
    const t = (Math.min(w, h) * clamp(a("adj", 25000), 0, 50000)) / 100000;
    return [new Pb(true, true, 0, true).ellipse(w / 2, h / 2, w / 2, h / 2).ellipse(w / 2, h / 2, Math.max(0.1, w / 2 - t), Math.max(0.1, h / 2 - t), true).done()];
  },
  frame: (w, h, a) => {
    const t = (Math.min(w, h) * clamp(a("adj1", 12500), 0, 50000)) / 100000;
    return [
      new Pb(true, true, 0, true)
        .rect(0, 0, w, h)
        .poly([
          [t, t],
          [t, h - t],
          [w - t, h - t],
          [w - t, t],
        ])
        .done(),
    ];
  },
  bevel: (w, h, a) => {
    const t = (Math.min(w, h) * clamp(a("adj", 12500), 0, 50000)) / 100000;
    return [
      solid().rect(0, 0, w, h).done(),
      faceOnly(0.3)
        .poly([
          [0, 0],
          [w, 0],
          [w - t, t],
          [t, t],
        ])
        .done(),
      faceOnly(0.15)
        .poly([
          [0, 0],
          [t, t],
          [t, h - t],
          [0, h],
        ])
        .done(),
      faceOnly(-0.3)
        .poly([
          [0, h],
          [t, h - t],
          [w - t, h - t],
          [w, h],
        ])
        .done(),
      faceOnly(-0.15)
        .poly([
          [w, 0],
          [w, h],
          [w - t, h - t],
          [w - t, t],
        ])
        .done(),
    ];
  },
  plaque: (w, h, a) => {
    const r = (Math.min(w, h) * clamp(a("adj", 16667), 0, 50000)) / 100000;
    return [solid().m(r, 0).l(w - r, 0).arc(w, 0, r, r, 180, -90).l(w, h - r).arc(w, h, r, r, 270, -90).l(r, h).arc(0, h, r, r, 0, -90).l(0, r).arc(0, 0, r, r, 90, -90).z().done()];
  },
  foldedCorner: (w, h, a) => {
    const d = (Math.min(w, h) * clamp(a("adj", 16667), 0, 50000)) / 100000;
    return [
      solid()
        .poly([
          [0, 0],
          [w, 0],
          [w, h - d],
          [w - d, h],
          [0, h],
        ])
        .done(),
      faceOnly(-0.2)
        .poly([
          [w - d, h],
          [w, h - d],
          [w - d, h - d],
        ])
        .done(),
    ];
  },
  smileyFace: (w, h) => {
    const eyeW = w * 0.09;
    const eyeH = h * 0.1;
    return [
      solid().ellipse(w / 2, h / 2, w / 2, h / 2).done(),
      faceOnly(-0.7).ellipse(w * 0.34, h * 0.36, eyeW, eyeH).done(),
      faceOnly(-0.7).ellipse(w * 0.66, h * 0.36, eyeW, eyeH).done(),
      outline().m(w * 0.25, h * 0.62).q(w / 2, h * 0.9, w * 0.75, h * 0.62).done(),
    ];
  },
  heart: (w, h) => [
    solid()
      .m(w / 2, h * 0.95)
      .c(w * 0.12, h * 0.65, 0, h * 0.45, 0, h * 0.28)
      .c(0, h * 0.1, w * 0.15, 0, w * 0.3, 0)
      .c(w * 0.4, 0, w * 0.47, h * 0.07, w / 2, h * 0.22)
      .c(w * 0.53, h * 0.07, w * 0.6, 0, w * 0.7, 0)
      .c(w * 0.85, 0, w, h * 0.1, w, h * 0.28)
      .c(w, h * 0.45, w * 0.88, h * 0.65, w / 2, h * 0.95)
      .z()
      .done(),
  ],
  sun: (w, h, a) => {
    const rx = (w * clamp(a("adj", 25000), 12500, 46875)) / 100000;
    const ry = (h * clamp(a("adj", 25000), 12500, 46875)) / 100000;
    const out: DrawPath[] = [];
    for (let i = 0; i < 8; i += 1) {
      const angle = (i * 45) * RAD;
      const tip: [number, number] = [w / 2 + Math.cos(angle) * w * 0.48, h / 2 + Math.sin(angle) * h * 0.48];
      const side = 14 * RAD;
      const reach = 1.4;
      out.push(
        solid()
          .poly([
            [w / 2 + Math.cos(angle - side) * rx * reach, h / 2 + Math.sin(angle - side) * ry * reach],
            tip,
            [w / 2 + Math.cos(angle + side) * rx * reach, h / 2 + Math.sin(angle + side) * ry * reach],
          ])
          .done(),
      );
    }
    out.push(solid().ellipse(w / 2, h / 2, rx, ry).done());
    return out;
  },
  moon: (w, h, a) => {
    const inner = w * clamp(a("adj", 50000), 0, 87500) / 100000;
    return [solid().m(w, 0).c(w * 0.45, 0, 0, h * 0.22, 0, h / 2).c(0, h * 0.78, w * 0.45, h, w, h).c(w - inner * 0.9, h * 0.85, inner, h * 0.7, inner, h / 2).c(inner, h * 0.3, w - inner * 0.9, h * 0.15, w, 0).z().done()];
  },
  lightningBolt: (w, h) => [
    solid()
      .poly(
        (
          [
            [0.4, 0],
            [0.62, 0.3],
            [0.5, 0.34],
            [0.8, 0.6],
            [0.68, 0.65],
            [1, 1],
            [0.38, 0.72],
            [0.5, 0.68],
            [0.2, 0.42],
            [0.32, 0.38],
            [0.08, 0.1],
          ] as [number, number][]
        ).map(([x, y]) => [x * w, y * h] as [number, number]),
      )
      .done(),
  ],
  cloud: (w, h) => {
    const p = solid();
    const bumps = 10;
    const cx = w / 2;
    const cy = h / 2;
    const points: [number, number][] = [];
    for (let i = 0; i < bumps; i += 1) {
      const angle = ((360 / bumps) * i - 90) * RAD;
      points.push([cx + Math.cos(angle) * w * 0.4, cy + Math.sin(angle) * h * 0.36]);
    }
    p.m((points[0] as [number, number])[0], (points[0] as [number, number])[1]);
    for (let i = 0; i < bumps; i += 1) {
      const from = points[i] as [number, number];
      const to = points[(i + 1) % bumps] as [number, number];
      const midX = (from[0] + to[0]) / 2;
      const midY = (from[1] + to[1]) / 2;
      const outX = midX - cx;
      const outY = midY - cy;
      const length = Math.hypot(outX, outY) || 1;
      const chord = Math.hypot(to[0] - from[0], to[1] - from[1]);
      p.q(midX + (outX / length) * chord * 0.75, midY + (outY / length) * chord * 0.75, to[0], to[1]);
    }
    return [p.z().done()];
  },
  wave: (w, h, a) => {
    const dy = (h * clamp(a("adj1", 12500), 0, 20000)) / 100000;
    const hump = dy * (4 / 3);
    return [
      solid()
        .m(0, dy)
        .c(w * 0.1821, dy - hump, w * 0.3179, dy - hump, w / 2, dy)
        .c(w * 0.6821, dy + hump, w * 0.8179, dy + hump, w, dy)
        .l(w, h - dy)
        .c(w * 0.8179, h - dy + hump, w * 0.6821, h - dy + hump, w / 2, h - dy)
        .c(w * 0.3179, h - dy - hump, w * 0.1821, h - dy - hump, 0, h - dy)
        .z()
        .done(),
    ];
  },
  teardrop: (w, h, a) => {
    const reach = clamp(a("adj", 100000), 0, 200000) / 100000;
    const tipX = w / 2 + (w / 2) * reach;
    const tipY = h / 2 - (h / 2) * reach;
    return [solid().m(w / 2, 0).l(Math.min(w, tipX), Math.max(0, tipY)).l(w, h / 2).arc(w / 2, h / 2, w / 2, h / 2, 0, 270).z().done()];
  },
  blockArc: (w, h, a) => {
    const start = a("adj1", 10800000) / 60000;
    const end = a("adj2", 0) / 60000;
    const thick = clamp(a("adj3", 25000), 0, 50000) / 100000;
    const sweep = (((end - start) % 360) + 360) % 360 || 360;
    const rx = w / 2;
    const ry = h / 2;
    const ix = Math.max(0.1, rx - Math.min(w, h) * thick);
    const iy = Math.max(0.1, ry - Math.min(w, h) * thick);
    return [solid().arcFrom(rx, ry, rx, ry, start, sweep).l(rx + ix * Math.cos(end * RAD), ry + iy * Math.sin(end * RAD)).arc(rx, ry, ix, iy, end, -sweep).z().done()];
  },
  arc: (w, h, a) => {
    const start = a("adj1", 16200000) / 60000;
    const end = a("adj2", 0) / 60000;
    const sweep = (((end - start) % 360) + 360) % 360 || 360;
    return [new Pb(true, false).m(w / 2, h / 2).l(w / 2 + (w / 2) * Math.cos(start * RAD), h / 2 + (h / 2) * Math.sin(start * RAD)).arc(w / 2, h / 2, w / 2, h / 2, start, sweep).z().done(), outline().arcFrom(w / 2, h / 2, w / 2, h / 2, start, sweep).done()];
  },
  pie: (w, h, a) => {
    const start = a("adj1", 0) / 60000;
    const end = a("adj2", 16200000) / 60000;
    const sweep = (((end - start) % 360) + 360) % 360 || 360;
    return [solid().m(w / 2, h / 2).l(w / 2 + (w / 2) * Math.cos(start * RAD), h / 2 + (h / 2) * Math.sin(start * RAD)).arc(w / 2, h / 2, w / 2, h / 2, start, sweep).z().done()];
  },
  chord: (w, h, a) => {
    const start = a("adj1", 2700000) / 60000;
    const end = a("adj2", 16200000) / 60000;
    const sweep = (((end - start) % 360) + 360) % 360 || 360;
    return [solid().arcFrom(w / 2, h / 2, w / 2, h / 2, start, sweep).z().done()];
  },
  wedgeRectCallout: (w, h, a) => [calloutBody(w, h, 0, w / 2 + (w * a("adj1", -20833)) / 100000, h / 2 + (h * a("adj2", 62500)) / 100000).done()],
  wedgeRoundRectCallout: (w, h, a) => [calloutBody(w, h, (Math.min(w, h) * a("adj3", 16667)) / 100000, w / 2 + (w * a("adj1", -20833)) / 100000, h / 2 + (h * a("adj2", 62500)) / 100000).done()],
  wedgeEllipseCallout: (w, h, a) => {
    const tipX = w / 2 + (w * a("adj1", -20833)) / 100000;
    const tipY = h / 2 + (h * a("adj2", 62500)) / 100000;
    const angle = Math.atan2(tipY - h / 2, tipX - w / 2);
    const spread = 0.28;
    const at = (t: number): [number, number] => [w / 2 + (w / 2) * Math.cos(t), h / 2 + (h / 2) * Math.sin(t)];
    const left = at(angle - spread);
    const right = at(angle + spread);
    return [
      solid().ellipse(w / 2, h / 2, w / 2, h / 2).done(),
      new Pb(true, false).poly([left, [tipX, tipY], right]).done(),
      outline().m(left[0], left[1]).l(tipX, tipY).l(right[0], right[1]).done(),
    ];
  },
  line: (w, h) => [outline().m(0, 0).l(w, h).done()],
  straightConnector1: (w, h) => [outline().m(0, 0).l(w, h).done()],
  bentConnector2: (w, h) => [outline().m(0, 0).l(w, 0).l(w, h).done()],
  bentConnector3: (w, h, a) => {
    const x = (w * a("adj1", 50000)) / 100000;
    return [outline().m(0, 0).l(x, 0).l(x, h).l(w, h).done()];
  },
  bentConnector4: (w, h, a) => {
    const x = (w * a("adj1", 50000)) / 100000;
    const y = (h * a("adj2", 50000)) / 100000;
    return [outline().m(0, 0).l(x, 0).l(x, y).l(w, y).l(w, h).done()];
  },
  bentConnector5: (w, h, a) => {
    const x1 = (w * a("adj1", 50000)) / 100000;
    const y = (h * a("adj2", 50000)) / 100000;
    const x2 = (w * a("adj3", 50000)) / 100000;
    return [outline().m(0, 0).l(x1, 0).l(x1, y).l(x2, y).l(x2, h).l(w, h).done()];
  },
  curvedConnector2: (w, h) => [outline().m(0, 0).c(w / 2, 0, w, h / 2, w, h).done()],
  curvedConnector3: (w, h, a) => {
    const x = (w * a("adj1", 50000)) / 100000;
    return [outline().m(0, 0).c(x / 2, 0, x, h / 4, x, h / 2).c(x, (h * 3) / 4, (x + w) / 2, h, w, h).done()];
  },
  mathPlus: (w, h, a) => {
    const t = (Math.min(w, h) * clamp(a("adj1", 23520), 0, 73490)) / 200000;
    return [
      solid()
        .poly([
          [w / 2 - t, 0 + h * 0.1],
          [w / 2 + t, h * 0.1],
          [w / 2 + t, h / 2 - t],
          [w * 0.9, h / 2 - t],
          [w * 0.9, h / 2 + t],
          [w / 2 + t, h / 2 + t],
          [w / 2 + t, h * 0.9],
          [w / 2 - t, h * 0.9],
          [w / 2 - t, h / 2 + t],
          [w * 0.1, h / 2 + t],
          [w * 0.1, h / 2 - t],
          [w / 2 - t, h / 2 - t],
        ])
        .done(),
    ];
  },
  mathMinus: (w, h, a) => {
    const t = (Math.min(w, h) * clamp(a("adj1", 23520), 0, 100000)) / 200000;
    return [solid().rect(w * 0.1, h / 2 - t, w * 0.8, t * 2).done()];
  },
  mathEqual: (w, h, a) => {
    const t = (Math.min(w, h) * clamp(a("adj1", 23520), 0, 50000)) / 100000;
    const gap = (Math.min(w, h) * clamp(a("adj2", 11760), 0, 100000)) / 100000;
    return [solid().rect(w * 0.1, h / 2 - gap / 2 - t, w * 0.8, t).done(), solid().rect(w * 0.1, h / 2 + gap / 2, w * 0.8, t).done()];
  },
  flowChartProcess: (w, h) => [solid().rect(0, 0, w, h).done()],
  flowChartAlternateProcess: (w, h) => {
    const r = Math.min(w, h) / 6;
    return [roundedRectPath(solid(), w, h, r, r, r, r).done()];
  },
  flowChartDecision: (w, h) => PRESETS.diamond?.(w, h, () => 0) ?? [],
  flowChartData: (w, h) => {
    const x = w / 5;
    return [
      solid()
        .poly([
          [x, 0],
          [w, 0],
          [w - x, h],
          [0, h],
        ])
        .done(),
    ];
  },
  flowChartPredefinedProcess: (w, h) => [solid().rect(0, 0, w, h).done(), outline().m(w / 8, 0).l(w / 8, h).done(), outline().m((w * 7) / 8, 0).l((w * 7) / 8, h).done()],
  flowChartInternalStorage: (w, h) => [solid().rect(0, 0, w, h).done(), outline().m(w / 8, 0).l(w / 8, h).done(), outline().m(0, h / 8).l(w, h / 8).done()],
  flowChartDocument: (w, h) => [solid().m(0, 0).l(w, 0).l(w, h * 0.802).c(w / 2, h * 0.802, w / 2, h * 1.05, 0, h * 0.934).z().done()],
  flowChartTerminator: (w, h) => {
    const rx = Math.min(w * 0.161, w / 2);
    const ry = h / 2;
    return [solid().m(rx, 0).l(w - rx, 0).arc(w - rx, ry, rx, ry, 270, 180).l(rx, h).arc(rx, ry, rx, ry, 90, 180).z().done()];
  },
  flowChartConnector: (w, h) => [solid().ellipse(w / 2, h / 2, w / 2, h / 2).done()],
  flowChartSummingJunction: (w, h) => {
    const d = 0.1464;
    return [solid().ellipse(w / 2, h / 2, w / 2, h / 2).done(), outline().m(w * d, h * d).l(w * (1 - d), h * (1 - d)).done(), outline().m(w * (1 - d), h * d).l(w * d, h * (1 - d)).done()];
  },
  flowChartOr: (w, h) => [solid().ellipse(w / 2, h / 2, w / 2, h / 2).done(), outline().m(w / 2, 0).l(w / 2, h).done(), outline().m(0, h / 2).l(w, h / 2).done()],
  flowChartPreparation: (w, h) => [
    solid()
      .poly([
        [0, h / 2],
        [w / 5, 0],
        [(w * 4) / 5, 0],
        [w, h / 2],
        [(w * 4) / 5, h],
        [w / 5, h],
      ])
      .done(),
  ],
  flowChartManualInput: (w, h) => [
    solid()
      .poly([
        [0, h / 5],
        [w, 0],
        [w, h],
        [0, h],
      ])
      .done(),
  ],
  flowChartManualOperation: (w, h) => [
    solid()
      .poly([
        [0, 0],
        [w, 0],
        [w * 0.8, h],
        [w * 0.2, h],
      ])
      .done(),
  ],
  flowChartMerge: (w, h) => [
    solid()
      .poly([
        [0, 0],
        [w, 0],
        [w / 2, h],
      ])
      .done(),
  ],
  flowChartExtract: (w, h) => [
    solid()
      .poly([
        [w / 2, 0],
        [w, h],
        [0, h],
      ])
      .done(),
  ],
  flowChartOffpageConnector: (w, h) => [
    solid()
      .poly([
        [0, 0],
        [w, 0],
        [w, h * 0.8],
        [w / 2, h],
        [0, h * 0.8],
      ])
      .done(),
  ],
  flowChartDelay: (w, h) => [solid().m(0, 0).l(w / 2, 0).arc(w / 2, h / 2, w / 2, h / 2, 270, 180).l(0, h).z().done()],
  flowChartMagneticDisk: (w, h) => PRESETS.can?.(w, h, (_name, fallback) => fallback) ?? [],
  actionButtonBlank: (w, h) => [solid().rect(0, 0, w, h).done()],
};

// Shapes that PowerPoint draws as a plain box with the same name.
for (const name of ["flowChartInputOutput"]) PRESETS[name] = PRESETS.flowChartData as Maker;
PRESETS.flowChartSort = PRESETS.diamond as Maker;
PRESETS.flowChartCollate = (w, h) => [
  solid()
    .poly([
      [0, 0],
      [w, 0],
      [w / 2, h / 2],
      [w, h],
      [0, h],
      [w / 2, h / 2],
    ])
    .done(),
];

export function isKnownPreset(name: string): boolean {
  return name in PRESETS || name.startsWith("actionButton");
}

export interface BuiltGeometry {
  paths: DrawPath[];
  /** False when the shape's name is not one we can draw, so a plain box stands in for it. */
  known: boolean;
}

function scalePath(path: CustomPath, w: number, h: number): DrawPath {
  const sx = path.w > 0 ? w / path.w : 1 / 12700;
  const sy = path.h > 0 ? h / path.h : 1 / 12700;
  return { commands: path.commands, points: path.points.map((value, index) => (index % 2 === 0 ? value * sx : value * sy)), fill: path.fill, stroke: path.stroke };
}

/** The outline of a shape in a box of w × h points. */
export function geometryPaths(geometry: GeometryM, w: number, h: number): BuiltGeometry {
  if (geometry.kind === "custom") return { paths: geometry.paths.map((path) => scalePath(path, w, h)), known: true };
  const maker = PRESETS[geometry.name];
  if (!maker) return { paths: [solid().rect(0, 0, w, h).done()], known: geometry.name.startsWith("actionButton") };
  const adjust: Adjust = geometry.adjust;
  return { paths: maker(w, h, (name, fallback) => adjust[name] ?? fallback), known: true };
}

/** The part of the box where a shape's text goes (the whole box for most shapes). */
export function textRectOf(geometry: GeometryM, w: number, h: number): { x: number; y: number; w: number; h: number } {
  if (geometry.kind !== "preset") return { x: 0, y: 0, w, h };
  const adjust = geometry.adjust;
  switch (geometry.name) {
    case "ellipse":
    case "flowChartConnector":
    case "flowChartSummingJunction":
    case "flowChartOr":
    case "wedgeEllipseCallout":
    case "smileyFace":
      return { x: w * 0.14645, y: h * 0.14645, w: w * 0.7071, h: h * 0.7071 };
    case "diamond":
    case "flowChartDecision":
      return { x: w / 4, y: h / 4, w: w / 2, h: h / 2 };
    case "roundRect":
    case "wedgeRoundRectCallout": {
      const r = (Math.min(w, h) * clamp(adjust.adj ?? adjust.adj3 ?? 16667, 0, 50000)) / 100000;
      const inset = r * 0.29289;
      return { x: inset, y: inset, w: Math.max(1, w - inset * 2), h: Math.max(1, h - inset * 2) };
    }
    case "triangle":
      return { x: w / 4, y: h / 2, w: w / 2, h: h / 2 };
    case "rtTriangle":
      return { x: 0, y: h / 2, w: w / 2, h: h / 2 };
    case "parallelogram":
    case "flowChartData":
    case "flowChartInputOutput": {
      const inset = Math.min(w, h) * ((adjust.adj ?? 25000) / 100000) * (geometry.name === "parallelogram" ? 0.5 : 0.4);
      return { x: inset, y: 0, w: Math.max(1, w - inset * 2), h };
    }
    case "trapezoid": {
      const inset = Math.min(w, h) * ((adjust.adj ?? 25000) / 100000) * 0.5;
      return { x: inset, y: h / 2, w: Math.max(1, w - inset * 2), h: h / 2 };
    }
    case "hexagon":
    case "octagon":
    case "flowChartPreparation": {
      const inset = Math.min(w, h) * 0.12;
      return { x: inset, y: inset * 0.6, w: Math.max(1, w - inset * 2), h: Math.max(1, h - inset * 1.2) };
    }
    case "can":
    case "flowChartMagneticDisk":
      return { x: 0, y: h * 0.25, w, h: h * 0.7 };
    case "cube":
      return { x: 0, y: Math.min(w, h) * 0.25, w: w - Math.min(w, h) * 0.25, h: h - Math.min(w, h) * 0.25 };
    case "rightArrow":
    case "leftArrow":
    case "upArrow":
    case "downArrow":
    case "chevron":
    case "homePlate": {
      return { x: 0, y: h * 0.15, w, h: h * 0.7 };
    }
    default:
      return { x: 0, y: 0, w, h };
  }
}

// ---- custom paths ------------------------------------------------------------------------------------------

/** Converts an OOXML arcTo (visual angles in degrees) into cubic segments appended to a custom path. */
export function appendArcTo(path: { commands: CustomPath["commands"]; points: number[] }, current: [number, number], wR: number, hR: number, stAng: number, swAng: number): [number, number] {
  const builder = new Pb();
  // Visual angle to parametric angle: tan(t) = (rx / ry) * tan(a).
  const visualToParametric = (deg: number): number => {
    const a = deg * RAD;
    return (Math.atan2(wR * Math.sin(a), hR * Math.cos(a)) * 180) / Math.PI;
  };
  const t0 = visualToParametric(stAng);
  const t1 = visualToParametric(stAng + swAng);
  let sweep = t1 - t0;
  // Keep the direction the file asks for even when the parametric angles wrap.
  if (swAng > 0) while (sweep < 0) sweep += 360;
  else while (sweep > 0) sweep -= 360;
  if (Math.abs(swAng) >= 359.999) sweep = swAng;
  const cx = current[0] - wR * Math.cos(t0 * RAD);
  const cy = current[1] - hR * Math.sin(t0 * RAD);
  builder.m(current[0], current[1]).arc(cx, cy, wR, hR, t0, sweep);
  // Drop the move; the path continues from the current point.
  for (let i = 1; i < builder.commands.length; i += 1) path.commands.push(builder.commands[i] as "C");
  path.points.push(...builder.points.slice(2));
  const lastX = builder.points[builder.points.length - 2] as number;
  const lastY = builder.points[builder.points.length - 1] as number;
  return [lastX, lastY];
}
