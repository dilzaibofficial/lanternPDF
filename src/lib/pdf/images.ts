import { PDFDocument, type PDFImage } from "@cantoo/pdf-lib";
import { BRAND } from "../../config/brand";
import { AppError } from "../errors";
import { baseName, extensionOf, uniqueName } from "../format";
import { sniffType } from "../files";
import { getImageCodec, hasTransparency } from "./codec";
import { jpegOrientation } from "./exif";
import { type JobContext, MIME, type OutputFile, reportProgress } from "./types";
import { verifyPdf } from "./verify";

export type PageSizeOption = "fit" | "a4" | "a3" | "a5" | "letter" | "legal";
export type Orientation = "auto" | "portrait" | "landscape";
export type MarginOption = "none" | "small" | "large";

export interface ImageInput {
  name: string;
  bytes: Uint8Array;
}

export interface ImagesToPdfOptions {
  pageSize: PageSizeOption;
  orientation: Orientation;
  margin: MarginOption;
  /** One PDF with every image, or one PDF per image. */
  output: "single" | "separate";
}

/** Portrait sizes in PDF points (1 pt = 1/72 inch). */
const PAGE_SIZES: Record<Exclude<PageSizeOption, "fit">, readonly [number, number]> = {
  a3: [841.89, 1190.55],
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
  letter: [612, 792],
  legal: [612, 1008],
};

const MARGINS: Record<MarginOption, number> = { none: 0, small: 18, large: 36 };

/** "Fit to image" pages are sized as if the image were shown at 96 dpi. */
const PX_TO_PT = 72 / 96;

export interface Prepared {
  image: PDFImage;
  width: number;
  height: number;
}

function createDocument(): Promise<PDFDocument> {
  return PDFDocument.create({ updateMetadata: false }).then((doc) => {
    doc.setProducer(BRAND.name);
    doc.setCreator(BRAND.name);
    doc.setCreationDate(new Date());
    return doc;
  });
}

/** Embeds one image, converting it first when the PDF format cannot hold it as it is. */
export async function embedImage(doc: PDFDocument, input: ImageInput): Promise<Prepared> {
  const type = sniffType(input.bytes);
  const label = `“${input.name}”`;
  try {
    if (type === "jpeg" && jpegOrientation(input.bytes) === 1) {
      const image = await doc.embedJpg(input.bytes);
      return { image, width: image.width, height: image.height };
    }
    if (type === "png") {
      const image = await doc.embedPng(input.bytes);
      return { image, width: image.width, height: image.height };
    }
    if (type === "jpeg" || type === "webp" || type === "gif" || type === "bmp" || type === "avif") {
      // Decode (which applies EXIF rotation) and re-encode into something PDF can embed.
      const codec = getImageCodec();
      const raster = await codec.decode(input.bytes);
      const photo = (type === "jpeg" || type === "webp" || type === "avif") && !hasTransparency(raster);
      const bytes = await codec.encode(raster, photo ? "jpeg" : "png", 0.95);
      const image = photo ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
      return { image, width: image.width, height: image.height };
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("INVALID_FILE", `${label} could not be read as an image. It may be damaged.`, {
      fileName: input.name,
      details: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  }
  throw new AppError("INVALID_FILE", `${label} is not a supported image (${extensionOf(input.name) || "unknown type"}).`, { fileName: input.name });
}

/** Page size and where the image goes on it, in points. */
function layout(prepared: Prepared, options: ImagesToPdfOptions): { page: [number, number]; x: number; y: number; width: number; height: number } {
  const margin = MARGINS[options.margin];
  if (options.pageSize === "fit") {
    const width = prepared.width * PX_TO_PT;
    const height = prepared.height * PX_TO_PT;
    return { page: [width + 2 * margin, height + 2 * margin], x: margin, y: margin, width, height };
  }

  let [pageWidth, pageHeight] = PAGE_SIZES[options.pageSize];
  const landscape = options.orientation === "landscape" || (options.orientation === "auto" && prepared.width > prepared.height);
  if (landscape) [pageWidth, pageHeight] = [pageHeight, pageWidth];

  const boxWidth = pageWidth - 2 * margin;
  const boxHeight = pageHeight - 2 * margin;
  const scale = Math.min(boxWidth / prepared.width, boxHeight / prepared.height);
  const width = prepared.width * scale;
  const height = prepared.height * scale;
  return { page: [pageWidth, pageHeight], x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width, height };
}

export async function imagesToPdf(images: readonly ImageInput[], options: ImagesToPdfOptions, ctx?: JobContext): Promise<OutputFile[]> {
  if (images.length === 0) throw new AppError("INVALID_INPUT", "Add at least one image.");

  const outputs: OutputFile[] = [];
  let doc = await createDocument();
  let pagesInDoc = 0;

  const finish = async (wanted: string) => {
    const name = uniqueName(wanted, outputs.map((output) => output.name));
    const bytes = await doc.save();
    const pageCount = await verifyPdf(bytes, pagesInDoc, name);
    outputs.push({ name, bytes, mime: MIME.pdf, pageCount });
  };

  for (const [index, input] of images.entries()) {
    reportProgress(ctx, (index / images.length) * 0.9, `Adding ${input.name}`);
    const prepared = await embedImage(doc, input);
    const placement = layout(prepared, options);
    const page = doc.addPage(placement.page);
    page.drawImage(prepared.image, { x: placement.x, y: placement.y, width: placement.width, height: placement.height });
    pagesInDoc += 1;

    if (options.output === "separate") {
      await finish(`${baseName(input.name)}.pdf`);
      doc = await createDocument();
      pagesInDoc = 0;
    }
  }

  if (options.output === "single") {
    const only = images.length === 1 ? baseName((images[0] as ImageInput).name) : "images";
    await finish(`${only}.pdf`);
  }
  reportProgress(ctx, 1);
  return outputs;
}
