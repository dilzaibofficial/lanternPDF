import { degrees } from "@cantoo/pdf-lib";
import { AppError } from "../errors";
import { baseName } from "../format";
import { finishEdit, loadForEdit, selectedPages } from "./document";
import { inDisplaySpace, parseColor, sendNewContentToBack } from "./draw";
import { type FontChoice, type FontFamily, resolveFont } from "./fonts";
import { embedImage } from "./images";
import { type JobContext, type OutputFile, type PdfInput, reportProgress } from "./types";

export type WatermarkPosition = "center" | "tiled" | "top-left" | "top-center" | "top-right" | "middle-left" | "middle-right" | "bottom-left" | "bottom-center" | "bottom-right";

export interface WatermarkOptions {
  kind: "text" | "image";
  /** The text to stamp (kind "text"). */
  text: string;
  /** PNG, JPEG, WebP, GIF or BMP bytes (kind "image"). */
  image?: { name: string; bytes: Uint8Array };
  family: FontFamily;
  bold: boolean;
  italic: boolean;
  fontSize: number;
  /** "#rrggbb" */
  color: string;
  /** 0.05 (faint) to 1 (solid). */
  opacity: number;
  /** Degrees, counter-clockwise. */
  rotation: number;
  position: WatermarkPosition;
  /** Image width as a percentage of the page width. */
  imageScale: number;
  /** Above the page content, or behind it (hidden by anything opaque, such as scanned pages). */
  layer: "over" | "under";
  /** 1-based pages, or `null` for all. */
  pages: readonly number[] | null;
  /** Distance from the edge for the corner and edge positions, in points. */
  margin: number;
  customFont?: Uint8Array;
}

export const DEFAULT_WATERMARK_OPTIONS: WatermarkOptions = {
  kind: "text",
  text: "CONFIDENTIAL",
  family: "sans",
  bold: true,
  italic: false,
  fontSize: 64,
  color: "#8a8fa0",
  opacity: 0.3,
  rotation: 45,
  position: "center",
  imageScale: 40,
  layer: "over",
  pages: null,
  margin: 36,
};

function validate(options: WatermarkOptions): void {
  if (options.kind === "text") {
    if (options.text.trim() === "") throw new AppError("INVALID_INPUT", "Enter the text for the watermark.");
    if (options.text.length > 400) throw new AppError("INVALID_INPUT", "The watermark text is too long. Keep it under 400 characters.");
    if (!Number.isFinite(options.fontSize) || options.fontSize < 4 || options.fontSize > 400) {
      throw new AppError("INVALID_INPUT", "Choose a font size between 4 and 400 points.");
    }
  } else if (!options.image) {
    throw new AppError("INVALID_INPUT", "Choose an image for the watermark.");
  } else if (!Number.isFinite(options.imageScale) || options.imageScale < 2 || options.imageScale > 100) {
    throw new AppError("INVALID_INPUT", "Choose an image size between 2% and 100% of the page width.");
  }
  if (!Number.isFinite(options.opacity) || options.opacity < 0.02 || options.opacity > 1) {
    throw new AppError("INVALID_INPUT", "Opacity must be between 2% and 100%.");
  }
  if (!Number.isFinite(options.rotation) || Math.abs(options.rotation) > 360) {
    throw new AppError("INVALID_INPUT", "Rotation must be between -360 and 360 degrees.");
  }
}

/** Size of the upright box that encloses a w x h box turned by `angle` degrees. */
function rotatedExtent(w: number, h: number, angle: number): { w: number; h: number } {
  const radians = (angle * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  return { w: w * cos + h * sin, h: w * sin + h * cos };
}

/** Where the watermark's centre goes, in display space. `w` and `h` are the size of what must fit inside the margins. */
function anchorFor(position: Exclude<WatermarkPosition, "tiled">, width: number, height: number, w: number, h: number, margin: number): { cx: number; cy: number } {
  const left = margin + w / 2;
  const right = width - margin - w / 2;
  const top = height - margin - h / 2;
  const bottom = margin + h / 2;
  const cx = position.endsWith("left") ? left : position.endsWith("right") ? right : width / 2;
  const cy = position.startsWith("top") ? top : position.startsWith("bottom") ? bottom : height / 2;
  return { cx, cy };
}

/** Lower-left corner of a w x h box that, rotated by `angle` about its centre, is centred on (cx, cy). */
function originFor(cx: number, cy: number, w: number, h: number, angle: number): { x: number; y: number } {
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: cx - ((w / 2) * cos - (h / 2) * sin), y: cy - ((w / 2) * sin + (h / 2) * cos) };
}

export async function addWatermark(input: PdfInput, options: WatermarkOptions, ctx?: JobContext): Promise<OutputFile> {
  validate(options);
  reportProgress(ctx, 0.05, "Opening the PDF");
  const doc = await loadForEdit(input);
  const pages = doc.getPages();
  const targets = selectedPages(pages.length, options.pages);
  const color = parseColor(options.color);
  const choice: FontChoice = { family: options.family, bold: options.bold, italic: options.italic };

  // Prepare the stamp once; it is drawn on every selected page.
  const font = options.kind === "text" ? await resolveFont(doc, choice, options.text, options.customFont) : null;
  const picture = options.kind === "image" && options.image ? await embedImage(doc, options.image) : null;
  const lines = options.kind === "text" ? options.text.split(/\r\n|\r|\n/) : [];
  const lineHeight = options.fontSize * 1.2;
  const textWidth = font ? Math.max(...lines.map((line) => font.widthOfTextAtSize(line, options.fontSize))) : 0;
  const textHeight = font ? lines.length * lineHeight : 0;

  /** Size of the image stamp on a page: the chosen share of the width, but never taller than the page. */
  const imageSize = (displayWidth: number, displayHeight: number): { w: number; h: number } => {
    if (!picture) return { w: 0, h: 0 };
    let w = displayWidth * (options.imageScale / 100);
    let h = (w * picture.height) / picture.width;
    const tallest = displayHeight * 0.95;
    if (h > tallest) {
      h = tallest;
      w = (h * picture.width) / picture.height;
    }
    return { w, h };
  };

  for (const [index, pageNumber] of targets.entries()) {
    const page = pages[pageNumber - 1];
    if (!page) continue;

    inDisplaySpace(page, (frame) => {
      const image = imageSize(frame.displayWidth, frame.displayHeight);
      const stampWidth = font ? textWidth : image.w;
      const stampHeight = font ? textHeight : image.h;

      /** Draws one stamp whose centre is (cx, cy), turned by the chosen rotation about that centre. */
      const stamp = (cx: number, cy: number) => {
        if (font) {
          const radians = (options.rotation * Math.PI) / 180;
          lines.forEach((line, lineIndex) => {
            const width = font.widthOfTextAtSize(line, options.fontSize);
            // This line's centre, measured up from the stamp's centre along the stamp's own "up" axis.
            const offsetUp = textHeight / 2 - lineHeight * (lineIndex + 0.5);
            const lineCx = cx - offsetUp * Math.sin(radians);
            const lineCy = cy + offsetUp * Math.cos(radians);
            // The glyph body spans roughly baseline to 0.7 em, so its centre sits 0.35 em above the baseline.
            const { x, y } = originFor(lineCx, lineCy, width, options.fontSize * 0.7, options.rotation);
            page.drawText(line, { x, y, size: options.fontSize, font, color, opacity: options.opacity, rotate: degrees(options.rotation) });
          });
        } else if (picture) {
          const { x, y } = originFor(cx, cy, image.w, image.h, options.rotation);
          page.drawImage(picture.image, { x, y, width: image.w, height: image.h, opacity: options.opacity, rotate: degrees(options.rotation) });
        }
      };

      if (options.position === "tiled") {
        const stepX = stampWidth * 1.5 + 24;
        const stepY = stampHeight * 2.2 + 24;
        const reach = Math.hypot(frame.displayWidth, frame.displayHeight);
        let row = 0;
        for (let cy = -reach; cy <= reach * 2; cy += stepY) {
          // offset alternate rows so the pattern does not form columns
          for (let cx = -reach + (row % 2 === 0 ? 0 : stepX / 2); cx <= reach * 2; cx += stepX) {
            // only stamps whose centre is near the page need drawing
            if (cx > -stampWidth && cx < frame.displayWidth + stampWidth && cy > -stampHeight && cy < frame.displayHeight + stampHeight) stamp(cx, cy);
          }
          row += 1;
        }
      } else {
        // A turned stamp is kept inside the margins by its turned outline, not by its upright box.
        const outline = rotatedExtent(stampWidth, stampHeight, options.rotation);
        const { cx, cy } = anchorFor(options.position, frame.displayWidth, frame.displayHeight, outline.w, outline.h, options.margin);
        stamp(cx, cy);
      }
    });
    if (options.layer === "under") sendNewContentToBack(page);
    if (index % 10 === 0) reportProgress(ctx, 0.1 + (index / targets.length) * 0.8, `Stamping page ${pageNumber}`);
  }

  reportProgress(ctx, 0.92, "Saving and checking the result");
  const result = await finishEdit(doc, `${baseName(input.name)}_watermarked.pdf`, pages.length);
  reportProgress(ctx, 1);
  return result;
}
