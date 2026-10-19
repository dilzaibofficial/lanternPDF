import { PDFArray, PDFDict, type PDFDocument, type PDFObject, PDFRef, PDFStream } from "@cantoo/pdf-lib";

/**
 * Removes every object that can no longer be reached from the document's trailer (the catalog and the info
 * dictionary), so content that an edit replaced is not left behind in the saved file.
 *
 * pdf-lib writes every object it holds, reachable or not, so without this step a content stream that was swapped
 * out for an edited copy would still be in the file, merely unused. For redaction that matters: the redacted text
 * must not be in the output at all.
 */
export function pruneUnreachable(doc: PDFDocument): number {
  const { context } = doc;
  const seen = new Set<string>();
  const stack: PDFObject[] = [];

  const info = context.trailerInfo;
  for (const root of [info.Root, info.Info, info.Encrypt]) if (root) stack.push(root);

  while (stack.length > 0) {
    const object = stack.pop() as PDFObject;
    if (object instanceof PDFRef) {
      const tag = object.toString();
      if (seen.has(tag)) continue;
      seen.add(tag);
      const target = context.lookup(object);
      if (target) stack.push(target);
    } else if (object instanceof PDFDict) {
      for (const value of object.values()) stack.push(value);
    } else if (object instanceof PDFArray) {
      for (const value of object.asArray()) stack.push(value);
    } else if (object instanceof PDFStream) {
      for (const value of object.dict.values()) stack.push(value);
    }
  }

  let removed = 0;
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!seen.has(ref.toString())) {
      context.delete(ref);
      removed += 1;
    }
  }
  return removed;
}
