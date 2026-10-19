import { PDFArray, PDFDict, type PDFDocument, PDFName, PDFRawStream } from "@cantoo/pdf-lib";
import { latin1 } from "../bytes";
import { AppError } from "../errors";
import { baseName } from "../format";
import { finishEdit, loadForEdit } from "./document";
import { frameOf } from "./draw";
import { type JobContext, type OutputFile, type PdfInput, reportProgress } from "./types";

export interface PageSizeGroup {
  /** In PDF points, as displayed (rotation and crop box applied). */
  width: number;
  height: number;
  /** "A4 portrait", "US Letter landscape", or "210 × 297 mm" when it matches no standard size. */
  label: string;
  count: number;
}

export interface FontInfo {
  name: string;
  embedded: boolean;
}

export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  /** ISO 8601 */
  creationDate?: string;
  modificationDate?: string;
  pageCount: number;
  /** From the file header, e.g. "1.7". */
  version?: string;
  linearized: boolean;
  tagged: boolean;
  hasXmp: boolean;
  hasOutline: boolean;
  formFieldCount: number;
  attachmentCount: number;
  hasJavaScript: boolean;
  imageCount: number;
  fonts: FontInfo[];
  pageSizes: PageSizeGroup[];
  fileSize: number;
}

const STANDARD_SIZES: [string, number, number][] = [
  ["A0", 2383.94, 3370.39], ["A1", 1683.78, 2383.94], ["A2", 1190.55, 1683.78], ["A3", 841.89, 1190.55],
  ["A4", 595.28, 841.89], ["A5", 419.53, 595.28], ["A6", 297.64, 419.53],
  ["US Letter", 612, 792], ["US Legal", 612, 1008], ["US Tabloid", 792, 1224],
];

export function describePageSize(width: number, height: number): string {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const match = STANDARD_SIZES.find(([, w, h]) => Math.abs(w - short) <= 2 && Math.abs(h - long) <= 2);
  const orientation = width > height ? "landscape" : "portrait";
  if (match) return `${match[0]} ${width === height ? "" : orientation}`.trim();
  const mm = (pt: number) => Math.round((pt / 72) * 25.4);
  return `${mm(width)} × ${mm(height)} mm`;
}

const name = (value: string) => PDFName.of(value);

function dictOf(doc: PDFDocument, key: string): PDFDict | undefined {
  return doc.catalog.lookupMaybe(name(key), PDFDict);
}

function isDictOfType(object: unknown, type: string): object is PDFDict {
  return object instanceof PDFDict && object.get(name("Type")) === name(type);
}

function stripSubset(fontName: string): string {
  return fontName.replace(/^\//, "").replace(/^[A-Z]{6}\+/, "");
}

function collectFonts(doc: PDFDocument): FontInfo[] {
  const seen = new Map<string, boolean>();
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!isDictOfType(object, "Font")) continue;
    const baseFont = object.lookupMaybe(name("BaseFont"), PDFName);
    if (!baseFont) continue;
    // Composite (Type0) fonts keep the descriptor on their descendant font.
    let holder: PDFDict = object;
    const descendants = object.lookupMaybe(name("DescendantFonts"), PDFArray);
    const first = descendants?.lookupMaybe(0, PDFDict);
    if (first) holder = first;
    const descriptor = holder.lookupMaybe(name("FontDescriptor"), PDFDict);
    const embedded = Boolean(descriptor && (descriptor.has(name("FontFile")) || descriptor.has(name("FontFile2")) || descriptor.has(name("FontFile3"))));
    const label = stripSubset(baseFont.decodeText());
    seen.set(label, (seen.get(label) ?? false) || embedded);
  }
  return [...seen.entries()].map(([fontName, embedded]) => ({ name: fontName, embedded })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 80);
}

function countImages(doc: PDFDocument): number {
  let count = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream && object.dict.get(name("Subtype")) === name("Image")) count += 1;
  }
  return count;
}

function formFieldCount(doc: PDFDocument): number {
  try {
    return doc.getForm().getFields().length;
  } catch {
    return 0;
  }
}

function hasJavaScript(doc: PDFDocument): boolean {
  const names = dictOf(doc, "Names");
  if (names?.has(name("JavaScript"))) return true;
  const open = doc.catalog.lookup(name("OpenAction"));
  return open instanceof PDFDict && open.get(name("S")) === name("JavaScript");
}

function attachmentCount(doc: PDFDocument): number {
  const embedded = dictOf(doc, "Names")?.lookupMaybe(name("EmbeddedFiles"), PDFDict);
  const list = embedded?.lookupMaybe(name("Names"), PDFArray);
  // The name tree stores [name, ref, name, ref, ...] pairs.
  return list ? Math.floor(list.size() / 2) : 0;
}

function headerVersion(bytes: Uint8Array): string | undefined {
  return /%PDF-(\d\.\d)/.exec(latin1(bytes, 0, 1024))?.[1];
}

const iso = (date: Date | undefined): string | undefined => (date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined);

export async function readMetadata(input: PdfInput): Promise<PdfMetadata> {
  const doc = await loadForEdit(input);
  const pages = doc.getPages();

  const groups = new Map<string, PageSizeGroup>();
  for (const page of pages) {
    const frame = frameOf(page);
    const width = Math.round(frame.displayWidth * 10) / 10;
    const height = Math.round(frame.displayHeight * 10) / 10;
    const key = `${width}x${height}`;
    const group = groups.get(key) ?? { width, height, label: describePageSize(width, height), count: 0 };
    group.count += 1;
    groups.set(key, group);
  }

  const markInfo = dictOf(doc, "MarkInfo");
  return {
    title: doc.getTitle(),
    author: doc.getAuthor(),
    subject: doc.getSubject(),
    keywords: doc.getKeywords(),
    creator: doc.getCreator(),
    producer: doc.getProducer(),
    creationDate: iso(doc.getCreationDate()),
    modificationDate: iso(doc.getModificationDate()),
    pageCount: pages.length,
    version: headerVersion(input.bytes),
    linearized: /\/Linearized\b/.test(latin1(input.bytes, 0, 2048)),
    tagged: markInfo?.get(name("Marked"))?.toString() === "true",
    hasXmp: doc.catalog.has(name("Metadata")),
    hasOutline: doc.catalog.has(name("Outlines")),
    formFieldCount: formFieldCount(doc),
    attachmentCount: attachmentCount(doc),
    hasJavaScript: hasJavaScript(doc),
    imageCount: countImages(doc),
    fonts: collectFonts(doc),
    pageSizes: [...groups.values()].sort((a, b) => b.count - a.count),
    fileSize: input.bytes.length,
  };
}

/** For each field: `undefined` leaves it alone, `null` removes it, a string/Date sets it. */
export interface MetadataChanges {
  title?: string | null;
  author?: string | null;
  subject?: string | null;
  keywords?: string | null;
  creator?: string | null;
  producer?: string | null;
  creationDate?: Date | null;
  modificationDate?: Date | null;
  /** Remove every field and the XMP packet. Overrides the individual fields. */
  clearAll?: boolean;
}

const INFO_KEYS: Record<string, string> = {
  title: "Title",
  author: "Author",
  subject: "Subject",
  keywords: "Keywords",
  creator: "Creator",
  producer: "Producer",
  creationDate: "CreationDate",
  modificationDate: "ModDate",
};

export async function writeMetadata(input: PdfInput, changes: MetadataChanges, ctx?: JobContext): Promise<OutputFile> {
  reportProgress(ctx, 0.1, "Opening the PDF");
  const doc = await loadForEdit(input);
  // `getInfoDict` is private in the typings but is the supported way to reach the Info dictionary.
  const info = (doc as unknown as { getInfoDict(): PDFDict }).getInfoDict();
  const pageCount = doc.getPageCount();

  let touched = false;
  if (changes.clearAll) {
    for (const key of [...info.keys()]) info.delete(key as PDFName);
    touched = true;
  } else {
    const apply = (field: keyof typeof INFO_KEYS, set: () => void) => {
      const value = changes[field as keyof MetadataChanges];
      if (value === undefined) return;
      touched = true;
      if (value === null) info.delete(name(INFO_KEYS[field] as string));
      else set();
    };
    apply("title", () => doc.setTitle(changes.title as string));
    apply("author", () => doc.setAuthor(changes.author as string));
    apply("subject", () => doc.setSubject(changes.subject as string));
    apply("keywords", () => doc.setKeywords([changes.keywords as string]));
    apply("creator", () => doc.setCreator(changes.creator as string));
    apply("producer", () => doc.setProducer(changes.producer as string));
    apply("creationDate", () => doc.setCreationDate(changes.creationDate as Date));
    apply("modificationDate", () => doc.setModificationDate(changes.modificationDate as Date));
  }
  if (!touched) throw new AppError("INVALID_INPUT", "Nothing was changed. Edit a field first.");

  // An old XMP packet would contradict the new values in viewers that prefer it, so it goes too.
  doc.catalog.delete(name("Metadata"));

  reportProgress(ctx, 0.7, "Saving and checking the result");
  const result = await finishEdit(doc, `${baseName(input.name)}_${changes.clearAll ? "clean" : "edited"}.pdf`, pageCount, { stamp: false });

  // Prove the change landed: read it back.
  const after = await readMetadata({ name: result.name, bytes: result.bytes });
  const expect = (field: "title" | "author" | "subject" | "creator" | "producer", wanted: string | null | undefined) => {
    if (changes.clearAll) {
      if (after[field] !== undefined) throw new AppError("VERIFICATION_FAILED", `The ${field} was still present after clearing, so the result was discarded.`);
    } else if (wanted !== undefined && (wanted ?? undefined) !== after[field]) {
      throw new AppError("VERIFICATION_FAILED", `The ${field} did not change as requested, so the result was discarded.`);
    }
  };
  expect("title", changes.title);
  expect("author", changes.author);
  expect("subject", changes.subject);
  expect("creator", changes.creator);
  expect("producer", changes.producer);
  if (changes.clearAll && after.hasXmp) throw new AppError("VERIFICATION_FAILED", "Hidden metadata remained after clearing, so the result was discarded.");

  reportProgress(ctx, 1);
  return result;
}
