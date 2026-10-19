import { BlendMode, LineCapStyle, type PDFFont } from "@cantoo/pdf-lib";
import { AppError } from "../errors";
import { baseName, plural } from "../format";
import { type Annotation, arrowHead, baselineOf, strokePath, textLines } from "./annotateModel";
import { finishEdit, loadForEdit } from "./document";
import { inDisplaySpace, parseColor } from "./draw";
import { resolveFont } from "./fonts";
import { type Prepared, embedImage } from "./images";
import { type JobContext, type OutputFile, type PdfInput, reportProgress } from "./types";

const finite = (...values: number[]) => values.every((value) => Number.isFinite(value));

function validate(note: Annotation, pageCount: number): void {
  const where = `on page ${note.page}`;
  if (!Number.isInteger(note.page) || note.page < 1 || note.page > pageCount) {
    throw new AppError("INVALID_INPUT", `An item is placed on page ${note.page}, but this document has ${plural(pageCount, "page")}.`);
  }
  const opacity = "opacity" in note ? note.opacity : 1;
  if (!(opacity >= 0 && opacity <= 1)) throw new AppError("INVALID_INPUT", `An item ${where} has an opacity outside 0 to 100%.`);

  switch (note.kind) {
    case "text":
      if (!finite(note.x, note.y, note.fontSize) || note.fontSize < 1 || note.fontSize > 500) throw new AppError("INVALID_INPUT", `A text item ${where} has an invalid position or size.`);
      if (note.text.trim() === "") throw new AppError("INVALID_INPUT", `A text item ${where} is empty. Type some text or delete it.`);
      if (note.text.length > 5000) throw new AppError("INVALID_INPUT", `A text item ${where} is too long. Keep each one under 5,000 characters.`);
      parseColor(note.color);
      return;
    case "line":
      if (!finite(note.x1, note.y1, note.x2, note.y2, note.strokeWidth) || note.strokeWidth <= 0) throw new AppError("INVALID_INPUT", `A line ${where} has an invalid position or thickness.`);
      parseColor(note.color);
      return;
    case "draw":
      if (note.points.length === 0 || !note.points.every((p) => finite(p[0], p[1])) || !finite(note.strokeWidth) || note.strokeWidth <= 0) {
        throw new AppError("INVALID_INPUT", `A drawing ${where} has no valid points.`);
      }
      parseColor(note.color);
      return;
    case "image":
      if (!(note.image.bytes.length > 0)) throw new AppError("INVALID_INPUT", `An image ${where} has no data.`);
      break;
    case "rect":
    case "ellipse":
      if (note.stroke === null && note.fill === null) throw new AppError("INVALID_INPUT", `A shape ${where} has neither an outline nor a fill.`);
      if (note.stroke) parseColor(note.stroke);
      if (note.fill) parseColor(note.fill);
      if (!finite(note.strokeWidth) || note.strokeWidth < 0) throw new AppError("INVALID_INPUT", `A shape ${where} has an invalid outline thickness.`);
      break;
    default:
      parseColor(note.color);
  }
  if (!finite(note.x, note.y, note.width, note.height) || note.width <= 0 || note.height <= 0) {
    throw new AppError("INVALID_INPUT", `An item ${where} has an invalid position or size.`);
  }
}

/**
 * Draws the editor's annotations onto the pages. Items are placed by what the viewer shows (rotation and
 * box offsets are handled), in the order given, so later items sit on top of earlier ones. The original
 * page content is never changed or removed: covering something with a box hides it from view only.
 */
export async function applyAnnotations(input: PdfInput, annotations: readonly Annotation[], ctx?: JobContext): Promise<OutputFile> {
  if (annotations.length === 0) throw new AppError("INVALID_INPUT", "Add something to the document first: text, a drawing, a highlight or a shape.");
  reportProgress(ctx, 0.05, "Opening the PDF");
  const doc = await loadForEdit(input);
  const pages = doc.getPages();
  for (const note of annotations) validate(note, pages.length);

  // Everything that needs awaiting is prepared before drawing starts.
  reportProgress(ctx, 0.2, "Preparing fonts and images");
  const fonts = new Map<string, PDFFont>();
  const pictures = new Map<Uint8Array, Prepared>();
  for (const note of annotations) {
    if (note.kind === "text") fonts.set(note.id, await resolveFont(doc, { family: note.family, bold: note.bold, italic: note.italic }, note.text));
    if (note.kind === "image" && !pictures.has(note.image.bytes)) pictures.set(note.image.bytes, await embedImage(doc, note.image));
  }

  const byPage = new Map<number, Annotation[]>();
  for (const note of annotations) byPage.set(note.page, [...(byPage.get(note.page) ?? []), note]);

  let done = 0;
  for (const [pageNumber, notes] of byPage) {
    const page = pages[pageNumber - 1];
    if (!page) continue;
    inDisplaySpace(page, (frame) => {
      const Y = (y: number) => frame.displayHeight - y; // editor y (down from the top) -> display y (up from the bottom)
      for (const note of notes) {
        switch (note.kind) {
          case "text": {
            const font = fonts.get(note.id) as PDFFont;
            textLines(note.text).forEach((line, index) => {
              if (line !== "") page.drawText(line, { x: note.x, y: Y(baselineOf(note, index)), size: note.fontSize, font, color: parseColor(note.color) });
            });
            break;
          }
          case "highlight":
            page.drawRectangle({ x: note.x, y: Y(note.y + note.height), width: note.width, height: note.height, color: parseColor(note.color), opacity: note.opacity, blendMode: BlendMode.Multiply });
            break;
          case "whiteout":
            page.drawRectangle({ x: note.x, y: Y(note.y + note.height), width: note.width, height: note.height, color: parseColor(note.color) });
            break;
          case "rect":
            page.drawRectangle({
              x: note.x,
              y: Y(note.y + note.height),
              width: note.width,
              height: note.height,
              color: note.fill ? parseColor(note.fill) : undefined,
              opacity: note.fill ? note.opacity : undefined,
              borderColor: note.stroke ? parseColor(note.stroke) : undefined,
              borderWidth: note.stroke ? note.strokeWidth : 0,
              borderOpacity: note.opacity,
            });
            break;
          case "ellipse":
            page.drawEllipse({
              x: note.x + note.width / 2,
              y: Y(note.y + note.height / 2),
              xScale: note.width / 2,
              yScale: note.height / 2,
              color: note.fill ? parseColor(note.fill) : undefined,
              opacity: note.fill ? note.opacity : undefined,
              borderColor: note.stroke ? parseColor(note.stroke) : undefined,
              borderWidth: note.stroke ? note.strokeWidth : 0,
              borderOpacity: note.opacity,
            });
            break;
          case "line": {
            const color = parseColor(note.color);
            const stroke = (ax: number, ay: number, bx: number, by: number) =>
              page.drawLine({ start: { x: ax, y: Y(ay) }, end: { x: bx, y: Y(by) }, thickness: note.strokeWidth, color, opacity: note.opacity, lineCap: LineCapStyle.Round });
            stroke(note.x1, note.y1, note.x2, note.y2);
            if (note.arrow) {
              for (const [hx, hy] of arrowHead(note.x1, note.y1, note.x2, note.y2, note.strokeWidth)) stroke(note.x2, note.y2, hx, hy);
            }
            break;
          }
          case "draw":
            // The path is in editor coordinates (y down), which is what drawSvgPath expects relative to its origin.
            page.drawSvgPath(strokePath(note.points), { x: 0, y: frame.displayHeight, borderColor: parseColor(note.color), borderWidth: note.strokeWidth, borderOpacity: note.opacity, borderLineCap: LineCapStyle.Round });
            break;
          case "image": {
            const picture = pictures.get(note.image.bytes) as Prepared;
            page.drawImage(picture.image, { x: note.x, y: Y(note.y + note.height), width: note.width, height: note.height, opacity: note.opacity });
            break;
          }
        }
      }
    });
    done += 1;
    reportProgress(ctx, 0.3 + (done / byPage.size) * 0.6, `Drawing on page ${pageNumber}`);
  }

  reportProgress(ctx, 0.92, "Saving and checking the result");
  const result = await finishEdit(doc, `${baseName(input.name)}_edited.pdf`, pages.length);
  reportProgress(ctx, 1);
  return result;
}
