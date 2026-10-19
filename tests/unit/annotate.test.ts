import { PDFDocument, degrees, rgb } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/lib/errors";
import { applyAnnotations } from "../../src/lib/pdf/annotate";
import { type Annotation, type ShapeNote, arrowHead, boundsOf, boxFromCorners, moveAnnotation, simplifyPoints, strokePath } from "../../src/lib/pdf/annotateModel";
import { protectPdf } from "../../src/lib/pdf/security";
import { inkBounds, isBlue, isRed, isWhite, makeImage, renderPdfPage } from "./helpers/images";
import { makeTextPdf, pageGeometry, pageTexts } from "./helpers/pdf";

const input = (name: string, bytes: Uint8Array, password?: string) => ({ name, bytes, password });
const SCALE = 2; // pixels per point in the renders below

async function blankPage(width = 400, height = 300, setup?: (page: ReturnType<PDFDocument["addPage"]>) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([width, height]);
  setup?.(page);
  return doc.save();
}

let counter = 0;
const id = () => `n${(counter += 1)}`;
const text = (overrides: Partial<Extract<Annotation, { kind: "text" }>> = {}): Annotation => ({ id: id(), kind: "text", page: 1, x: 50, y: 40, text: "Hello", fontSize: 24, color: "#000000", family: "sans", bold: false, italic: false, ...overrides });
const box = (kind: "highlight" | "whiteout" | "rect" | "ellipse", overrides: Record<string, unknown> = {}): Annotation => {
  const base = { id: id(), page: 1, x: 100, y: 80, width: 120, height: 60 };
  if (kind === "highlight") return { ...base, kind, color: "#ffff00", opacity: 1, ...overrides } as Annotation;
  if (kind === "whiteout") return { ...base, kind, color: "#ffffff", ...overrides } as Annotation;
  return { ...base, kind, stroke: "#ff0000", fill: null, strokeWidth: 4, opacity: 1, ...overrides } as Annotation;
};

const px = (points: number) => points * SCALE;
async function render(bytes: Uint8Array, pageNumber = 1) {
  return renderPdfPage(bytes, pageNumber, SCALE);
}

async function expectAppError(promise: Promise<unknown>, code: string, message?: RegExp): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    if (message) expect((error as AppError).message).toMatch(message);
    return error as AppError;
  }
  throw new Error(`expected AppError ${code}`);
}

describe("annotateModel helpers", () => {
  it("builds smooth stroke paths", () => {
    expect(strokePath([])).toBe("");
    expect(strokePath([[5, 6]])).toBe("M 5 6 L 5.01 6");
    expect(strokePath([[0, 0], [10, 10]])).toBe("M 0 0 L 10 10");
    expect(strokePath([[0, 0], [10, 0], [10, 10]])).toBe("M 0 0 Q 10 0 10 5 L 10 10");
  });

  it("simplifies a stroke without losing its corners", () => {
    const line: [number, number][] = Array.from({ length: 50 }, (_, i) => [i * 2, 0.1 * (i % 2)]);
    expect(simplifyPoints(line, 1).length).toBe(2); // wobble below the tolerance disappears
    const elbow: [number, number][] = [...Array.from({ length: 20 }, (_, i) => [i, 0] as [number, number]), ...Array.from({ length: 20 }, (_, i) => [20, i + 1] as [number, number])];
    const simple = simplifyPoints(elbow, 0.5);
    expect(simple.length).toBeLessThanOrEqual(4); // two long runs and the corner between them
    expect(simple[0]).toEqual([0, 0]);
    expect(simple.at(-1)).toEqual([20, 20]);
    expect(simple.some(([x, y]) => x >= 19 && y <= 1)).toBe(true); // the corner survives
  });

  it("computes arrowheads, boxes and moves", () => {
    const [a, b] = arrowHead(0, 0, 100, 0, 2);
    expect(a[0]).toBeLessThan(100);
    expect(a[1]).toBeCloseTo(-b[1]); // symmetric about the line
    expect(boxFromCorners({ x: 30, y: 40 }, { x: 10, y: 5 })).toEqual({ x: 10, y: 5, width: 20, height: 35 });
    const moved = moveAnnotation(box("rect") as ShapeNote, 5, -3);
    expect([moved.x, moved.y]).toEqual([105, 77]);
    const line = moveAnnotation({ id: "l", kind: "line", page: 1, x1: 0, y1: 0, x2: 10, y2: 5, color: "#000", strokeWidth: 2, arrow: false, opacity: 1 }, 1, 1);
    expect([line.x1, line.y1, line.x2, line.y2]).toEqual([1, 1, 11, 6]);
    expect(boundsOf(line)).toMatchObject({ x: 0, y: 0, width: 12, height: 7 });
  });
});

describe("applyAnnotations: placement", () => {
  it("places text at the editor position, with the first baseline 0.9 em below the top", async () => {
    const out = await applyAnnotations(input("doc.pdf", await blankPage()), [text()]);
    expect(out.name).toBe("doc_edited.pdf");
    expect(out.pageCount).toBe(1);
    expect(await pageTexts(out.bytes)).toEqual(["Hello"]);
    const ink = inkBounds(await render(out.bytes), isWhite);
    expect(ink.minX).toBeGreaterThanOrEqual(px(50)); // starts at x = 50 pt, give or take the glyph's side bearing
    expect(ink.minX).toBeLessThan(px(50) + 8);
    expect(ink.maxY).toBeGreaterThan(px(40 + 0.9 * 24) - 3); // "Hello" has no descenders: the ink ends at the baseline
    expect(ink.maxY).toBeLessThan(px(40 + 0.9 * 24) + 3);
    expect(ink.minY).toBeGreaterThan(px(40)); // the capital H starts below the top of the box
  });

  it("draws several lines with the editor's line spacing", async () => {
    const out = await applyAnnotations(input("doc.pdf", await blankPage()), [text({ text: "One\n\nThree", fontSize: 20 })]);
    expect(await pageTexts(out.bytes)).toEqual(["One Three"]);
    const ink = inkBounds(await render(out.bytes), isWhite);
    // line 3 sits two line-heights (2 x 24 pt) below line 1
    const expectedBaseline = 40 + 20 * (0.9 + 2 * 1.2);
    expect(Math.abs(ink.maxY - px(expectedBaseline))).toBeLessThan(10);
  });

  it("uses bold, serif and monospace faces, and Unicode text beyond Latin-1", async () => {
    const out = await applyAnnotations(input("doc.pdf", await blankPage()), [
      text({ text: "Serif", family: "serif", bold: true, y: 20 }),
      text({ text: "mono", family: "mono", italic: true, y: 80 }),
      text({ text: "Привет Σχέδιο", y: 140 }),
    ]);
    const [content] = await pageTexts(out.bytes);
    expect(content).toContain("Serif");
    expect(content).toContain("mono");
    expect(content).toContain("Привет Σχέδιο");
  });

  it("highlights with multiply, so the text underneath stays readable", async () => {
    const source = await applyAnnotations(input("doc.pdf", await blankPage()), [text({ x: 110, y: 90, text: "Under" })]);
    const out = await applyAnnotations(input("doc.pdf", source.bytes), [box("highlight")]);
    const page = await render(out.bytes);
    const [r, g, b] = page.at(px(105), px(85)); // inside the highlight, away from the text
    expect(r).toBeGreaterThan(250);
    expect(g).toBeGreaterThan(250);
    expect(b).toBeLessThan(10);
    const dark = inkBounds(page, ([pr, pg]) => pr > 100 || pg > 100, { x0: px(100), y0: px(80), x1: px(220), y1: px(140) });
    expect(dark.count).toBeGreaterThan(80); // the black glyphs are still black inside the yellow
    expect(inkBounds(page, isWhite).minX).toBeGreaterThanOrEqual(px(100) - 1); // nothing outside the box was touched
  });

  it("covers with a whiteout, exactly over the box", async () => {
    const source = await blankPage(400, 300, (p) => p.drawRectangle({ x: 0, y: 0, width: 400, height: 300, color: rgb(0, 0, 0) }));
    const out = await applyAnnotations(input("doc.pdf", source), [box("whiteout", { x: 100, y: 80, width: 120, height: 60 })]);
    const page = await render(out.bytes);
    const white = inkBounds(page, ([r, g, b]) => !(r > 245 && g > 245 && b > 245));
    expect(white.count).toBeGreaterThan(0);
    // pixels that are NOT black are the covered box
    const notBlack = inkBounds(page, ([r]) => r < 10);
    expect(notBlack.minX).toBe(px(100));
    expect(notBlack.minY).toBe(px(80));
    expect(notBlack.maxX).toBe(px(220) - 1);
    expect(notBlack.maxY).toBe(px(140) - 1);
    expect(isWhite(page.at(px(160), px(110)))).toBe(true);
    expect(page.at(px(50), px(50))[0]).toBeLessThan(10);
  });

  it("draws rectangle outlines and fills, and ellipses", async () => {
    const out = await applyAnnotations(input("doc.pdf", await blankPage()), [
      box("rect", { x: 20, y: 20, width: 100, height: 60, stroke: "#ff0000", fill: null, strokeWidth: 6 }),
      box("rect", { x: 150, y: 20, width: 100, height: 60, stroke: null, fill: "#0000ff", strokeWidth: 0 }),
      box("ellipse", { x: 20, y: 120, width: 120, height: 80, stroke: null, fill: "#0000ff" }),
    ]);
    const page = await render(out.bytes);
    expect(isRed(page.at(px(20) + 2, px(50)))).toBe(true); // on the outline
    expect(isWhite(page.at(px(70), px(50)))).toBe(true); // hollow inside
    expect(isBlue(page.at(px(200), px(50)))).toBe(true); // filled
    expect(isBlue(page.at(px(80), px(160)))).toBe(true); // ellipse centre
    expect(isWhite(page.at(px(24), px(124)))).toBe(true); // the ellipse does not reach its bounding-box corner
    const ellipse = inkBounds(page, isWhite, { x0: 0, y0: px(110), x1: px(145), y1: px(210) });
    expect(ellipse.minX).toBeGreaterThanOrEqual(px(20) - 1);
    expect(ellipse.maxX).toBeLessThanOrEqual(px(140) + 1);
    expect(ellipse.minY).toBeGreaterThanOrEqual(px(120) - 1);
    expect(ellipse.maxY).toBeLessThanOrEqual(px(200) + 1);
  });

  it("draws lines and arrows, with the arrowhead at the second point", async () => {
    const out = await applyAnnotations(input("doc.pdf", await blankPage()), [
      { id: id(), kind: "line", page: 1, x1: 40, y1: 150, x2: 200, y2: 150, color: "#ff0000", strokeWidth: 4, arrow: true, opacity: 1 },
      { id: id(), kind: "line", page: 1, x1: 40, y1: 250, x2: 200, y2: 250, color: "#0000ff", strokeWidth: 4, arrow: false, opacity: 1 },
    ]);
    const page = await render(out.bytes);
    expect(isRed(page.at(px(120), px(150)))).toBe(true);
    expect(isBlue(page.at(px(120), px(250)))).toBe(true);
    const arrow = inkBounds(page, isWhite, { x0: px(30), y0: px(120), x1: px(210), y1: px(180) });
    const plain = inkBounds(page, isWhite, { x0: px(30), y0: px(220), x1: px(210), y1: px(280) });
    expect(arrow.maxY - arrow.minY).toBeGreaterThan(plain.maxY - plain.minY + px(8)); // the head spreads either side of the shaft
    expect(arrow.maxX).toBeLessThanOrEqual(px(200) + 6);
    // the head is near the END, not the start
    const nearStart = inkBounds(page, isWhite, { x0: px(30), y0: px(120), x1: px(60), y1: px(180) });
    expect(nearStart.maxY - nearStart.minY).toBeLessThan(px(8));
  });

  it("draws a freehand stroke where it was drawn (y not flipped)", async () => {
    const points: [number, number][] = [[50, 50], [150, 50], [150, 120]];
    const out = await applyAnnotations(input("doc.pdf", await blankPage()), [{ id: id(), kind: "draw", page: 1, points, color: "#ff0000", strokeWidth: 6, opacity: 1 }]);
    const ink = inkBounds(await render(out.bytes), isWhite);
    expect(ink.minX).toBeGreaterThanOrEqual(px(47) - 2);
    expect(ink.maxX).toBeLessThanOrEqual(px(153) + 2);
    expect(ink.minY).toBeGreaterThanOrEqual(px(47) - 2); // the top of the stroke is near y = 50 from the top
    expect(ink.maxY).toBeLessThanOrEqual(px(123) + 2);
    expect(ink.maxY).toBeGreaterThan(px(115)); // and it reaches down to y = 120
  });

  it("places an image by its box and stacks items in the order given", async () => {
    const png = makeImage("png", 40, 40, (c, w, h) => {
      c.fillStyle = "#0000ff";
      c.fillRect(0, 0, w, h);
    });
    const out = await applyAnnotations(input("doc.pdf", await blankPage()), [
      { id: id(), kind: "image", page: 1, x: 100, y: 80, width: 60, height: 30, image: { name: "logo.png", bytes: png }, opacity: 1 },
      box("rect", { x: 130, y: 90, width: 100, height: 60, stroke: null, fill: "#ff0000", strokeWidth: 0 }), // drawn later: on top
    ]);
    const page = await render(out.bytes);
    const blue = inkBounds(page, (px3) => !isBlue(px3));
    expect(blue.minX).toBe(px(100));
    expect(blue.minY).toBe(px(80));
    expect(blue.maxY).toBe(px(110) - 1);
    expect(isBlue(page.at(px(110), px(95)))).toBe(true);
    expect(isRed(page.at(px(140), px(100)))).toBe(true); // overlap: the later red box wins
  });

  it("only writes on the chosen pages and leaves the original content alone", async () => {
    const source = await makeTextPdf("Doc", 3, [400, 300]);
    const out = await applyAnnotations(input("doc.pdf", source), [text({ page: 2, text: "Note" })]);
    expect(out.pageCount).toBe(3);
    const texts = await pageTexts(out.bytes);
    expect(texts[0]).toBe("Doc p1");
    expect(texts[1]).toContain("Doc p2");
    expect(texts[1]).toContain("Note");
    expect(texts[2]).toBe("Doc p3");
  });
});

describe("applyAnnotations: unusual pages", () => {
  it("positions items by what the viewer displays on a rotated page", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 300]).setRotation(degrees(90)); // displayed 300 x 400
    const out = await applyAnnotations(input("rot.pdf", await doc.save()), [box("rect", { x: 10, y: 10, width: 50, height: 30, stroke: null, fill: "#ff0000", strokeWidth: 0 })]);
    const page = await render(out.bytes);
    expect(page.width).toBe(px(300));
    const red = inkBounds(page, (c) => !isRed(c));
    expect([red.minX, red.minY, red.maxX, red.maxY]).toEqual([px(10), px(10), px(60) - 1, px(40) - 1]); // top-left of the DISPLAYED page
    expect(await pageGeometry(out.bytes)).toEqual([{ width: 400, height: 300, rotation: 90 }]); // rotation kept
  });

  it("handles every rotation, and a page whose box does not start at the origin", async () => {
    for (const rotation of [0, 90, 180, 270]) {
      const doc = await PDFDocument.create();
      const page = doc.addPage([400, 300]);
      page.setCropBox(40, 30, 300, 200); // visible area 300 x 200 starting at (40, 30)
      page.setRotation(degrees(rotation));
      const out = await applyAnnotations(input("r.pdf", await doc.save()), [box("rect", { x: 5, y: 8, width: 40, height: 20, stroke: null, fill: "#ff0000", strokeWidth: 0 })]);
      const rendered = await render(out.bytes);
      const red = inkBounds(rendered, (c) => !isRed(c));
      expect([red.minX, red.minY, red.maxX, red.maxY], `rotation ${rotation}`).toEqual([px(5), px(8), px(45) - 1, px(28) - 1]);
    }
  });
});

describe("applyAnnotations: invalid input", () => {
  const blank = () => blankPage();

  it("needs at least one annotation", async () => {
    await expectAppError(applyAnnotations(input("d.pdf", await blank()), []), "INVALID_INPUT", /Add something/);
  });

  it("rejects items that cannot be drawn, with a message saying which page", async () => {
    const run = async (note: Annotation) => applyAnnotations(input("d.pdf", await blank()), [note]);
    await expectAppError(run(text({ page: 5 })), "INVALID_INPUT", /page 5/);
    await expectAppError(run(text({ page: 0 })), "INVALID_INPUT", /page 0/);
    await expectAppError(run(text({ text: "   " })), "INVALID_INPUT", /empty/);
    await expectAppError(run(text({ fontSize: 0 })), "INVALID_INPUT", /invalid/);
    await expectAppError(run(text({ x: Number.NaN })), "INVALID_INPUT", /invalid/);
    await expectAppError(run(text({ color: "not-a-colour" })), "INVALID_INPUT", /valid colour/);
    await expectAppError(run(box("rect", { stroke: null, fill: null })), "INVALID_INPUT", /neither an outline nor a fill/);
    await expectAppError(run(box("highlight", { width: 0 })), "INVALID_INPUT", /invalid position or size/);
    await expectAppError(run(box("highlight", { opacity: 2 })), "INVALID_INPUT", /opacity/);
    await expectAppError(run({ id: "x", kind: "draw", page: 1, points: [], color: "#000000", strokeWidth: 2, opacity: 1 }), "INVALID_INPUT", /no valid points/);
    await expectAppError(run({ id: "x", kind: "line", page: 1, x1: 0, y1: 0, x2: 5, y2: 5, color: "#000000", strokeWidth: 0, arrow: false, opacity: 1 }), "INVALID_INPUT", /thickness/);
  });

  it("rejects an image that is not an image", async () => {
    const note: Annotation = { id: "i", kind: "image", page: 1, x: 10, y: 10, width: 20, height: 20, image: { name: "x.png", bytes: new TextEncoder().encode("not an image") }, opacity: 1 };
    await expectAppError(applyAnnotations(input("d.pdf", await blank()), [note]), "INVALID_FILE");
  });

  it("accepts a password-protected PDF and writes an unprotected result", async () => {
    const locked = (await protectPdf(input("locked.pdf", await makeTextPdf("Secret", 1, [400, 300])), { userPassword: "pw" })).bytes;
    await expectAppError(applyAnnotations(input("locked.pdf", locked), [text()]), "PASSWORD_REQUIRED");
    const out = await applyAnnotations(input("locked.pdf", locked, "pw"), [text({ text: "Added" })]);
    const [content] = await pageTexts(out.bytes); // opens without a password
    expect(content).toContain("Secret");
    expect(content).toContain("Added");
  });
});
