import { PDFArray, PDFDict, type PDFDocument, PDFName, type PDFObject, type PDFPage, PDFRef, PDFStream } from "@cantoo/pdf-lib";
import { streamBytes } from "./fonts/fontModel";
import { type Operation, parseContentStream } from "./tokenizer";

/**
 * Reading and replacing the content of a page (or of a form XObject) as one decoded byte string.
 *
 * A page's `/Contents` may be several streams; PDF says they are joined with whitespace between them, so we join
 * them with a newline and remember where each part sat. Edits are made against the joined bytes and written back
 * as a single new stream.
 */

/** Largest content stream we will decode, in bytes, after decompression. A guard against decompression bombs. */
export const MAX_CONTENT_BYTES = 96 * 1024 * 1024;

export interface ContentPart {
  /** The stream object. */
  stream: PDFStream;
  /** Its reference, when it is an indirect object (needed to release it when replaced). */
  ref: PDFRef | null;
  /** Byte range of this part within the joined data. */
  start: number;
  end: number;
}

export interface ContentSource {
  /** `page` for a page's own content, or `form:<ref>` for a form XObject. */
  id: string;
  kind: "page" | "form";
  /** Joined, decoded content. */
  data: Uint8Array;
  parts: ContentPart[];
  /** Resources in effect (the page's, or the form's own, falling back to the one it was drawn from). */
  resources: PDFDict | undefined;
  /** Number of streams that could not be decoded. */
  unreadable: number;
  /** True when the stream was larger than the safety limit and was not read. */
  tooLarge: boolean;
  /** Parsed operations, filled on first use. */
  parsed?: { ops: Operation[]; truncated: boolean; problems: number };
}

const N = {
  Contents: PDFName.of("Contents"),
  Resources: PDFName.of("Resources"),
  Length: PDFName.of("Length"),
};

export function parseSource(source: ContentSource): { ops: Operation[]; truncated: boolean; problems: number } {
  if (!source.parsed) source.parsed = parseContentStream(source.data);
  return source.parsed;
}

function join(chunks: Uint8Array[]): Uint8Array {
  // A newline between parts: the spec requires a token boundary there.
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0) + Math.max(0, chunks.length - 1);
  const out = new Uint8Array(total);
  let at = 0;
  chunks.forEach((chunk, index) => {
    if (index > 0) out[at++] = 10;
    out.set(chunk, at);
    at += chunk.length;
  });
  return out;
}

function decodeParts(streams: { stream: PDFStream; ref: PDFRef | null }[]): Pick<ContentSource, "data" | "parts" | "unreadable" | "tooLarge"> {
  const chunks: Uint8Array[] = [];
  const parts: ContentPart[] = [];
  let unreadable = 0;
  let tooLarge = false;
  let offset = 0;
  let total = 0;
  for (const { stream, ref } of streams) {
    const bytes = streamBytes(stream);
    if (!bytes) {
      unreadable += 1;
      continue;
    }
    total += bytes.length;
    if (total > MAX_CONTENT_BYTES) {
      tooLarge = true;
      break;
    }
    if (chunks.length > 0) offset += 1;
    parts.push({ stream, ref, start: offset, end: offset + bytes.length });
    chunks.push(bytes);
    offset += bytes.length;
  }
  return { data: join(chunks), parts, unreadable, tooLarge };
}

/** The `/Contents` of a page as stream objects. */
export function pageContentStreams(doc: PDFDocument, page: PDFPage): { stream: PDFStream; ref: PDFRef | null }[] {
  const contents = page.node.get(N.Contents);
  const out: { stream: PDFStream; ref: PDFRef | null }[] = [];
  const add = (entry: PDFObject | undefined) => {
    const ref = entry instanceof PDFRef ? entry : null;
    const object = ref ? doc.context.lookup(ref) : entry;
    if (object instanceof PDFStream) out.push({ stream: object, ref });
  };
  const resolved = contents instanceof PDFRef ? doc.context.lookup(contents) : contents;
  if (resolved instanceof PDFArray) for (const entry of resolved.asArray()) add(entry);
  else add(contents);
  return out;
}

/** Resources of a page, inherited from the page tree when the page has none of its own. */
export function pageResources(page: PDFPage): PDFDict | undefined {
  return page.node.Resources() ?? undefined;
}

export function readPageContent(doc: PDFDocument, page: PDFPage): ContentSource {
  const decoded = decodeParts(pageContentStreams(doc, page));
  return { id: "page", kind: "page", ...decoded, resources: pageResources(page) };
}

export function readFormContent(ref: PDFRef | null, stream: PDFStream, inherited: PDFDict | undefined): ContentSource {
  const decoded = decodeParts([{ stream, ref }]);
  const own = stream.dict.lookupMaybe(N.Resources, PDFDict);
  return { id: ref ? `form:${ref.toString()}` : "form:inline", kind: "form", ...decoded, resources: own ?? inherited };
}

/**
 * Replaces a page's content with `data`, as one new compressed stream. The old content streams are released from
 * this page; the file is pruned of anything no longer reachable when it is saved (see `pruneUnreachable`).
 */
export function writePageContent(doc: PDFDocument, page: PDFPage, data: Uint8Array): void {
  const ref = doc.context.register(doc.context.flateStream(data));
  page.node.set(N.Contents, ref);
}

const SKIPPED_FORM_KEYS = new Set([N.Length, PDFName.of("Filter"), PDFName.of("DecodeParms")]);

/**
 * A copy of a form XObject carrying `data` as its content: same `/Matrix`, `/BBox`, `/Resources` and so on, new
 * compressed stream. The original is untouched, so other pages that draw it keep their text. Returns the
 * reference of the copy.
 */
export function writeFormCopy(doc: PDFDocument, original: PDFStream, data: Uint8Array): PDFRef {
  const stream = doc.context.flateStream(data);
  for (const [key, value] of original.dict.entries()) {
    if (!SKIPPED_FORM_KEYS.has(key)) stream.dict.set(key, value);
  }
  return doc.context.register(stream);
}
