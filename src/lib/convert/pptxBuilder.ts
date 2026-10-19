import { toBase64 } from "../bytes";
import { sanitize } from "./layout";

export interface SlideInput {
  /** The page as a JPEG picture. */
  jpeg: Uint8Array;
  /** Size of the page in points. */
  width: number;
  height: number;
  /** The page's text, stored in the speaker notes so it stays searchable. */
  notes: string;
}

/**
 * Builds a .pptx with one slide per page. The slide takes the first page's size; pages of another shape
 * are centred without distortion.
 */
export async function buildPptx(slides: readonly SlideInput[], meta: { title: string; author: string }): Promise<Uint8Array> {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const pptx = new PptxGenJS();
  const first = slides[0];
  const slideWidth = (first?.width ?? 720) / 72;
  const slideHeight = (first?.height ?? 540) / 72;
  pptx.defineLayout({ name: "PDF_PAGE", width: slideWidth, height: slideHeight });
  pptx.layout = "PDF_PAGE";
  pptx.title = sanitize(meta.title);
  pptx.author = meta.author;

  for (const input of slides) {
    const slide = pptx.addSlide();
    const scale = Math.min(slideWidth / (input.width / 72), slideHeight / (input.height / 72));
    const w = (input.width / 72) * scale;
    const h = (input.height / 72) * scale;
    slide.addImage({ data: `image/jpeg;base64,${toBase64(input.jpeg)}`, x: (slideWidth - w) / 2, y: (slideHeight - h) / 2, w, h });
    if (input.notes.trim() !== "") slide.addNotes(sanitize(input.notes));
  }
  const output = await pptx.write({ outputType: "uint8array" });
  return output as Uint8Array;
}
