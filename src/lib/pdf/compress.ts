import { PDFArray, PDFBool, PDFDict, type PDFDocument, PDFName, PDFNull, PDFNumber, type PDFObject, PDFRawStream, PDFRef, PDFStream } from "@cantoo/pdf-lib";
import { unzlibSync, zlibSync } from "fflate";
import { AppError, toAppError } from "../errors";
import { baseName, plural } from "../format";
import { getImageCodec } from "./codec";
import { type UsageReport, scanImageUsage } from "./contentScan";
import { deduplicateStreams, stripThumbnails } from "./dedupe";
import { loadForEdit } from "./document";
import { jpegOrientation } from "./exif";
import { countPagesIn } from "./inspect";
import { jpegFrame } from "./jpeg";
import { looksLikePhoto, packComponents, predictRows, resizeArea, unpackToRgba, unpredict } from "./pixels";
import { passwordArg, runChecked, withQpdf } from "./qpdf";
import { type JobContext, MIME, type OutputFile, type PdfInput, reportProgress } from "./types";
import { verifyPdf } from "./verify";

/**
 * - lossless: no pixel changes. Identical resources are merged and the file is rewritten compactly.
 * - balanced: also reduces images that are sharper than 150 dpi and re-saves photos as JPEG (quality 70).
 * - strong: images down to 96 dpi, JPEG quality 50.
 */
export type CompressLevel = "lossless" | "balanced" | "strong";
export const COMPRESS_LEVELS: readonly CompressLevel[] = ["lossless", "balanced", "strong"];

export interface CompressOptions {
  level: CompressLevel;
}

export interface ImageProfile {
  /** Images drawn at a higher resolution than this are reduced to it. */
  maxDpi: number;
  /** JPEG quality, 0 to 1. */
  quality: number;
}

export const IMAGE_PROFILES: Record<Exclude<CompressLevel, "lossless">, ImageProfile> = {
  balanced: { maxDpi: 150, quality: 0.7 },
  strong: { maxDpi: 96, quality: 0.5 },
};

/** Why an image was left exactly as it was. */
export type SkipReason =
  | "unused" // not painted by any page content we could read (annotations, patterns, unreadable streams)
  | "colour" // CMYK, indexed, spot or Lab colour: converting would change the colours
  | "format" // JPEG 2000, CCITT, JBIG2, 1-bit and 16-bit images, unusual decode arrays
  | "mask" // stencil masks, colour-key masks and soft masks
  | "tooSmall"
  | "tooLarge"
  | "orientation" // a JPEG with an EXIF rotation tag: viewers ignore it, decoders do not
  | "failed" // could not be decoded or encoded
  | "noGain"; // already compact: re-encoding would not make it meaningfully smaller

export interface ImageReport {
  /** Every image XObject found in the file. */
  total: number;
  /** Images replaced with a smaller encoding. */
  optimized: number;
  /** Of those, how many had their resolution reduced. */
  downsampled: number;
  skipped: Partial<Record<SkipReason, number>>;
  /** Bytes saved by the images alone, before the structural clean-up. */
  bytesSaved: number;
}

export interface CompressResult {
  /** The compressed file, or the original, unchanged, when nothing smaller could be made (`smaller` is false). */
  file: OutputFile;
  originalBytes: number;
  smaller: boolean;
  images: ImageReport;
  /** Identical embedded resources (fonts, images, profiles) that were merged into one. */
  duplicatesRemoved: number;
  /** What was done and what was left alone, in plain language. */
  notes: string[];
}

const MIN_IMAGE_BYTES = 4096;
const MAX_PIXELS = 100_000_000;
/** An image is only reduced when it is clearly sharper than the target, so near misses are left alone. */
const DOWNSAMPLE_MARGIN = 1.15;
/** A re-encoded image replaces the original only when it is at least 8% smaller. */
const MIN_GAIN = 0.92;
/** The whole result is only offered when it is at least 1% smaller than the original. */
const MIN_SAVING = 0.01;

const N = {
  Subtype: PDFName.of("Subtype"),
  Image: PDFName.of("Image"),
  Width: PDFName.of("Width"),
  Height: PDFName.of("Height"),
  BitsPerComponent: PDFName.of("BitsPerComponent"),
  ColorSpace: PDFName.of("ColorSpace"),
  Filter: PDFName.of("Filter"),
  DecodeParms: PDFName.of("DecodeParms"),
  Decode: PDFName.of("Decode"),
  ImageMask: PDFName.of("ImageMask"),
  Mask: PDFName.of("Mask"),
  SMask: PDFName.of("SMask"),
  SMaskInData: PDFName.of("SMaskInData"),
  Matte: PDFName.of("Matte"),
  N: PDFName.of("N"),
  Predictor: PDFName.of("Predictor"),
  Colors: PDFName.of("Colors"),
  Columns: PDFName.of("Columns"),
  DCTDecode: PDFName.of("DCTDecode"),
  FlateDecode: PDFName.of("FlateDecode"),
  DeviceGray: PDFName.of("DeviceGray"),
  DeviceRGB: PDFName.of("DeviceRGB"),
  DeviceCMYK: PDFName.of("DeviceCMYK"),
  ICCBased: PDFName.of("ICCBased"),
  CalGray: PDFName.of("CalGray"),
  CalRGB: PDFName.of("CalRGB"),
};

export interface ImageInfo {
  width: number;
  height: number;
  components: 1 | 3;
  source: "dct" | "flate" | "raw";
  /** Present only for Flate data stored with a predictor (the usual case for PNG-derived images). */
  predictor: { predictor: number; columns: number; colors: number; bits: number } | null;
}

/** Number of colour components when the colour space is plain grey or RGB; otherwise why not. */
function componentsOf(space: PDFObject | undefined): 1 | 3 | SkipReason {
  if (space instanceof PDFName) {
    if (space === N.DeviceGray) return 1;
    if (space === N.DeviceRGB) return 3;
    return "colour";
  }
  if (space instanceof PDFArray && space.size() >= 1) {
    const family = space.lookup(0);
    if (family === N.CalGray) return 1;
    if (family === N.CalRGB) return 3;
    if (family === N.ICCBased) {
      const profile = space.lookupMaybe(1, PDFStream);
      const count = profile?.dict.lookupMaybe(N.N, PDFNumber)?.asNumber();
      return count === 1 ? 1 : count === 3 ? 3 : "colour";
    }
  }
  return "colour";
}

export function describeImage(stream: PDFRawStream): ImageInfo | SkipReason {
  const { dict } = stream;
  if (dict.lookupMaybe(N.ImageMask, PDFBool)?.asBoolean() || dict.has(N.Mask)) return "mask";
  if (dict.lookupMaybe(N.SMask, PDFStream)?.dict.has(N.Matte)) return "mask";
  if ((dict.lookupMaybe(N.SMaskInData, PDFNumber)?.asNumber() ?? 0) !== 0) return "format";

  const width = dict.lookupMaybe(N.Width, PDFNumber)?.asNumber();
  const height = dict.lookupMaybe(N.Height, PDFNumber)?.asNumber();
  if (!width || !height || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return "format";
  if ((dict.lookupMaybe(N.BitsPerComponent, PDFNumber)?.asNumber() ?? 8) !== 8) return "format";

  const decode = dict.lookupMaybe(N.Decode, PDFArray);
  if (decode) {
    for (let i = 0; i < decode.size(); i += 1) {
      if (decode.lookupMaybe(i, PDFNumber)?.asNumber() !== i % 2) return "format"; // anything but the default [0 1 ...]
    }
  }

  const components = componentsOf(dict.lookup(N.ColorSpace));
  if (typeof components === "string") return components;

  const filter = dict.lookup(N.Filter);
  let name: PDFObject | undefined = filter;
  if (filter instanceof PDFArray) {
    if (filter.size() > 1) return "format";
    name = filter.size() === 1 ? filter.lookup(0) : undefined;
  }
  const source: ImageInfo["source"] | null = name === undefined || name === PDFNull ? "raw" : name === N.DCTDecode ? "dct" : name === N.FlateDecode ? "flate" : null;
  if (!source) return "format";

  const parmsObject = dict.lookup(N.DecodeParms);
  const parms = parmsObject instanceof PDFDict ? parmsObject : parmsObject instanceof PDFArray ? parmsObject.lookupMaybe(0, PDFDict) : undefined;
  let predictor: ImageInfo["predictor"] = null;
  if (source === "dct" && parms) return "format"; // ColorTransform overrides are not handled
  if (source === "flate" && parms) {
    const kind = parms.lookupMaybe(N.Predictor, PDFNumber)?.asNumber() ?? 1;
    if (kind > 1) {
      const columns = parms.lookupMaybe(N.Columns, PDFNumber)?.asNumber() ?? 1;
      const colors = parms.lookupMaybe(N.Colors, PDFNumber)?.asNumber() ?? 1;
      const bits = parms.lookupMaybe(N.BitsPerComponent, PDFNumber)?.asNumber() ?? 8;
      if (columns !== width || colors !== components || bits !== 8) return "format";
      predictor = { predictor: kind, columns, colors, bits };
    }
  }
  return { width, height, components, source, predictor };
}

/** Decodes an image to RGBA at its stored size, or says why it was left alone. */
export async function readPixels(info: ImageInfo, stream: PDFRawStream): Promise<Uint8ClampedArray | SkipReason> {
  const pixels = info.width * info.height;
  if (info.source === "dct") {
    const frame = jpegFrame(stream.contents);
    if (!frame || frame.precision !== 8) return "format";
    if (frame.components !== info.components) return "colour"; // includes CMYK
    if (frame.width !== info.width || frame.height !== info.height) return "format";
    if (jpegOrientation(stream.contents) !== 1) return "orientation";
    try {
      const raster = await getImageCodec().decode(stream.contents, "image/jpeg", { raw: true });
      return raster.width === info.width && raster.height === info.height ? raster.rgba : "failed";
    } catch {
      return "failed";
    }
  }

  let data: Uint8Array;
  try {
    data = info.source === "flate" ? unzlibSync(stream.contents) : stream.contents;
  } catch {
    return "failed";
  }
  if (info.predictor) {
    const plain = unpredict(data, info.predictor.predictor, info.predictor.columns, info.predictor.colors, info.predictor.bits, info.height);
    if (!plain) return "format";
    data = plain;
  }
  return data.length >= pixels * info.components ? unpackToRgba(data, pixels, info.components) : "failed";
}

interface Encoded {
  bytes: Uint8Array;
  kind: "jpeg" | "flate";
}

async function encodeImage(rgba: Uint8ClampedArray, width: number, height: number, info: ImageInfo, photo: boolean, profile: ImageProfile): Promise<Encoded> {
  if (photo) {
    return { bytes: await getImageCodec().encode({ width, height, rgba }, "jpeg", profile.quality), kind: "jpeg" };
  }
  // Flat graphics stay lossless: PNG-style row filters, then Flate at its strongest setting.
  const raw = packComponents(rgba, width * height, info.components);
  const filtered = predictRows(raw, width * info.components, height, info.components);
  return { bytes: zlibSync(filtered, { level: 9, mem: 12 }), kind: "flate" };
}

function applyImage(doc: PDFDocument, ref: PDFRef, stream: PDFRawStream, info: ImageInfo, width: number, height: number, encoded: Encoded): void {
  const { dict } = stream;
  dict.set(N.Width, PDFNumber.of(width));
  dict.set(N.Height, PDFNumber.of(height));
  dict.set(N.BitsPerComponent, PDFNumber.of(8));
  dict.delete(N.Decode);
  if (encoded.kind === "jpeg") {
    dict.set(N.Filter, N.DCTDecode);
    dict.delete(N.DecodeParms);
    // The encoder always writes three components, so a grey image becomes (equal-valued) RGB.
    if (info.components === 1) dict.set(N.ColorSpace, N.DeviceRGB);
  } else {
    dict.set(N.Filter, N.FlateDecode);
    dict.set(N.DecodeParms, doc.context.obj({ Predictor: 15, Colors: info.components, BitsPerComponent: 8, Columns: width }));
  }
  doc.context.assign(ref, PDFRawStream.of(dict, encoded.bytes));
}

async function optimizeImage(doc: PDFDocument, ref: PDFRef, stream: PDFRawStream, usage: UsageReport, maskRefs: Set<string>, profile: ImageProfile, report: ImageReport): Promise<void> {
  const skip = (reason: SkipReason) => {
    report.skipped[reason] = (report.skipped[reason] ?? 0) + 1;
  };
  const key = ref.toString();
  if (maskRefs.has(key)) return skip("mask");
  const info = describeImage(stream);
  if (typeof info === "string") return skip(info);
  if (stream.contents.length < MIN_IMAGE_BYTES) return skip("tooSmall");
  if (info.width * info.height > MAX_PIXELS) return skip("tooLarge");
  const used = usage.images.get(key);
  if (!used || used.width < 1 || used.height < 1) return skip("unused");

  // The limiting axis decides: shrink so that neither direction falls below the target resolution.
  const dpi = Math.min(info.width / (used.width / 72), info.height / (used.height / 72));
  const scale = dpi > profile.maxDpi * DOWNSAMPLE_MARGIN ? profile.maxDpi / dpi : 1;

  // A JPEG already stored at a low bit rate, and needing no shrinking, has nothing left to give.
  const bitsPerPixel = (stream.contents.length * 8) / (info.width * info.height);
  if (info.source === "dct" && scale === 1 && bitsPerPixel < profile.quality * 1.3) return skip("noGain");

  const pixels = await readPixels(info, stream);
  if (typeof pixels === "string") return skip(pixels);

  const width = scale < 1 ? Math.max(1, Math.round(info.width * scale)) : info.width;
  const height = scale < 1 ? Math.max(1, Math.round(info.height * scale)) : info.height;
  const rgba = scale < 1 ? resizeArea(pixels, info.width, info.height, width, height) : pixels;
  const photo = info.source === "dct" || looksLikePhoto(rgba, width, height, info.components);
  // Flat graphics that are already Flate-compressed and need no shrinking have nothing left to give either.
  if (!photo && scale === 1 && info.source === "flate") return skip("noGain");

  let encoded: Encoded;
  try {
    encoded = await encodeImage(rgba, width, height, info, photo, profile);
  } catch {
    return skip("failed");
  }
  const before = stream.contents.length;
  if (encoded.bytes.length >= before * MIN_GAIN) return skip("noGain");

  applyImage(doc, ref, stream, info, width, height, encoded);
  report.optimized += 1;
  if (scale < 1) report.downsampled += 1;
  report.bytesSaved += before - encoded.bytes.length;
}

async function recompressImages(doc: PDFDocument, profile: ImageProfile, report: ImageReport, ctx: JobContext | undefined, from: number, to: number): Promise<UsageReport> {
  const span = to - from;
  const usage = scanImageUsage(doc, (done, total) => reportProgress(ctx, from + span * 0.15 * (done / total), `Measuring images on page ${done} of ${total}`));

  const candidates: { ref: PDFRef; stream: PDFRawStream }[] = [];
  const maskRefs = new Set<string>();
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream) || object.dict.get(N.Subtype) !== N.Image) continue;
    candidates.push({ ref, stream: object });
    for (const key of [N.SMask, N.Mask]) {
      const target = object.dict.get(key);
      if (target instanceof PDFRef) maskRefs.add(target.toString());
    }
  }
  candidates.sort((a, b) => b.stream.contents.length - a.stream.contents.length); // biggest first
  report.total = candidates.length;

  for (const [index, { ref, stream }] of candidates.entries()) {
    reportProgress(ctx, from + span * (0.15 + 0.85 * (index / candidates.length)), `Optimizing image ${index + 1} of ${candidates.length}`);
    await optimizeImage(doc, ref, stream, usage, maskRefs, profile, report);
  }
  return usage;
}

/** The lossless layer: qpdf rewrites the file with object streams and strongest Flate, dropping unreachable objects. */
async function optimizeStructure(bytes: Uint8Array, password: string | undefined, name: string): Promise<Uint8Array> {
  return withQpdf((qpdf) => {
    const source = qpdf.put(bytes);
    const target = qpdf.path();
    runChecked(
      qpdf,
      [...passwordArg(password), ...(password ? ["--decrypt"] : []), "--object-streams=generate", "--compress-streams=y", "--recompress-flate", "--compression-level=9", source, target],
      { fileName: name, passwordSupplied: Boolean(password) },
    );
    return qpdf.read(target).slice();
  });
}

const SKIP_TEXT: Record<SkipReason, (count: number) => string> = {
  unused: (n) => `${plural(n, "image")} could not be matched to a page we could read (for example, used only in an annotation), so ${n === 1 ? "it was" : "they were"} left as ${n === 1 ? "it is" : "they are"}.`,
  colour: (n) => `${plural(n, "image")} use${n === 1 ? "s" : ""} CMYK, indexed or spot colours, which are not converted, so ${n === 1 ? "it was" : "they were"} left as ${n === 1 ? "it is" : "they are"}.`,
  format: (n) => `${plural(n, "image")} ${n === 1 ? "is" : "are"} stored in a format that is not re-encoded (such as scanner formats for black-and-white pages), so ${n === 1 ? "it was" : "they were"} left as ${n === 1 ? "it is" : "they are"}.`,
  mask: (n) => `${plural(n, "mask image")} ${n === 1 ? "was" : "were"} left as ${n === 1 ? "it is" : "they are"}.`,
  tooSmall: () => "",
  tooLarge: (n) => `${plural(n, "image")} ${n === 1 ? "is" : "are"} too large for the browser to process and ${n === 1 ? "was" : "were"} left as ${n === 1 ? "it is" : "they are"}.`,
  orientation: (n) => `${plural(n, "photo")} carry${n === 1 ? "ies" : ""} a rotation tag that PDF viewers ignore, so ${n === 1 ? "it was" : "they were"} left as ${n === 1 ? "it is" : "they are"}.`,
  failed: (n) => `${plural(n, "image")} could not be decoded and ${n === 1 ? "was" : "were"} left as ${n === 1 ? "it is" : "they are"}.`,
  noGain: () => "",
};

function describeImages(report: ImageReport, level: CompressLevel): string[] {
  if (level === "lossless") return [];
  const notes: string[] = [];
  if (report.total === 0) {
    notes.push("This PDF has no images, so only its structure could be optimized.");
    return notes;
  }
  if (report.optimized > 0) {
    notes.push(`${plural(report.optimized, "image")} of ${report.total} ${report.optimized === 1 ? "was" : "were"} re-encoded${report.downsampled > 0 ? `, ${report.downsampled} at a lower resolution` : ""}.`);
  }
  const unchanged = report.total - report.optimized - (report.skipped.tooSmall ?? 0);
  const already = report.skipped.noGain ?? 0;
  if (already > 0) notes.push(`${plural(already, "image")} ${already === 1 ? "was" : "were"} already compact enough, so ${already === 1 ? "it was" : "they were"} left unchanged.`);
  for (const [reason, count] of Object.entries(report.skipped) as [SkipReason, number][]) {
    const text = SKIP_TEXT[reason](count);
    if (count > 0 && text) notes.push(text);
  }
  if (report.optimized === 0 && unchanged > 0) notes.push("No image could be made meaningfully smaller at this level.");
  return notes;
}

/**
 * Makes a PDF smaller without changing what it shows (lossless) or, at the higher levels, by reducing
 * oversized images. The result is verified to open and to have the same pages, and it is only offered
 * when it really is smaller than the original; otherwise the original is returned and `smaller` is false.
 */
export async function compressPdf(input: PdfInput, options: CompressOptions, ctx?: JobContext): Promise<CompressResult> {
  if (!COMPRESS_LEVELS.includes(options.level)) throw new AppError("INVALID_INPUT", "Choose a compression level.");
  const originalBytes = input.bytes.length;
  const outName = `${baseName(input.name)}_compressed.pdf`;
  const notes: string[] = [];
  const images: ImageReport = { total: 0, optimized: 0, downsampled: 0, skipped: {}, bytesSaved: 0 };

  reportProgress(ctx, 0.02, "Checking the PDF");
  const pageCount = await withQpdf((qpdf) => countPagesIn(qpdf, qpdf.put(input.bytes), input.password, input.name));
  if (pageCount < 1) throw new AppError("DAMAGED_PDF", `“${input.name}” has no pages.`, { fileName: input.name });

  // Stage 1: edit the document's objects (merge duplicates, shrink images). If the file cannot be opened
  // for editing, stage 2 still works on the original, and the notes say what was skipped.
  let staged: { bytes: Uint8Array; password?: string } = { bytes: input.bytes, password: input.password };
  let duplicatesRemoved = 0;
  try {
    reportProgress(ctx, 0.05, "Opening the document");
    const doc = await loadForEdit(input);
    duplicatesRemoved = deduplicateStreams(doc);
    stripThumbnails(doc);
    if (options.level !== "lossless") {
      const usage = await recompressImages(doc, IMAGE_PROFILES[options.level], images, ctx, 0.08, 0.8);
      if (usage.unreadable > 0) notes.push("Some page content could not be read, so images on those pages were left unchanged.");
    }
    reportProgress(ctx, 0.82, "Saving");
    staged = { bytes: await doc.save({ useObjectStreams: true }) };
  } catch (error) {
    const failure = toAppError(error);
    if (failure.code === "CANCELLED") throw failure;
    notes.push(`Duplicate and image optimization was skipped because the document could not be edited (${failure.message}). Only the structural clean-up was applied.`);
  }

  reportProgress(ctx, 0.88, "Optimizing the file structure");
  const optimized = await optimizeStructure(staged.bytes, staged.password, input.name);

  reportProgress(ctx, 0.96, "Checking the result");
  const resultPages = await verifyPdf(optimized, pageCount, outName);
  reportProgress(ctx, 1);

  notes.unshift(...describeImages(images, options.level));
  if (duplicatesRemoved > 0) notes.push(`${plural(duplicatesRemoved, "duplicate embedded resource")} (fonts, images or colour profiles) ${duplicatesRemoved === 1 ? "was" : "were"} merged into one copy.`);

  const smaller = optimized.length <= originalBytes * (1 - MIN_SAVING);
  if (!smaller) {
    notes.push(options.level === "lossless" ? "This PDF is already stored compactly, so no smaller file could be made without changing its content." : "No smaller file could be made at this level without changing the PDF more than it is worth, so your original is returned unchanged.");
  }
  return {
    file: { name: outName, bytes: smaller ? optimized : input.bytes, mime: MIME.pdf, pageCount: smaller ? resultPages : pageCount },
    originalBytes,
    smaller,
    images,
    duplicatesRemoved,
    notes,
  };
}
