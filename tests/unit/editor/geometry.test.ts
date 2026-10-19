import { describe, expect, it } from "vitest";
import {
  CORNER_HANDLES,
  HANDLES,
  type Handle,
  MAX_ZOOM,
  MIN_ZOOM,
  alignmentShifts,
  baseToSlot,
  boundsOf,
  boxFromCorners,
  centreOf,
  corners,
  distributeShifts,
  fitZoom,
  frameOf,
  handlePoint,
  hits,
  resizeFromHandle,
  rotatePoint,
  rotationToward,
  slotSize,
  slotToBase,
  snapBox,
  stageTransform,
  stepZoom,
  translate,
} from "../../../src/editor/model/geometry";
import type { Box, EditorObject, Pt, Rotation, ShapeObject, TextBoxObject } from "../../../src/editor/model/types";

const close = (a: Pt, b: Pt, digits = 6) => {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
};

const base = { id: "a", page: "p1", rotation: 0, opacity: 1 };
const rect = (box: Box, rotation = 0, fill: string | null = "#fff"): ShapeObject => ({ ...base, ...box, rotation, kind: "rect", fill, stroke: "#000", strokeWidth: 2, strokeStyle: "solid", radius: 0 });
const textBox = (box: Box): TextBoxObject => ({
  ...base,
  ...box,
  kind: "text",
  text: "Hi",
  family: "sans",
  bold: false,
  italic: false,
  underline: false,
  size: 12,
  color: "#000",
  align: "left",
  lineHeight: 1.2,
  letterSpacing: 0,
  fill: null,
  border: { color: null, width: 0, style: "solid" },
  padding: 0,
  radius: 0,
  autoHeight: false,
});

describe("points, boxes and rotation", () => {
  it("rotates a point about a centre, clockwise on a y-down screen", () => {
    close(rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90), { x: 0, y: 10 });
    close(rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 180), { x: -10, y: 0 });
    close(rotatePoint({ x: 3, y: 4 }, { x: 3, y: 4 }, 47), { x: 3, y: 4 });
    close(rotatePoint({ x: 5, y: 5 }, { x: 5, y: 0 }, 360), { x: 5, y: 5 });
  });

  it("finds the corners of a turned box and the bounds that contain them", () => {
    const box = { x: 100, y: 100, width: 40, height: 20 };
    const [tl, tr, br, bl] = corners(box, 90);
    // turning a quarter about the centre (120, 110) sends the top-left corner to the top-right
    close(tl, { x: 130, y: 90 });
    close(tr, { x: 130, y: 130 });
    close(br, { x: 110, y: 130 });
    close(bl, { x: 110, y: 90 });
    const bounds = boundsOf(rect(box, 90));
    expect(bounds.x).toBeCloseTo(110);
    expect(bounds.y).toBeCloseTo(90);
    expect(bounds.width).toBeCloseTo(20);
    expect(bounds.height).toBeCloseTo(40);
    expect(boxFromCorners({ x: 9, y: 2 }, { x: 3, y: 8 })).toEqual({ x: 3, y: 2, width: 6, height: 6 });
    expect(centreOf(box)).toEqual({ x: 120, y: 110 });
  });

  it("gives frames and bounds for objects described by points", () => {
    const line: EditorObject = { ...base, kind: "line", x1: 10, y1: 20, x2: 50, y2: 10, color: "#000", strokeWidth: 4, strokeStyle: "solid", arrow: "none" };
    expect(frameOf(line)).toEqual({ x: 8, y: 8, width: 44, height: 14 });
    const draw: EditorObject = { ...base, kind: "draw", points: [[0, 0], [10, 5], [20, 0]], color: "#000", strokeWidth: 2 };
    expect(boundsOf(draw)).toEqual({ x: -1, y: -1, width: 22, height: 7 });
    const highlight: EditorObject = { ...base, kind: "highlight", color: "#ff0", quads: [{ x: 10, y: 10, width: 50, height: 12 }, { x: 10, y: 24, width: 30, height: 12 }] };
    expect(boundsOf(highlight)).toEqual({ x: 10, y: 10, width: 50, height: 26 });
  });

  it("translates every kind of object", () => {
    expect(translate(rect({ x: 1, y: 2, width: 3, height: 4 }), 10, 20)).toMatchObject({ x: 11, y: 22, width: 3, height: 4 });
    const line: EditorObject = { ...base, kind: "line", x1: 0, y1: 0, x2: 5, y2: 5, color: "#000", strokeWidth: 1, strokeStyle: "solid", arrow: "end" };
    expect(translate(line, 3, 4)).toMatchObject({ x1: 3, y1: 4, x2: 8, y2: 9 });
    const draw: EditorObject = { ...base, kind: "draw", points: [[1, 1], [2, 2]], color: "#000", strokeWidth: 1 };
    expect(translate(draw, 1, -1)).toMatchObject({ points: [[2, 0], [3, 1]] });
    const mark: EditorObject = { ...base, kind: "underline", color: "#f00", quads: [{ x: 5, y: 5, width: 5, height: 5 }] };
    expect(translate(mark, 5, 5)).toMatchObject({ quads: [{ x: 10, y: 10, width: 5, height: 5 }] });
  });
});

describe("hit testing", () => {
  it("hits inside a filled box, rotated or not, and not outside", () => {
    const box = { x: 100, y: 100, width: 100, height: 20 };
    expect(hits(rect(box), { x: 150, y: 110 }, 0)).toBe(true);
    expect(hits(rect(box), { x: 150, y: 140 }, 0)).toBe(false);
    // turned 90 degrees about (150, 110): now tall and narrow
    expect(hits(rect(box, 90), { x: 150, y: 150 }, 0)).toBe(true);
    expect(hits(rect(box, 90), { x: 195, y: 110 }, 0)).toBe(false);
  });

  it("hits an unfilled shape only on its outline, so the page behind stays clickable", () => {
    const hollow = rect({ x: 100, y: 100, width: 100, height: 60 }, 0, null);
    expect(hits(hollow, { x: 150, y: 130 }, 1)).toBe(false);
    expect(hits(hollow, { x: 100, y: 130 }, 1)).toBe(true);
    expect(hits(hollow, { x: 150, y: 160 }, 1)).toBe(true);
    const ring: ShapeObject = { ...hollow, kind: "ellipse" };
    expect(hits(ring, { x: 150, y: 130 }, 1)).toBe(false);
    expect(hits(ring, { x: 100, y: 130 }, 2)).toBe(true);
  });

  it("hits lines and strokes within a tolerance", () => {
    const line: EditorObject = { ...base, kind: "line", x1: 0, y1: 0, x2: 100, y2: 0, color: "#000", strokeWidth: 2, strokeStyle: "solid", arrow: "none" };
    expect(hits(line, { x: 50, y: 3 }, 4)).toBe(true);
    expect(hits(line, { x: 50, y: 12 }, 4)).toBe(false);
    expect(hits(line, { x: 130, y: 0 }, 4)).toBe(false);
    const draw: EditorObject = { ...base, kind: "draw", points: [[0, 0], [50, 50], [100, 0]], color: "#000", strokeWidth: 2 };
    expect(hits(draw, { x: 25, y: 26 }, 3)).toBe(true);
    expect(hits(draw, { x: 50, y: 0 }, 3)).toBe(false);
  });

  it("hits text boxes inside their frame", () => {
    expect(hits(textBox({ x: 10, y: 10, width: 100, height: 20 }), { x: 60, y: 20 }, 0)).toBe(true);
    expect(hits(textBox({ x: 10, y: 10, width: 100, height: 20 }), { x: 60, y: 40 }, 0)).toBe(false);
  });
});

describe("resizing from a handle", () => {
  const box = { x: 100, y: 100, width: 80, height: 40 };

  it("moves only the dragged side of an upright box", () => {
    expect(resizeFromHandle(box, 0, "e", { x: 220, y: 120 })).toEqual({ x: 100, y: 100, width: 120, height: 40 });
    expect(resizeFromHandle(box, 0, "s", { x: 140, y: 100 + 70 })).toEqual({ x: 100, y: 100, width: 80, height: 70 });
    expect(resizeFromHandle(box, 0, "w", { x: 60, y: 120 })).toEqual({ x: 60, y: 100, width: 120, height: 40 });
    expect(resizeFromHandle(box, 0, "nw", { x: 90, y: 80 })).toEqual({ x: 90, y: 80, width: 90, height: 60 });
  });

  it("flips over when dragged past the opposite side, and never gets smaller than the minimum", () => {
    expect(resizeFromHandle(box, 0, "e", { x: 40, y: 120 })).toEqual({ x: 40, y: 100, width: 60, height: 40 });
    expect(resizeFromHandle(box, 0, "e", { x: 101, y: 120 }).width).toBe(4);
  });

  it("keeps the proportions on a corner when asked", () => {
    const resized = resizeFromHandle(box, 0, "se", { x: 260, y: 150 }, { keepAspect: true });
    expect(resized.width / resized.height).toBeCloseTo(2, 6);
    expect(resized.x).toBe(100);
    expect(resized.y).toBe(100);
  });

  it("grows from the centre when asked", () => {
    const resized = resizeFromHandle(box, 0, "e", { x: 240, y: 120 }, { fromCentre: true });
    expect(resized.width).toBeCloseTo(200);
    expect(resized.x + resized.width / 2).toBeCloseTo(140);
  });

  it("keeps the opposite corner fixed on the page for a turned box, at every angle and handle", () => {
    for (const rotation of [0, 17, 45, 90, 133, 180, 270, 301]) {
      for (const handle of CORNER_HANDLES) {
        const opposite: Record<Handle, Handle> = { nw: "se", n: "s", ne: "sw", e: "w", se: "nw", s: "n", sw: "ne", w: "e" };
        const fixedBefore = handlePoint(box, rotation, opposite[handle]);
        const target = { x: handlePoint(box, rotation, handle).x + 23, y: handlePoint(box, rotation, handle).y - 11 };
        const resized = resizeFromHandle(box, rotation, handle, target);
        const fixedAfter = handlePoint(resized, rotation, opposite[handle]);
        close(fixedAfter, fixedBefore, 5);
        // and the dragged handle ends up under the pointer
        close(handlePoint(resized, rotation, handle), target, 5);
      }
    }
  });

  it("keeps the opposite edge fixed when an edge handle of a turned box is dragged", () => {
    for (const rotation of [30, 90, 200]) {
      for (const handle of ["n", "e", "s", "w"] as Handle[]) {
        const opposite: Record<string, Handle> = { n: "s", e: "w", s: "n", w: "e" };
        const fixedBefore = handlePoint(box, rotation, opposite[handle] as Handle);
        const start = handlePoint(box, rotation, handle);
        const resized = resizeFromHandle(box, rotation, handle, { x: start.x + 9, y: start.y + 14 });
        close(handlePoint(resized, rotation, opposite[handle] as Handle), fixedBefore, 5);
      }
    }
  });

  it("has a handle position for every handle", () => {
    expect(HANDLES).toHaveLength(8);
    close(handlePoint(box, 0, "nw"), { x: 100, y: 100 });
    close(handlePoint(box, 0, "se"), { x: 180, y: 140 });
    close(handlePoint(box, 0, "n"), { x: 140, y: 100 });
  });

  it("works out the angle of the rotation handle", () => {
    expect(rotationToward({ x: 0, y: 0 }, { x: 0, y: -50 })).toBeCloseTo(0);
    expect(rotationToward({ x: 0, y: 0 }, { x: 50, y: 0 })).toBeCloseTo(90);
    expect(rotationToward({ x: 0, y: 0 }, { x: 0, y: 50 })).toBeCloseTo(180);
    expect(rotationToward({ x: 0, y: 0 }, { x: 50, y: 3 }, 15)).toBe(90);
  });
});

describe("snapping and alignment", () => {
  const page = { width: 600, height: 800 };

  it("snaps an edge to the page edge and a centre to the page centre", () => {
    const snap = snapBox({ x: 3, y: 100, width: 50, height: 20 }, [], page, 6);
    expect(snap.dx).toBe(-3);
    expect(snap.dy).toBe(0);
    expect(snap.guides).toContainEqual(expect.objectContaining({ axis: "x", position: 0 }));
    const centred = snapBox({ x: 275, y: 100, width: 50, height: 20 }, [], page, 6);
    expect(centred.dx).toBe(0);
    const near = snapBox({ x: 278, y: 100, width: 50, height: 20 }, [], page, 6);
    expect(near.dx).toBe(-3);
  });

  it("snaps to the edges and centres of other objects", () => {
    const other = { x: 200, y: 300, width: 100, height: 40 };
    const snap = snapBox({ x: 203, y: 345, width: 60, height: 20 }, [other], page, 6);
    expect(snap.dx).toBe(-3); // left edges
    expect(snap.dy).toBe(-5); // top of the moving box meets the bottom of the other
    expect(snap.guides).toHaveLength(2);
  });

  it("does nothing when nothing is near", () => {
    const snap = snapBox({ x: 123, y: 456, width: 10, height: 10 }, [], page, 6);
    expect(snap).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("aligns boxes to each other, or one box to the page", () => {
    const boxes = [{ x: 10, y: 10, width: 20, height: 20 }, { x: 100, y: 50, width: 40, height: 10 }];
    expect(alignmentShifts(boxes, "left")).toEqual([{ dx: 0, dy: 0 }, { dx: -90, dy: 0 }]);
    expect(alignmentShifts(boxes, "right")).toEqual([{ dx: 110, dy: 0 }, { dx: 0, dy: 0 }]);
    expect(alignmentShifts(boxes, "top")).toEqual([{ dx: 0, dy: 0 }, { dx: 0, dy: -40 }]);
    expect(alignmentShifts([boxes[0] as Box], "centre", page)).toEqual([{ dx: 280, dy: 0 }]);
    expect(alignmentShifts([boxes[0] as Box], "middle", page)).toEqual([{ dx: 0, dy: 380 }]);
    expect(alignmentShifts([boxes[0] as Box], "bottom", page)).toEqual([{ dx: 0, dy: 770 }]);
  });

  it("spreads three boxes evenly", () => {
    const boxes = [{ x: 0, y: 0, width: 10, height: 10 }, { x: 15, y: 0, width: 10, height: 10 }, { x: 100, y: 0, width: 10, height: 10 }];
    const shifts = distributeShifts(boxes, "x");
    // total span 110, boxes 30 wide, two gaps of 40
    expect(shifts[1]).toEqual({ dx: 35, dy: 0 });
    expect(shifts[0]).toEqual({ dx: 0, dy: 0 });
    expect(distributeShifts(boxes.slice(0, 2), "x")).toEqual([{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
  });
});

describe("the page on the screen", () => {
  const w = 600;
  const h = 800;
  const zoom = 1.5;

  it("sizes the slot, swapping width and height for a quarter turn", () => {
    expect(slotSize(w, h, zoom, 0)).toEqual({ width: 900, height: 1200 });
    expect(slotSize(w, h, zoom, 90)).toEqual({ width: 1200, height: 900 });
    expect(slotSize(w, h, zoom, 180)).toEqual({ width: 900, height: 1200 });
    expect(slotSize(w, h, zoom, 270)).toEqual({ width: 1200, height: 900 });
  });

  it("maps screen points to page points and back, at every rotation and zoom", () => {
    for (const rotation of [0, 90, 180, 270] as Rotation[]) {
      for (const z of [0.25, 1, 1.5, 4]) {
        for (const p of [{ x: 0, y: 0 }, { x: 600, y: 800 }, { x: 123.5, y: 77.25 }, { x: 599, y: 1 }]) {
          const slot = baseToSlot(p, w, h, z, rotation);
          close(slotToBase(slot, w, h, z, rotation), p, 9);
          const size = slotSize(w, h, z, rotation);
          expect(slot.x).toBeGreaterThanOrEqual(-1e-9);
          expect(slot.y).toBeGreaterThanOrEqual(-1e-9);
          expect(slot.x).toBeLessThanOrEqual(size.width + 1e-9);
          expect(slot.y).toBeLessThanOrEqual(size.height + 1e-9);
        }
      }
    }
  });

  it("puts the page's own top-left corner where a turned page shows it", () => {
    // turned a quarter clockwise, the original top-left corner is at the top-right of the slot
    close(baseToSlot({ x: 0, y: 0 }, w, h, 1, 90), { x: 800, y: 0 });
    close(baseToSlot({ x: 0, y: 0 }, w, h, 1, 180), { x: 600, y: 800 });
    close(baseToSlot({ x: 0, y: 0 }, w, h, 1, 270), { x: 0, y: 600 });
  });

  it("has a CSS transform that agrees with the mapping", () => {
    expect(stageTransform(w, h, 2, 0)).toBe("none");
    expect(stageTransform(w, h, 2, 90)).toBe("translate(1600px, 0) rotate(90deg)");
    expect(stageTransform(w, h, 1, 180)).toBe("translate(600px, 800px) rotate(180deg)");
    expect(stageTransform(w, h, 1, 270)).toBe("translate(0, 600px) rotate(270deg)");
    // check by applying the transform to a point by hand: rotate(90deg) then translate
    const apply = (p: Pt, rotation: Rotation, z: number) => {
      const x = p.x * z;
      const y = p.y * z;
      if (rotation === 90) return { x: h * z - y, y: x };
      if (rotation === 180) return { x: w * z - x, y: h * z - y };
      if (rotation === 270) return { x: y, y: w * z - x };
      return { x, y };
    };
    for (const rotation of [0, 90, 180, 270] as Rotation[]) close(apply({ x: 37, y: 91 }, rotation, 2), baseToSlot({ x: 37, y: 91 }, w, h, 2, rotation), 9);
  });

  it("fits a page into an area", () => {
    expect(fitZoom({ width: 1000, height: 700 }, { width: 500, height: 700 }, "width", 0)).toBeCloseTo(2);
    expect(fitZoom({ width: 1000, height: 700 }, { width: 500, height: 700 }, "page", 0)).toBeCloseTo(1);
    expect(fitZoom({ width: 10, height: 10 }, { width: 5000, height: 5000 }, "page", 0)).toBe(MIN_ZOOM);
    expect(fitZoom({ width: 99999, height: 99999 }, { width: 5, height: 5 }, "page", 0)).toBe(MAX_ZOOM);
  });

  it("steps through the preset zoom levels", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(1.1, 1)).toBe(1.25);
    expect(stepZoom(1.1, -1)).toBe(1);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });
});
