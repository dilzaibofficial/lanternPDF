import { type PDFDict, PDFDocument, PDFName, PDFObject, type PDFPage, type PDFRef, PDFString } from "@cantoo/pdf-lib";
import { type FontCache, type Interpretation, interpret } from "../../../src/lib/pdf/engine/interpret";
import { IDENTITY } from "../../../src/lib/pdf/engine/matrix";
import { readPageContent } from "../../../src/lib/pdf/engine/streams";

/**
 * Builds PDFs whose content stream and font dictionaries are written by hand, so a test controls exactly which
 * operators and font structures the engine sees (the pdf-lib helpers always write the same shapes).
 */

type Literal = string | number | boolean | null | Literal[] | { [key: string]: Literal } | PDFObject;

export interface RawPage {
  doc: PDFDocument;
  page: PDFPage;
  /** Registers an object and returns its reference. */
  add: (literal: { [key: string]: Literal }) => PDFRef;
  resources: PDFDict;
}

export interface RawOptions {
  size?: readonly [number, number];
  fonts?: Record<string, { [key: string]: Literal }>;
  /** Extra resources, e.g. XObjects: category -> name -> literal. */
  resources?: Record<string, Record<string, Literal | PDFObject>>;
  content: string;
  /** Runs after the page exists, for anything else (forms, ToUnicode streams…). */
  setup?: (raw: RawPage) => void | Promise<void>;
}

export async function rawPdf(options: RawOptions): Promise<RawPage> {
  const doc = await PDFDocument.create();
  const [width, height] = options.size ?? [612, 792];
  const page = doc.addPage([width, height]);
  const { context } = doc;
  const resources = context.obj({}) as PDFDict;
  const fonts = context.obj({}) as PDFDict;
  for (const [name, literal] of Object.entries(options.fonts ?? {})) fonts.set(PDFName.of(name), context.register(context.obj(literal as never)));
  resources.set(PDFName.of("Font"), fonts);
  for (const [category, entries] of Object.entries(options.resources ?? {})) {
    const dict = context.obj({}) as PDFDict;
    for (const [name, value] of Object.entries(entries)) dict.set(PDFName.of(name), value instanceof PDFObject ? value : context.obj(value as never));
    resources.set(PDFName.of(category), dict);
  }
  page.node.set(PDFName.of("Resources"), resources);
  page.node.set(PDFName.of("Contents"), context.register(context.flateStream(options.content)));
  const raw: RawPage = { doc, page, resources, add: (literal) => context.register(context.obj(literal as never)) };
  await options.setup?.(raw);
  return raw;
}

/** A Type 1 standard font entry (no embedded program), WinAnsi encoded. */
export const helvetica = { Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" } as const;
export const times = { Type: "Font", Subtype: "Type1", BaseFont: "Times-Roman", Encoding: "WinAnsiEncoding" } as const;
export const courier = { Type: "Font", Subtype: "Type1", BaseFont: "Courier", Encoding: "WinAnsiEncoding" } as const;

export const stringObject = (text: string): PDFString => PDFString.of(text);

/** Reads a hand-built (or any) document's first page with the interpreter. */
export function interpretPage(doc: PDFDocument, index = 0, fonts: FontCache = new Map(), options: Parameters<typeof interpret>[4] = {}): Interpretation {
  const page = doc.getPage(index);
  return interpret(doc, readPageContent(doc, page), IDENTITY, fonts, options);
}

/** Saves and reloads, so tests also exercise the file round trip. */
export async function reload(doc: PDFDocument): Promise<PDFDocument> {
  return PDFDocument.load(await doc.save());
}
