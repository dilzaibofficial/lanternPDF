import {
  BlendMode,
  LineCapStyle,
  type PDFDocument,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  clip,
  concatTransformationMatrix,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
} from "@cantoo/pdf-lib";
import { AppError } from "../../errors";
import { arrowHead, strokePath } from "../annotateModel";
import type { PageFrame } from "../draw";
import { parseColor } from "../draw";
import { resolveFont } from "../fonts";
import { embedImage } from "../images";
import { layoutTextBox } from "../../../editor/model/textLayout";
import type { ImageObject, EditorObject, TextBoxObject, ShapeObject, LineObject, RedactObject } from "../../../editor/model/types";
import { inFrame } from "./baseSpace";

/**
 * Draws the editor's objects into a page's content: text boxes, images, shapes, lines, pen strokes and cover boxes.
 * (Markup, notes and form fields are written as annotations and form fields instead; see `annotations.ts`.)
 *
 * Objects are given in base space (top-left origin, y down). Each is drawn in its own upright frame centred on
 * the origin and then turned about its centre, so rotation, text layout and cropping all agree with the editor,
 * which draws from the same layout code.
 */

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** The matrix that places an upright frame centred on (0, 0) at a box's centre, turned `rotation` degrees clockwise on screen. */
function placement(frame: PageFrame, centre: { x: number; y: number }, rotation: number): [number, number, number, number, number, number] {
  const phi = -toRadians(rotation); // y is up here, so clockwise on screen is counter-clockwise
  return [Math.cos(phi), Math.sin(phi), -Math.sin(phi), Math.cos(phi), centre.x, frame.displayHeight - centre.y];
}

function around(page: PDFPage, frame: PageFrame, centre: { x: number; y: number }, rotation: number, flips: { x: boolean; y: boolean }, draw: () => void): void {
  const [a, b, c, d, e, f] = placement(frame, centre, rotation);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(a, b, c, d, e, f));
  if (flips.x || flips.y) page.pushOperators(concatTransformationMatrix(flips.x ? -1 : 1, 0, 0, flips.y ? -1 : 1, 0, 0));
  try {
    draw();
  } finally {
    page.pushOperators(popGraphicsState());
  }
}

/** SVG path of a rectangle with rounded corners, in y-down units with its top-left corner at the origin. */
function roundedRectPath(width: number, height: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (r === 0) return `M 0 0 H ${width} V ${height} H 0 Z`;
  return `M ${r} 0 H ${width - r} A ${r} ${r} 0 0 1 ${width} ${r} V ${height - r} A ${r} ${r} 0 0 1 ${width - r} ${height} H ${r} A ${r} ${r} 0 0 1 0 ${height - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
}

const dashes = (style: "solid" | "dashed", width: number): number[] | undefined => (style === "dashed" ? [Math.max(3, width * 3), Math.max(2, width * 2)] : undefined);

export interface DrawContext {
  doc: PDFDocument;
  /** 1-based page number, for messages. */
  pageNumber: number;
  images: Map<Uint8Array, PDFImage>;
}

function drawFilledBox(page: PDFPage, box: { width: number; height: number; radius: number }, fill: string | null, border: { color: string | null; width: number; style: "solid" | "dashed" } | null, opacity: number): void {
  const hasBorder = Boolean(border && border.color && border.width > 0);
  if (!fill && !hasBorder) return;
  const options = {
    color: fill ? parseColor(fill) : undefined,
    opacity: fill ? opacity : undefined,
    borderColor: hasBorder ? parseColor(border?.color as string) : undefined,
    borderWidth: hasBorder ? (border?.width as number) : 0,
    borderOpacity: opacity,
    borderDashArray: hasBorder ? dashes(border?.style ?? "solid", border?.width ?? 1) : undefined,
  };
  if (box.radius > 0) {
    page.drawSvgPath(roundedRectPath(box.width, box.height, box.radius), { x: -box.width / 2, y: box.height / 2, color: options.color, opacity: options.opacity, borderColor: options.borderColor, borderWidth: options.borderWidth, borderOpacity: options.borderOpacity, borderDashArray: options.borderDashArray });
  } else {
    page.drawRectangle({ x: -box.width / 2, y: -box.height / 2, width: box.width, height: box.height, ...options });
  }
}

async function drawTextBox(ctx: DrawContext, page: PDFPage, frame: PageFrame, object: TextBoxObject): Promise<void> {
  const centre = { x: object.x + object.width / 2, y: object.y + object.height / 2 };
  let font: PDFFont | null = null;
  if (object.text.trim() !== "") {
    try {
      font = await resolveFont(ctx.doc, { family: object.family, bold: object.bold, italic: object.italic }, object.text);
    } catch (error) {
      if (error instanceof AppError) throw new AppError("INVALID_INPUT", `A text box on page ${ctx.pageNumber} has characters that none of the built-in fonts can draw. Change or remove them. (${error.message})`);
      throw error;
    }
  }
  const measure = (text: string, size: number, _font: unknown, letterSpacing: number) => {
    if (!font) return text.length * size * 0.5;
    let total = 0;
    let count = 0;
    for (const ch of text) {
      total += font.widthOfTextAtSize(ch, size);
      count += 1;
    }
    return total + letterSpacing * count;
  };
  const layout = layoutTextBox(object, measure);
  const height = object.autoHeight ? Math.max(object.height, layout.contentHeight) : object.height;
  const box = { x: object.x, y: object.y, width: object.width, height };
  const c = { x: box.x + box.width / 2, y: box.y + height / 2 };
  void centre;
  inFrame(page, frame, () =>
    around(page, frame, c, object.rotation, { x: false, y: false }, () => {
      drawFilledBox(page, { width: box.width, height, radius: object.radius }, object.fill, object.border.color ? object.border : null, object.opacity);
      if (!font) return;
      const color = parseColor(object.color);
      for (const line of layout.lines) {
        if (line.text === "") continue;
        const x = -box.width / 2 + line.x;
        const y = height / 2 - line.baseline;
        page.drawText(line.text, { x, y, size: object.size, font, color, opacity: object.opacity, characterSpacing: object.letterSpacing || undefined });
        if (object.underline) {
          page.drawLine({ start: { x, y: y - object.size * 0.12 }, end: { x: x + line.width, y: y - object.size * 0.12 }, thickness: Math.max(0.4, object.size / 18), color, opacity: object.opacity });
        }
      }
    }),
  );
}

async function drawImageObject(ctx: DrawContext, page: PDFPage, frame: PageFrame, object: ImageObject): Promise<void> {
  let image = ctx.images.get(object.image.bytes);
  if (!image) {
    const prepared = await embedImage(ctx.doc, { name: object.image.name, bytes: object.image.bytes });
    image = prepared.image;
    ctx.images.set(object.image.bytes, image);
  }
  const crop = object.crop ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const keepX = Math.max(0.05, 1 - crop.left - crop.right);
  const keepY = Math.max(0.05, 1 - crop.top - crop.bottom);
  const fullW = object.width / keepX;
  const fullH = object.height / keepY;
  const centre = { x: object.x + object.width / 2, y: object.y + object.height / 2 };
  inFrame(page, frame, () =>
    around(page, frame, centre, object.rotation, { x: object.flipX, y: object.flipY }, () => {
      page.pushOperators(pushGraphicsState());
      if (object.crop) page.pushOperators(rectangle(-object.width / 2, -object.height / 2, object.width, object.height), clip(), endPath());
      // The picture is drawn at its full size, shifted so that the kept part fills the box.
      page.drawImage(image as PDFImage, { x: -object.width / 2 - crop.left * fullW, y: -object.height / 2 - crop.bottom * fullH, width: fullW, height: fullH, opacity: object.opacity });
      page.pushOperators(popGraphicsState());
      if (object.border.color && object.border.width > 0) drawFilledBox(page, { width: object.width, height: object.height, radius: 0 }, null, object.border, object.opacity);
    }),
  );
}

function drawShape(page: PDFPage, frame: PageFrame, object: ShapeObject): void {
  const centre = { x: object.x + object.width / 2, y: object.y + object.height / 2 };
  if (!object.fill && !(object.stroke && object.strokeWidth > 0)) return;
  inFrame(page, frame, () =>
    around(page, frame, centre, object.rotation, { x: false, y: false }, () => {
      if (object.kind === "rect") {
        drawFilledBox(page, { width: object.width, height: object.height, radius: object.radius }, object.fill, object.stroke ? { color: object.stroke, width: object.strokeWidth, style: object.strokeStyle } : null, object.opacity);
      } else {
        page.drawEllipse({
          x: 0,
          y: 0,
          xScale: object.width / 2,
          yScale: object.height / 2,
          color: object.fill ? parseColor(object.fill) : undefined,
          opacity: object.fill ? object.opacity : undefined,
          borderColor: object.stroke && object.strokeWidth > 0 ? parseColor(object.stroke) : undefined,
          borderWidth: object.stroke ? object.strokeWidth : 0,
          borderOpacity: object.opacity,
          borderDashArray: dashes(object.strokeStyle, object.strokeWidth),
        });
      }
    }),
  );
}

function drawLineObject(page: PDFPage, frame: PageFrame, object: LineObject): void {
  const H = frame.displayHeight;
  const color = parseColor(object.color);
  const dash = dashes(object.strokeStyle, object.strokeWidth);
  inFrame(page, frame, () => {
    const stroke = (ax: number, ay: number, bx: number, by: number, dashed?: number[]) => page.drawLine({ start: { x: ax, y: H - ay }, end: { x: bx, y: H - by }, thickness: object.strokeWidth, color, opacity: object.opacity, lineCap: LineCapStyle.Round, dashArray: dashed });
    stroke(object.x1, object.y1, object.x2, object.y2, dash);
    if (object.arrow !== "none") for (const [hx, hy] of arrowHead(object.x1, object.y1, object.x2, object.y2, object.strokeWidth)) stroke(object.x2, object.y2, hx, hy);
    if (object.arrow === "both") for (const [hx, hy] of arrowHead(object.x2, object.y2, object.x1, object.y1, object.strokeWidth)) stroke(object.x1, object.y1, hx, hy);
  });
}

/**
 * Draws `objects` (in the order given, so later ones are on top) onto `page`. Returns how many were drawn into the
 * content; annotation kinds are skipped here.
 */
/** The words in a redaction box (such as "REDACTED"), centred, in a colour that stands out from the box. */
async function drawRedactionLabel(ctx: DrawContext, page: PDFPage, frame: PageFrame, object: RedactObject): Promise<void> {
  const font = await resolveFont(ctx.doc, { family: "sans", bold: true, italic: false }, object.label);
  const box = parseColor(object.color);
  const light = 0.299 * box.red + 0.587 * box.green + 0.114 * box.blue > 0.55;
  const available = Math.max(4, object.height - 4);
  let size = Math.min(available * 0.7, 18);
  const width = font.widthOfTextAtSize(object.label, size);
  if (width > object.width - 4) size = Math.max(3, (size * (object.width - 4)) / Math.max(1, width));
  const textWidth = font.widthOfTextAtSize(object.label, size);
  const centre = { x: object.x + object.width / 2, y: object.y + object.height / 2 };
  inFrame(page, frame, () =>
    around(page, frame, centre, object.rotation, { x: false, y: false }, () => {
      page.drawText(object.label, { x: -textWidth / 2, y: -size * 0.35, size, font, color: light ? rgb(0, 0, 0) : rgb(1, 1, 1) });
    }),
  );
}

export async function drawObjects(ctx: DrawContext, page: PDFPage, frame: PageFrame, objects: readonly EditorObject[]): Promise<number> {
  let drawn = 0;
  for (const object of objects) {
    switch (object.kind) {
      case "text":
        await drawTextBox(ctx, page, frame, object);
        drawn += 1;
        break;
      case "image":
        await drawImageObject(ctx, page, frame, object);
        drawn += 1;
        break;
      case "rect":
      case "ellipse":
        drawShape(page, frame, object);
        drawn += 1;
        break;
      case "line":
        drawLineObject(page, frame, object);
        drawn += 1;
        break;
      case "draw": {
        const H = frame.displayHeight;
        inFrame(page, frame, () => page.drawSvgPath(strokePath(object.points), { x: 0, y: H, borderColor: parseColor(object.color), borderWidth: object.strokeWidth, borderOpacity: object.opacity, borderLineCap: LineCapStyle.Round }));
        drawn += 1;
        break;
      }
      case "redact": {
        // What is under it has been removed from the file; this is the box left in its place.
        const centre = { x: object.x + object.width / 2, y: object.y + object.height / 2 };
        inFrame(page, frame, () => around(page, frame, centre, object.rotation, { x: false, y: false }, () => page.drawRectangle({ x: -object.width / 2, y: -object.height / 2, width: object.width, height: object.height, color: parseColor(object.color) })));
        if (object.label.trim() !== "") await drawRedactionLabel(ctx, page, frame, object);
        drawn += 1;
        break;
      }
      case "cover": {
        const centre = { x: object.x + object.width / 2, y: object.y + object.height / 2 };
        inFrame(page, frame, () => around(page, frame, centre, object.rotation, { x: false, y: false }, () => page.drawRectangle({ x: -object.width / 2, y: -object.height / 2, width: object.width, height: object.height, color: parseColor(object.color), opacity: object.opacity })));
        drawn += 1;
        break;
      }
      default:
        break;
    }
  }
  return drawn;
}

export { BlendMode };
