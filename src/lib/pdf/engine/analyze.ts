import { PDFArray, PDFDict, type PDFDocument, PDFName, PDFNumber, type PDFPage, PDFRef, PDFString, PDFHexString } from "@cantoo/pdf-lib";
import { type PageFrame, frameOf } from "../draw";
import { engineContext, ensureScanned } from "./context";
import { type Interpretation, interpret } from "./interpret";
import { type TextLine, buildLines, codePoints } from "./lines";
import { IDENTITY, type Rect, transformRect } from "./matrix";
import { type AnalyzedField, readFormFields } from "./forms";
import { whyLineLocked } from "./lineObjects";
import { type AnalyzedObject, listObjects } from "./objects";
import { type DisplayBox, boxToDisplay, screenAngle, userToDisplay } from "./space";
import { readPageContent } from "./streams";
import { whyNotEditable } from "./textEdit";

/**
 * A page as the editor needs to see it: lines of text that can be edited (or why they cannot), images, links,
 * annotations and painted shapes, all in **display space**: points, origin at the top-left of the page as it is
 * shown (after the CropBox and any rotation), y pointing down. Plain data, so it can cross a worker boundary.
 */

export type Alignment = "left" | "center" | "right";

export interface AnalyzedLine {
  id: string;
  text: string;
  /** Axis-aligned bounds in display space. */
  box: DisplayBox;
  /** Where the baseline starts, and the baseline's angle in degrees clockwise on screen (0 = left to right). */
  origin: { x: number; y: number };
  angle: number;
  /** Length of the line along its baseline, in display points. */
  length: number;
  /** Font size in display points. */
  size: number;
  fontName: string;
  family: "sans" | "serif" | "mono" | "symbol";
  bold: boolean;
  italic: boolean;
  /** "#rrggbb", or null when the colour is not a plain device colour. */
  color: string | null;
  align: Alignment;
  /** Offset of each character's start along the baseline, in display points, one more than the text length in code points. */
  charOffsets: number[];
  /** "A" the line can be edited; "C" it cannot, with `reason`. (Whether an edit needs a fallback font depends on the new text.) */
  verdict: "A" | "C";
  reason?: string;
  /** Characters the line's own font can draw (those already used with it in the document), for flagging letters that need a fallback. */
  availableChars: string;
  /** The line belongs to a block the page draws this many times. */
  repeats?: number;
  /** The line is made of pieces in different fonts. */
  mixedFonts: boolean;
  /** Position in the page's stacking order (shared with images and shapes): later is on top. */
  order: number;
  /** The text is not drawn (a hidden layer such as OCR leaves behind). */
  invisible: boolean;
  /** Why the line cannot be moved or removed, or null when it can. */
  locked: string | null;
}

export interface AnalyzedLink {
  box: DisplayBox;
  uri?: string;
  /** Page number the link goes to (1-based), when it is an internal link and we could resolve it. */
  page?: number;
}

export interface PageAnalysis {
  pageIndex: number;
  /** Size of the page as displayed. */
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  lines: AnalyzedLine[];
  /** Images, painted shapes and annotations: what can be selected, moved or removed. */
  objects: AnalyzedObject[];
  /** The form fields the page already has (check boxes, text fields, lists…), with the values they hold. */
  fields: AnalyzedField[];
  links: AnalyzedLink[];
  /** Things worth telling the person: unreadable content, truncated reading… */
  warnings: string[];
  stats: { runs: number; lines: number; milliseconds: number };
}

// ---- alignment ----------------------------------------------------------------------------------------------------

interface Edges {
  left: number;
  right: number;
  centre: number;
  top: number;
  size: number;
  horizontal: boolean;
}

/**
 * Guesses how each line is aligned, from its neighbours: lines of one paragraph that share a right edge are
 * right-aligned, share a centre are centred. A line on its own is judged against the page and the other lines.
 */
function inferAlignments(lines: readonly AnalyzedLine[], pageWidth: number): Alignment[] {
  const edges: Edges[] = lines.map((line) => ({
    left: line.box.x,
    right: line.box.x + line.box.width,
    centre: line.box.x + line.box.width / 2,
    top: line.box.y,
    size: line.size,
    horizontal: Math.abs(line.angle) < 1,
  }));
  const tolerance = 1.5;
  const result: Alignment[] = lines.map(() => "left");
  const horizontalEdges = edges.filter((e) => e.horizontal);
  const maxRight = horizontalEdges.reduce((m, e) => Math.max(m, e.right), 0);
  const minLeft = horizontalEdges.reduce((m, e) => Math.min(m, e.left), Number.POSITIVE_INFINITY);

  edges.forEach((edge, i) => {
    if (!edge.horizontal) return;
    // Neighbours in the same block: lines just above or below that overlap this one horizontally.
    const neighbours = edges.filter((other, j) => j !== i && other.horizontal && Math.abs(other.top - edge.top) < edge.size * 2.4 && Math.abs(other.top - edge.top) > edge.size * 0.3 && other.right > edge.left && other.left < edge.right);
    if (neighbours.length > 0) {
      const sameRight = neighbours.every((n) => Math.abs(n.right - edge.right) < tolerance);
      const sameLeft = neighbours.every((n) => Math.abs(n.left - edge.left) < tolerance);
      const sameCentre = neighbours.every((n) => Math.abs(n.centre - edge.centre) < tolerance);
      if (sameLeft) {
        result[i] = "left";
        return;
      }
      if (sameCentre && !sameRight) {
        result[i] = "center";
        return;
      }
      if (sameRight) {
        result[i] = "right";
        return;
      }
      // Neighbours share no edge with this line: judge it against the page instead.
    }
    const onCentre = Math.abs(edge.centre - pageWidth / 2) < 2 + edge.size * 0.1;
    if (onCentre && edge.left > pageWidth * 0.12 && edge.left > minLeft + 12) result[i] = "center";
    else if (Math.abs(edge.right - maxRight) < tolerance && edge.left > minLeft + 24 && edge.right > pageWidth * 0.6) result[i] = "right";
  });
  return result;
}

// ---- links and annotations ----------------------------------------------------------------------------------------

function rectOfAnnotation(annotation: PDFDict): Rect | null {
  const rect = annotation.lookupMaybe(PDFName.of("Rect"), PDFArray);
  if (!rect || rect.size() < 4) return null;
  const values = [0, 1, 2, 3].map((i) => {
    const n = rect.lookup(i);
    return n instanceof PDFNumber ? n.asNumber() : Number.NaN;
  });
  if (!values.every(Number.isFinite)) return null;
  const [x1, y1, x2, y2] = values as [number, number, number, number];
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

function stringOf(value: unknown): string | undefined {
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;
}

function pageNumberOfRef(doc: PDFDocument, ref: PDFRef | undefined): number | undefined {
  if (!ref) return undefined;
  const index = doc.getPages().findIndex((p) => p.ref === ref || p.ref.toString() === ref.toString());
  return index >= 0 ? index + 1 : undefined;
}

function readLinks(doc: PDFDocument, page: PDFPage, frame: PageFrame): AnalyzedLink[] {
  const links: AnalyzedLink[] = [];
  const list = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (!list) return links;
  for (let i = 0; i < Math.min(list.size(), 5000); i += 1) {
    const annotation = list.lookupMaybe(i, PDFDict);
    if (!annotation) continue;
    const subtype = (annotation.lookup(PDFName.of("Subtype")) as PDFName | undefined)?.decodeText() ?? "Unknown";
    if (subtype !== "Link") continue;
    const rect = rectOfAnnotation(annotation);
    if (!rect) continue;
    const box = boxToDisplay(frame, rect);
    const action = annotation.lookupMaybe(PDFName.of("A"), PDFDict);
    const uri = stringOf(action?.lookup(PDFName.of("URI")));
    let target: number | undefined;
    const dest = annotation.lookup(PDFName.of("Dest")) ?? action?.lookup(PDFName.of("D"));
    if (dest instanceof PDFArray) target = pageNumberOfRef(doc, dest.get(0) instanceof PDFRef ? (dest.get(0) as PDFRef) : undefined);
    links.push({ box, uri, page: target });
  }
  return links;
}

// ---- the analysis -------------------------------------------------------------------------------------------------

function lineToDisplay(line: TextLine, frame: PageFrame, alignment: Alignment, repeats: number | undefined): AnalyzedLine {
  const map = userToDisplay(frame);
  const first = line.runs[0];
  const [ox, oy] = map(line.origin[0], line.origin[1]);
  const length = line.advance * line.scale;
  // Start of each code point along the baseline (a ligature glyph's span is split evenly).
  const offsets: number[] = [];
  for (const char of line.chars) {
    const parts = codePoints(char.text).length;
    for (let k = 0; k < parts; k += 1) offsets.push((char.x + (char.advance * k) / parts) * line.scale);
  }
  offsets.push(length);
  const fonts = new Set(line.runs.map((r) => r.font.key));
  const available = new Set<string>();
  for (const run of line.runs) for (const ch of run.font.availableChars()) available.add(ch);
  const reason = whyNotEditable(line);
  return {
    id: line.id,
    text: line.text,
    box: boxToDisplay(frame, line.box),
    origin: { x: ox, y: oy },
    angle: screenAngle(frame, line.direction[0], line.direction[1]),
    length,
    size: line.size,
    fontName: first?.font.baseFont ?? "",
    family: first?.font.family ?? "sans",
    bold: first?.font.bold ?? false,
    italic: first?.font.italic ?? false,
    color: first?.fill ?? null,
    align: alignment,
    charOffsets: offsets.map((o) => Math.round(o * 1000) / 1000),
    verdict: reason ? "C" : "A",
    reason: reason ?? undefined,
    availableChars: [...available].sort().join(""),
    repeats,
    mixedFonts: fonts.size > 1,
    order: first?.seq ?? 0,
    invisible: line.runs.every((run) => run.renderMode === 3),
    locked:
      whyLineLocked(line) ??
      (first && first.depth > 1 ? "This text is inside blocks nested several levels deep, which the editor does not rewrite." : null) ??
      (repeats ? `This text belongs to a reusable block that the page draws ${repeats} times. Changing it would change all of them.` : null),
  };
}

/** Reads a page: its lines of text with their editability, and its images, painted shapes, annotations and links. */
export function analyzePage(doc: PDFDocument, pageIndex: number): { analysis: PageAnalysis; interpretation: Interpretation; lines: TextLine[] } {
  const started = performance.now();
  const context = engineContext(doc);
  ensureScanned(context);
  const page = doc.getPage(pageIndex);
  const frame = frameOf(page);
  const source = readPageContent(doc, page);
  const interpretation = interpret(doc, source, IDENTITY, context.fonts, {}, { formSources: context.formSources });
  const lines = buildLines(interpretation.runs);

  // How many times the page draws each form: text inside a repeated form is shared.
  const uses = new Map<string, number>();
  for (const form of interpretation.forms) if (form.ref) uses.set(form.ref.toString(), (uses.get(form.ref.toString()) ?? 0) + 1);

  const provisional = lines.map((line) => {
    const head = line.runs[0];
    const repeats = head?.source.kind === "form" ? uses.get(head.source.id.replace(/^form:/, "")) : undefined;
    return lineToDisplay(line, frame, "left", repeats && repeats > 1 ? repeats : undefined);
  });
  const alignments = inferAlignments(provisional, frame.displayWidth);
  const analyzed = provisional.map((line, i) => ({ ...line, align: alignments[i] as Alignment }));

  const objects = listObjects(page, frame, interpretation);
  const fields = readFormFields(page, frame);
  const links = readLinks(doc, page, frame);
  const warnings = [...interpretation.problems];
  if (context.signed) warnings.push("This document is digitally signed. Saving any change will make the signature invalid.");
  if (context.partialScan) warnings.push("This is a very large document: which letters each font can draw was worked out from its first pages only.");

  return {
    analysis: {
      pageIndex,
      width: frame.displayWidth,
      height: frame.displayHeight,
      rotation: frame.rotation,
      lines: analyzed,
      objects,
      fields,
      links,
      warnings,
      stats: { runs: interpretation.runs.length, lines: lines.length, milliseconds: Math.round(performance.now() - started) },
    },
    interpretation,
    lines,
  };
}

export { transformRect };
export type { DisplayBox };
