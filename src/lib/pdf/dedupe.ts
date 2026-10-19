import { PDFArray, PDFDict, type PDFDocument, PDFName, type PDFObject, PDFRawStream, PDFRef } from "@cantoo/pdf-lib";

/**
 * Merges byte-for-byte identical streams (embedded fonts, images, ICC profiles, page content) into one
 * object and points every reference at it. Documents assembled from several files, or exported by tools
 * that embed a resource once per page, often carry many copies of the same font or logo.
 *
 * Two streams are only merged when their dictionaries (apart from /Length) and their bytes are equal, so
 * the result is indistinguishable to a reader. Streams that refer to other objects (an image and its soft
 * mask) become equal once those objects are merged, so the work is repeated a few times.
 */
export function deduplicateStreams(doc: PDFDocument): number {
  let removed = 0;
  for (let round = 0; round < 3; round += 1) {
    const found = mergeOnce(doc);
    removed += found;
    if (found === 0) break;
  }
  return removed;
}

const SKIPPED_TYPES = new Set(["ObjStm", "XRef"]);

function signature(dict: PDFDict): string {
  const parts: string[] = [];
  for (const [key, value] of dict.entries()) {
    const name = key.toString();
    if (name !== "/Length") parts.push(`${name}=${value.toString()}`);
  }
  return parts.sort().join(";");
}

/** FNV-1a over the bytes. A weak hash is fine: candidates are compared byte for byte before merging. */
function hash(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i] as number;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function mergeOnce(doc: PDFDocument): number {
  // Cheap grouping first (size and dictionary); bytes are only hashed for groups with company.
  const groups = new Map<string, { ref: PDFRef; stream: PDFRawStream }[]>();
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const type = object.dict.get(PDFName.of("Type"));
    if (type instanceof PDFName && SKIPPED_TYPES.has(type.decodeText())) continue;
    const key = `${object.contents.length}|${signature(object.dict)}`;
    const group = groups.get(key);
    if (group) group.push({ ref, stream: object });
    else groups.set(key, [{ ref, stream: object }]);
  }

  const redirects = new Map<string, PDFRef>();
  const duplicates: PDFRef[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const byHash = new Map<number, { ref: PDFRef; stream: PDFRawStream }[]>();
    for (const entry of group) {
      const h = hash(entry.stream.contents);
      const bucket = byHash.get(h);
      if (bucket) bucket.push(entry);
      else byHash.set(h, [entry]);
    }
    for (const bucket of byHash.values()) {
      const keep = bucket[0];
      if (!keep) continue;
      for (const other of bucket.slice(1)) {
        if (!sameBytes(keep.stream.contents, other.stream.contents)) continue;
        redirects.set(other.ref.toString(), keep.ref);
        duplicates.push(other.ref);
      }
    }
  }
  if (redirects.size === 0) return 0;

  const retarget = (value: PDFObject | undefined): PDFRef | null => (value instanceof PDFRef ? (redirects.get(value.toString()) ?? null) : null);
  const visitDict = (dict: PDFDict): void => {
    for (const [key, child] of dict.entries()) {
      const target = retarget(child);
      if (target) dict.set(key, target);
      else if (child instanceof PDFDict) visitDict(child);
      else if (child instanceof PDFArray) visitArray(child);
    }
  };
  const visitArray = (array: PDFArray): void => {
    for (let i = 0; i < array.size(); i += 1) {
      const child = array.get(i);
      const target = retarget(child);
      if (target) array.set(i, target);
      else if (child instanceof PDFDict) visitDict(child);
      else if (child instanceof PDFArray) visitArray(child);
    }
  };

  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream) visitDict(object.dict);
    else if (object instanceof PDFDict) visitDict(object);
    else if (object instanceof PDFArray) visitArray(object);
  }
  for (const ref of duplicates) doc.context.delete(ref);
  return duplicates.length;
}

/** Drops the page thumbnails some producers embed. Viewers draw their own, so nothing visible changes. */
export function stripThumbnails(doc: PDFDocument): number {
  let removed = 0;
  for (const page of doc.getPages()) {
    if (page.node.delete(PDFName.of("Thumb"))) removed += 1;
  }
  return removed;
}
