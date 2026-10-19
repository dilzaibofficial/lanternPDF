import { AppError } from "../errors";

/** Raw pixels, row by row, 4 bytes (R, G, B, A) per pixel. */
export interface RasterImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

/**
 * Decoding and encoding of raster images. In the browser this is built on the canvas APIs
 * (`BrowserImageCodec`); the tests install one based on `@napi-rs/canvas`. Keeping it behind an
 * interface is what lets the same engine code run in both places.
 */
export interface DecodeOptions {
  /**
   * Return the stored sample values as they are, without converting from the image's own colour profile.
   * Used when an image already inside a PDF is re-encoded: the PDF's colour space, not the JPEG's embedded
   * profile, decides what the numbers mean. (EXIF rotation is the caller's business: such images are
   * only decoded when they carry none.)
   */
  raw?: boolean;
}

export interface ImageCodec {
  /** Decodes any image the platform understands, applying its EXIF orientation. */
  decode(bytes: Uint8Array, mime?: string, options?: DecodeOptions): Promise<RasterImage>;
  encode(image: RasterImage, format: "png" | "jpeg", quality?: number): Promise<Uint8Array>;
}

let current: ImageCodec | null = null;

export function setImageCodec(codec: ImageCodec): void {
  current = codec;
}

export function getImageCodec(): ImageCodec {
  if (current) return current;
  if (typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap !== "undefined") {
    current = new BrowserImageCodec();
    return current;
  }
  throw new AppError("UNSUPPORTED", "This browser cannot process images. Please update it.");
}

/** Canvas-based codec for browsers (works in a Web Worker thanks to OffscreenCanvas). */
class BrowserImageCodec implements ImageCodec {
  async decode(bytes: Uint8Array, mime?: string, options: DecodeOptions = {}): Promise<RasterImage> {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(new Blob([bytes as BlobPart], mime ? { type: mime } : undefined), options.raw ? { colorSpaceConversion: "none" } : { imageOrientation: "from-image" });
    } catch (error) {
      throw new AppError("INVALID_FILE", "An image could not be read. It may be damaged or in a format this browser does not support.", {
        details: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new AppError("OUT_OF_MEMORY", "The browser could not allocate a canvas for this image.");
      context.drawImage(bitmap, 0, 0);
      const data = context.getImageData(0, 0, bitmap.width, bitmap.height);
      return { width: data.width, height: data.height, rgba: data.data };
    } finally {
      bitmap.close();
    }
  }

  async encode(image: RasterImage, format: "png" | "jpeg", quality = 0.92): Promise<Uint8Array> {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    if (!context) throw new AppError("OUT_OF_MEMORY", "The browser could not allocate a canvas for this image.");
    context.putImageData(new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height), 0, 0);
    const blob = await canvas.convertToBlob({ type: format === "png" ? "image/png" : "image/jpeg", quality });
    return new Uint8Array(await blob.arrayBuffer());
  }
}

/** True when any pixel is not fully opaque. */
export function hasTransparency(image: RasterImage): boolean {
  const { rgba } = image;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return true;
  return false;
}
