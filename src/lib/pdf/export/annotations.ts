import { PDFArray, type PDFDocument, PDFName, type PDFObject, type PDFPage, type PDFRef, PDFString } from "@cantoo/pdf-lib";
import type { PageFrame } from "../draw";
import { parseColor } from "../draw";
import type { CommentObject, MarkupObject } from "../../../editor/model/types";
import { toUser } from "./baseSpace";

/**
 * Highlights, underlines, strikeouts, squiggles and notes are written as real annotations, with an appearance
 * stream so every viewer draws them the same way. Readers that show an annotations list (comments, review
 * panels) will list them, and they stay editable there.
 */

const N = (name: string) => PDFName.of(name);

function appendAnnotation(doc: PDFDocument, page: PDFPage, annotation: PDFObject): PDFRef {
  const ref = doc.context.register(annotation);
  const annots = page.node.lookupMaybe(N("Annots"), PDFArray);
  if (annots) annots.push(ref);
  else page.node.set(N("Annots"), doc.context.obj([ref]));
  return ref;
}

const rgb = (hex: string): [number, number, number] => {
  const c = parseColor(hex);
  return [c.red, c.green, c.blue];
};

const fmt = (v: number) => (Math.round(v * 1000) / 1000).toString();

interface Quad {
  /** Top-left, top-right, bottom-left, bottom-right in user space. */
  points: [number, number][];
}

function quadsOf(frame: PageFrame, boxes: MarkupObject["quads"]): { quads: Quad[]; rect: [number, number, number, number] } {
  const quads: Quad[] = [];
  let left = Number.POSITIVE_INFINITY;
  let bottom = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.NEGATIVE_INFINITY;
  for (const b of boxes) {
    const tl = toUser(frame, b.x, b.y);
    const tr = toUser(frame, b.x + b.width, b.y);
    const bl = toUser(frame, b.x, b.y + b.height);
    const br = toUser(frame, b.x + b.width, b.y + b.height);
    quads.push({ points: [tl, tr, bl, br] });
    for (const [x, y] of [tl, tr, bl, br]) {
      left = Math.min(left, x);
      right = Math.max(right, x);
      bottom = Math.min(bottom, y);
      top = Math.max(top, y);
    }
  }
  return { quads, rect: [left, bottom, right, top] };
}

/** The drawing instructions of a markup annotation's appearance, in user space. */
function appearanceContent(kind: MarkupObject["kind"], quads: Quad[], color: [number, number, number]): string {
  const [r, g, b] = color;
  const lines: string[] = [];
  if (kind === "highlight") {
    lines.push("/GS gs", `${fmt(r)} ${fmt(g)} ${fmt(b)} rg`);
    for (const { points } of quads) {
      const [tl, tr, bl, br] = points as [[number, number], [number, number], [number, number], [number, number]];
      lines.push(`${fmt(bl[0])} ${fmt(bl[1])} m ${fmt(br[0])} ${fmt(br[1])} l ${fmt(tr[0])} ${fmt(tr[1])} l ${fmt(tl[0])} ${fmt(tl[1])} l h f`);
    }
    return lines.join("\n");
  }
  lines.push("/GS gs", `${fmt(r)} ${fmt(g)} ${fmt(b)} RG 1 w`);
  for (const { points } of quads) {
    const [tl, tr, bl, br] = points as [[number, number], [number, number], [number, number], [number, number]];
    if (kind === "underline") {
      lines.push(`${fmt(bl[0])} ${fmt(bl[1])} m ${fmt(br[0])} ${fmt(br[1])} l S`);
    } else if (kind === "strikeout") {
      const mid = (a: [number, number], c: [number, number]): [number, number] => [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
      const a = mid(tl, bl);
      const c = mid(tr, br);
      lines.push(`${fmt(a[0])} ${fmt(a[1])} m ${fmt(c[0])} ${fmt(c[1])} l S`);
    } else {
      // squiggly: a zigzag along the bottom edge
      const dx = br[0] - bl[0];
      const dy = br[1] - bl[1];
      const length = Math.hypot(dx, dy);
      const steps = Math.max(2, Math.floor(length / 3));
      const nx = -dy / (length || 1);
      const ny = dx / (length || 1);
      let path = `${fmt(bl[0])} ${fmt(bl[1])} m`;
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        const wave = i % 2 === 0 ? 0 : 1.6;
        path += ` ${fmt(bl[0] + dx * t + nx * wave)} ${fmt(bl[1] + dy * t + ny * wave)} l`;
      }
      lines.push(`${path} S`);
    }
  }
  return lines.join("\n");
}

const SUBTYPE: Record<MarkupObject["kind"], string> = { highlight: "Highlight", underline: "Underline", strikeout: "StrikeOut", squiggly: "Squiggly" };

export function addMarkup(doc: PDFDocument, page: PDFPage, frame: PageFrame, object: MarkupObject, author: string): void {
  if (object.quads.length === 0) return;
  const { quads, rect } = quadsOf(frame, object.quads);
  const color = rgb(object.color);
  const content = appearanceContent(object.kind, quads, color);
  const stream = doc.context.flateStream(content, {
    Type: "XObject",
    Subtype: "Form",
    BBox: rect,
    Resources: { ExtGState: { GS: { Type: "ExtGState", CA: object.opacity, ca: object.opacity, ...(object.kind === "highlight" ? { BM: "Multiply" } : {}) } } },
  });
  const annotation = doc.context.obj({
    Type: "Annot",
    Subtype: SUBTYPE[object.kind],
    Rect: rect,
    QuadPoints: quads.flatMap((q) => q.points.flat()),
    C: color,
    CA: object.opacity,
    F: 4,
    T: PDFString.of(author || ""),
    Contents: PDFString.of(""),
    AP: { N: doc.context.register(stream) },
  });
  appendAnnotation(doc, page, annotation);
}

export function addComment(doc: PDFDocument, page: PDFPage, frame: PageFrame, object: CommentObject): void {
  const [x, y] = toUser(frame, object.x, object.y);
  const size = 22;
  const rect: [number, number, number, number] = [x, y - size, x + size, y];
  // A small yellow speech balloon.
  const content = [
    "1 0.88 0.2 rg 0.63 0.38 0.03 RG 1 w",
    `${fmt(x)} ${fmt(y)} m ${fmt(x + size)} ${fmt(y)} l ${fmt(x + size)} ${fmt(y - 15)} l ${fmt(x + 13)} ${fmt(y - 15)} l ${fmt(x + 8)} ${fmt(y - 21)} l ${fmt(x + 8)} ${fmt(y - 15)} l ${fmt(x)} ${fmt(y - 15)} h B`,
    `0.63 0.38 0.03 RG ${fmt(x + 5)} ${fmt(y - 5)} m ${fmt(x + 17)} ${fmt(y - 5)} l S ${fmt(x + 5)} ${fmt(y - 9)} m ${fmt(x + 13)} ${fmt(y - 9)} l S`,
  ].join("\n");
  const stream = doc.context.flateStream(content, { Type: "XObject", Subtype: "Form", BBox: rect });
  const annotation = doc.context.obj({
    Type: "Annot",
    Subtype: "Text",
    Rect: rect,
    Contents: PDFString.of(object.text),
    T: PDFString.of(object.author || ""),
    Name: "Comment",
    Open: false,
    C: [1, 0.88, 0.2],
    F: 28,
    AP: { N: doc.context.register(stream) },
  });
  appendAnnotation(doc, page, annotation);
}
