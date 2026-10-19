/** PowerPoint (.pptx) to PDF. */
import { AppError } from "../../errors";
import { FontLibrary, type FontRequest, familyFor } from "../fontLibrary";
import { OfficePackage } from "../package";
import { PdfBuilder } from "../pdfBuilder";
import { embedImages, sampleChars } from "../shared";
import { TextShaper } from "../textflow";
import type { ConversionResult, ConvertOptions } from "../types";
import { Warnings } from "../warnings";
import type { SlideM, TextBodyM } from "./model";
import { PptxReader } from "./read";
import { type RenderContext, bulletText, renderSlide, toTextStyle } from "./render";

/** Every font face the slides use, with the characters set in it, so fonts load once before layout. */
function collectFontRequests(slides: readonly SlideM[]): { request: FontRequest; text: string }[] {
  const wanted = new Map<string, { request: FontRequest; chars: Set<string> }>();
  const add = (request: FontRequest, text: string) => {
    const key = `${request.family}|${request.bold}|${request.italic}`;
    let entry = wanted.get(key);
    if (!entry) {
      entry = { request, chars: new Set() };
      wanted.set(key, entry);
    }
    for (const char of text) entry.chars.add(char);
  };
  const body = (text: TextBodyM) => {
    for (const paragraph of text.paragraphs) {
      const base = toTextStyle(paragraph.run, 1);
      add({ family: base.family, bold: base.bold, italic: base.italic }, "0123456789");
      let lead = base;
      paragraph.items.forEach((item, index) => {
        const style = toTextStyle(item.style, 1);
        if (index === 0) lead = style;
        const shown = item.kind === "break" ? "" : item.kind === "field" ? `${item.text}0123456789` : item.text;
        add({ family: style.family, bold: style.bold, italic: style.italic }, shown);
      });
      const bullet = paragraph.style.bullet;
      if (bullet && (bullet.kind === "char" || bullet.kind === "auto")) {
        const font = bullet.font && !bullet.font.startsWith("+") ? bullet.font : undefined;
        const sample = bullet.kind === "char" ? bulletText(bullet.char, font).text : "0123456789.()abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
        add({ family: font ? familyFor(font) : lead.family, bold: lead.bold, italic: lead.italic }, sample);
      }
    }
  };
  for (const slide of slides) {
    for (const shape of slide.shapes) {
      if (shape.kind === "shape" && shape.text) body(shape.text);
      else if (shape.kind === "table") for (const row of shape.rows) for (const cell of row.cells) body(cell.text);
    }
  }
  return [...wanted.values()].map(({ request, chars }) => ({ request, text: [...chars].join("") }));
}

export async function convertPptx(bytes: Uint8Array, options: ConvertOptions = {}): Promise<ConversionResult> {
  const progress = (fraction: number, message?: string) => options.onProgress?.(fraction, message);
  progress(0.03, "Opening the presentation");
  const pack = OfficePackage.open(bytes, "pptx");
  const warnings = new Warnings();
  const model = new PptxReader(pack, warnings).read();

  // Hidden slides are left out, as PowerPoint leaves them out of a printout, unless every slide is hidden.
  const visible = model.slides.filter((slide) => !slide.hidden);
  const slides = visible.length > 0 ? visible : model.slides;
  if (slides.length === 0) throw new AppError("INVALID_FILE", "This presentation has no slides to convert.");
  if (visible.length > 0 && visible.length < model.slides.length) warnings.add("slide-hidden", model.slides.length - visible.length);

  progress(0.2, "Loading fonts");
  const fonts = new FontLibrary();
  await fonts.prepare(collectFontRequests(slides));
  const shaper = new TextShaper(fonts);

  progress(0.3, "Preparing pictures");
  const builder = await PdfBuilder.create();
  const images = await embedImages(builder, model.media, warnings);

  const pageOfSlide = new Map(slides.map((slide, index) => [slide.part, index]));
  const context: RenderContext = { builder, shaper, images, warnings, pageOfSlide, model };
  slides.forEach((slide, index) => {
    progress(0.35 + 0.6 * (index / slides.length), `Slide ${index + 1} of ${slides.length}`);
    renderSlide(context, slide);
  });
  if (shaper.warnings.unsupported.size > 0) warnings.add("missing-glyphs", shaper.warnings.unsupported.size, sampleChars(shaper.warnings.unsupported));

  const baseName = (options.name ?? "").replace(/\.[^.]+$/, "");
  const out = await builder.save({ title: model.title || baseName || undefined, author: model.author });
  progress(0.98, "Done");
  return { bytes: out, pageCount: slides.length, warnings: warnings.messages() };
}
