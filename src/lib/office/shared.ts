import { getImageCodec } from "../pdf/codec";
import type { EmbeddedImage, PdfBuilder } from "./pdfBuilder";
import { sniffImage } from "./package";
import type { Warnings } from "./warnings";

/**
 * Puts the pictures of a document into the PDF. PNG and JPEG are embedded as they are; GIF, BMP and WebP are re-encoded
 * as PNG through the platform's image decoder. A picture that cannot be read is skipped and counted.
 */
export async function embedImages(builder: PdfBuilder, media: ReadonlyMap<string, { bytes: Uint8Array }>, warnings: Warnings): Promise<Map<string, EmbeddedImage>> {
  const out = new Map<string, EmbeddedImage>();
  for (const [part, { bytes }] of media) {
    try {
      const format = sniffImage(bytes);
      if (format === "png" || format === "jpeg") {
        out.set(part, await builder.embedImage(bytes, format));
      } else if (format === "gif" || format === "bmp" || format === "webp") {
        const codec = getImageCodec();
        const raster = await codec.decode(bytes);
        out.set(part, await builder.embedImage(await codec.encode(raster, "png"), "png"));
      } else {
        warnings.add("image-format", 1, format === "unknown" ? undefined : format.toUpperCase());
      }
    } catch {
      warnings.add("image-broken");
    }
  }
  return out;
}

/** A readable list of characters, for messages: at most `limit` of them. */
export function sampleChars(codes: Iterable<number>, limit = 8): string {
  const out: string[] = [];
  for (const code of codes) {
    if (out.length >= limit) break;
    // Characters you cannot see (private use, control) are shown by their code so the message is useful.
    out.push(code < 0x20 || (code >= 0xe000 && code <= 0xf8ff) || code === 0xfffd ? `U+${code.toString(16).toUpperCase()}` : String.fromCodePoint(code));
  }
  return out.join(" ");
}
