import { PDFArray, PDFDict, type PDFDocument, PDFName, type PDFObject, PDFRef } from "@cantoo/pdf-lib";
import { fontSignature } from "./fonts/fontModel";
import { type FontCache, interpret } from "./interpret";
import { IDENTITY } from "./matrix";
import { readPageContent } from "./streams";
import type { ContentSource } from "./streams";

/**
 * Per-document state the engine keeps between calls: the font models built so far, and the result of one
 * pass over the document that records which character codes each font is used with and how often each form
 * XObject is drawn. The scan is what tells an embedded subset font which glyphs it really contains.
 */

export interface EngineContext {
  doc: PDFDocument;
  fonts: FontCache;
  formSources: Map<string, ContentSource>;
  scanned: boolean;
  /** Number of pages the scan covered (it stops at a page limit on very large documents). */
  scannedPages: number;
  /** True when the scan did not cover every page, so glyph availability is conservative. */
  partialScan: boolean;
  /** How many times each form (by reference) is drawn across the scanned pages. */
  formUses: Map<string, number>;
  /** True when the document carries a digital signature. */
  signed: boolean;
  /** Codes known to be in use with a font elsewhere (by font signature), carried over when a page is copied out of its document. */
  seedUsed: Map<string, Set<number>>;
}

const contexts = new WeakMap<PDFDocument, EngineContext>();

/** Pages scanned for font usage on a large document. */
export const SCAN_PAGE_LIMIT = 500;

export function engineContext(doc: PDFDocument): EngineContext {
  let context = contexts.get(doc);
  if (!context) {
    context = { doc, fonts: new Map(), formSources: new Map(), scanned: false, scannedPages: 0, partialScan: false, formUses: new Map(), signed: detectSignature(doc), seedUsed: new Map() };
    contexts.set(doc, context);
  }
  return context;
}

/** True when any form field is a signature field that holds a signature (a signed document). */
export function detectSignature(doc: PDFDocument): boolean {
  try {
    const form = doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
    const fields = form?.lookupMaybe(PDFName.of("Fields"), PDFArray);
    if (!fields) return false;
    const stack: PDFObject[] = [...fields.asArray()];
    let guard = 0;
    while (stack.length > 0 && guard < 20_000) {
      guard += 1;
      const entry = stack.pop() as PDFObject;
      const field = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
      if (!(field instanceof PDFDict)) continue;
      const type = field.lookup(PDFName.of("FT"));
      if (type instanceof PDFName && type.decodeText() === "Sig" && field.lookup(PDFName.of("V")) instanceof PDFDict) return true;
      const kids = field.lookupMaybe(PDFName.of("Kids"), PDFArray);
      if (kids) stack.push(...kids.asArray());
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Runs the light pass over the document (once). Cheap relative to a full analysis: it only decodes the strings
 * of text-showing operators and counts `Do` of forms.
 */
export function ensureScanned(context: EngineContext): void {
  if (context.scanned) return;
  const { doc } = context;
  const pages = doc.getPages();
  const limit = Math.min(pages.length, SCAN_PAGE_LIMIT);
  for (let index = 0; index < limit; index += 1) {
    const page = pages[index];
    if (!page) continue;
    const source = readPageContent(doc, page);
    const result = interpret(doc, source, IDENTITY, context.fonts, { light: true }, { formSources: context.formSources, seedUsed: context.seedUsed });
    for (const form of result.forms) {
      if (form.ref) context.formUses.set(form.ref.toString(), (context.formUses.get(form.ref.toString()) ?? 0) + 1);
    }
  }
  context.scanned = true;
  context.scannedPages = limit;
  context.partialScan = limit < pages.length;
}

/** The codes each font is used with across the scanned document, keyed by font signature, to seed a copied page. */
export function usedBySignature(context: EngineContext): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const font of context.fonts.values()) {
    const key = fontSignature(font);
    const set = out.get(key) ?? new Set<number>();
    for (const code of font.used) set.add(code);
    out.set(key, set);
  }
  return out;
}
