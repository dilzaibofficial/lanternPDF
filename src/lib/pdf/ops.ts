import { applyAnnotations } from "./annotate";
import { type ExportPlan, exportDocument } from "./export/exportDocument";
import type { Annotation } from "./annotateModel";
import { type PageImage, assemblePageImages } from "./assemble";
import { type CompressOptions, compressPdf } from "./compress";
import { type CropOptions, cropPdf } from "./crop";
import { type ImageInput, type ImagesToPdfOptions, imagesToPdf } from "./images";
import { probePdf } from "./inspect";
import { type MetadataChanges, readMetadata, writeMetadata } from "./metadata";
import { type PageNumberOptions, addPageNumbers } from "./pageNumbers";
import { type WatermarkOptions, addWatermark } from "./watermark";
import { arrangePages, mergePdfs, rotatePdf, selectPages, splitPdf } from "./pages";
import type { ArrangeOptions, PageItem, RotateOptions, SelectPagesOptions, SplitPlan } from "./pages";
import { repairPdf } from "./repair";
import { protectPdf, unlockPdf } from "./security";
import type { ProtectOptions, UnlockOptions } from "./security";
import type { JobContext, PdfInput } from "./types";

/** What the Office converters can be told (only spreadsheets have options). */
export interface OfficeOptions {
  fitWidth?: boolean;
  orientation?: "auto" | "portrait" | "landscape";
}

/**
 * The registry of operations that can run in the background worker. Each takes ONE argument object
 * (so it is easy to send over `postMessage`) plus the job context. The UI never imports the engine
 * modules directly; it asks the worker for an operation by name.
 */
export const operations = {
  probe: (a: { bytes: Uint8Array; password?: string }) => probePdf(a.bytes, a.password),
  merge: (a: { inputs: PdfInput[] }, ctx: JobContext) => mergePdfs(a.inputs, ctx),
  selectPages: (a: { input: PdfInput } & SelectPagesOptions, ctx: JobContext) => selectPages(a.input, a, ctx),
  split: (a: { input: PdfInput; plan: SplitPlan }, ctx: JobContext) => splitPdf(a.input, a.plan, ctx),
  arrange: (a: { sources: PdfInput[]; items: PageItem[] } & ArrangeOptions, ctx: JobContext) =>
    arrangePages(a.sources, a.items, a, ctx),
  rotate: (a: { input: PdfInput } & RotateOptions, ctx: JobContext) => rotatePdf(a.input, a, ctx),
  protect: (a: { input: PdfInput; options: ProtectOptions }, ctx: JobContext) => protectPdf(a.input, a.options, ctx),
  unlock: (a: { input: PdfInput; options: UnlockOptions }, ctx: JobContext) => unlockPdf(a.input, a.options, ctx),
  repair: (a: { input: PdfInput }, ctx: JobContext) => repairPdf(a.input, ctx),
  compress: (a: { input: PdfInput; options: CompressOptions }, ctx: JobContext) => compressPdf(a.input, a.options, ctx),
  assemblePageImages: (a: { pages: PageImage[]; name: string }, ctx: JobContext) => assemblePageImages(a.pages, a.name, ctx),
  imagesToPdf: (a: { images: ImageInput[] } & ImagesToPdfOptions, ctx: JobContext) => imagesToPdf(a.images, a, ctx),
  pageNumbers: (a: { input: PdfInput; options: PageNumberOptions }, ctx: JobContext) => addPageNumbers(a.input, a.options, ctx),
  watermark: (a: { input: PdfInput; options: WatermarkOptions }, ctx: JobContext) => addWatermark(a.input, a.options, ctx),
  crop: (a: { input: PdfInput; options: CropOptions }, ctx: JobContext) => cropPdf(a.input, a.options, ctx),
  annotate: (a: { input: PdfInput; annotations: Annotation[] }, ctx: JobContext) => applyAnnotations(a.input, a.annotations, ctx),
  exportDocument: (a: { plan: ExportPlan }, ctx: JobContext) => exportDocument(a.plan, ctx),
  readMetadata: (a: { input: PdfInput }) => readMetadata(a.input),
  writeMetadata: (a: { input: PdfInput; changes: MetadataChanges }, ctx: JobContext) => writeMetadata(a.input, a.changes, ctx),
  /** Word, Excel and CSV files to PDF on this device. The converters are loaded only when this is first asked for. */
  officeToPdf: async (a: { name: string; bytes: Uint8Array; options?: OfficeOptions }, ctx: JobContext) => {
    const [{ installBrowserFonts }, { convertOfficeFile }] = await Promise.all([import("../office/browserFonts"), import("../office")]);
    installBrowserFonts();
    return convertOfficeFile(a.name, a.bytes, { ...a.options, onProgress: ctx.onProgress });
  },
} as const;

export type Operations = typeof operations;
export type OperationName = keyof Operations;
export type OperationArgs<K extends OperationName> = Parameters<Operations[K]>[0];
export type OperationResult<K extends OperationName> = Awaited<ReturnType<Operations[K]>>;
