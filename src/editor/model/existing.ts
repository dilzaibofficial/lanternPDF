import type { AnalyzedLine, PageAnalysis } from "../../lib/pdf/engine/analyze";
import type { ObjectEdit } from "../../lib/pdf/engine/objects";
import { groupTextBlocks } from "./blocks";
import type { Box, ExistingEdit, ExistingObject, Id, OrientedPlacement } from "./types";

/**
 * What the page already draws, as the editor's objects. Everything here is derived from the analysis of the page and
 * the edits recorded for it; nothing is stored twice.
 */

const SEPARATOR = "~";

/** The id an existing object has in the editor: unique across the document (its page, then its key on that page). */
export const existingId = (page: Id, key: string): Id => `${page}${SEPARATOR}${key}`;

export function parseExistingId(id: Id): { page: Id; key: string } | null {
  const at = id.indexOf(SEPARATOR);
  return at > 0 ? { page: id.slice(0, at), key: id.slice(at + 1) } : null;
}

export const isExistingId = (id: Id): boolean => id.includes(SEPARATOR);

export const samePlacement = (a: OrientedPlacement, b: OrientedPlacement): boolean =>
  Math.abs(a.x - b.x) < 5e-3 && Math.abs(a.y - b.y) < 5e-3 && Math.abs(a.width - b.width) < 5e-3 && Math.abs(a.height - b.height) < 5e-3 && Math.abs(a.rotation - b.rotation) < 5e-3;

const NOT_MOVABLE = "This item cannot be changed.";

/** The existing objects of a page, bottom first: images, shapes, annotations and blocks of text, with the editor's changes applied. Removed ones are left out. */
export function existingObjects(pageId: Id, analysis: PageAnalysis, edits: Readonly<Record<string, ExistingEdit>> | undefined): ExistingObject[] {
  const out: ExistingObject[] = [];
  const base = { page: pageId, opacity: 1, kind: "existing" as const };

  for (const block of groupTextBlocks(analysis.lines)) {
    const key = `block:${block.id}`;
    const edit = edits?.[key];
    if (edit?.deleted) continue;
    const reason = block.lines.map((line) => line.locked).find((value) => value !== null && value !== undefined) ?? null;
    const origin: OrientedPlacement = { ...block.box, rotation: 0 };
    const place = edit?.place;
    const x = place?.x ?? origin.x;
    const y = place?.y ?? origin.y;
    const dx = x - origin.x;
    const dy = y - origin.y;
    out.push({
      ...base,
      id: existingId(pageId, key),
      what: "text",
      key,
      label: block.lines.length > 1 ? "Text block" : "Text line",
      order: Math.min(...block.lines.map((line) => line.order)),
      origin,
      x,
      y,
      width: origin.width,
      height: origin.height,
      rotation: 0,
      locked: reason !== null,
      outline: null,
      filled: false,
      stroked: false,
      lines: block.lines.map((line) => ({ id: line.id, box: { x: line.box.x + dx, y: line.box.y + dy, width: line.box.width, height: line.box.height } })),
      canMove: reason === null,
      canResize: false,
      canRotate: false,
      canReorder: false,
      reason,
      edited: Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6,
      pixelWidth: null,
      pixelHeight: null,
      contents: null,
    });
  }

  for (const object of analysis.objects) {
    if (object.background) continue; // the page's own background is not a thing to pick up
    const edit = edits?.[object.id];
    if (edit?.deleted) continue;
    const origin: OrientedPlacement = { ...object.box };
    const place = edit?.place ?? origin;
    out.push({
      ...base,
      id: existingId(pageId, object.id),
      what: object.kind === "annotation" ? "annotation" : object.kind === "image" ? "image" : "shape",
      key: object.id,
      label: object.label,
      order: object.order,
      origin,
      x: place.x,
      y: place.y,
      width: place.width,
      height: place.height,
      rotation: place.rotation,
      locked: !object.canMove,
      outline: object.outline,
      filled: object.fill,
      stroked: object.stroke,
      lines: null,
      canMove: object.canMove,
      canResize: object.canResize,
      canRotate: object.canRotate,
      canReorder: object.canReorder,
      reason: object.reason ?? (object.canMove ? null : NOT_MOVABLE),
      edited: Boolean(edit?.place && !samePlacement(edit.place, origin)) || Boolean(edit?.order),
      pixelWidth: object.pixelWidth,
      pixelHeight: object.pixelHeight,
      contents: object.contents,
    });
  }
  return out.sort((a, b) => a.order - b.order);
}

/** The lines of a page where they are now: blocks that were moved are shifted, blocks that were removed are gone. */
export function effectiveLines(analysis: PageAnalysis, edits: Readonly<Record<string, ExistingEdit>> | undefined): AnalyzedLine[] {
  if (!hasExistingEdits(edits)) return analysis.lines;
  const blocks = groupTextBlocks(analysis.lines);
  const inBlock = new Set<string>();
  const out: AnalyzedLine[] = [];
  for (const block of blocks) {
    for (const line of block.lines) inBlock.add(line.id);
    const edit = edits?.[`block:${block.id}`];
    if (edit?.deleted) continue;
    const dx = (edit?.place?.x ?? block.box.x) - block.box.x;
    const dy = (edit?.place?.y ?? block.box.y) - block.box.y;
    for (const line of block.lines) {
      out.push(dx === 0 && dy === 0 ? line : { ...line, box: { ...line.box, x: line.box.x + dx, y: line.box.y + dy }, origin: { x: line.origin.x + dx, y: line.origin.y + dy } });
    }
  }
  return [...out, ...analysis.lines.filter((line) => !inBlock.has(line.id))];
}

/** The same edits as the engine wants them: one change per thing it can address (a block of text becomes a change per line). */
export function toEngineEdits(analysis: PageAnalysis, edits: Readonly<Record<string, ExistingEdit>>): ObjectEdit[] {
  const out: ObjectEdit[] = [];
  const blocks = new Map(groupTextBlocks(analysis.lines).map((block) => [`block:${block.id}`, block]));
  for (const [key, edit] of Object.entries(edits)) {
    const block = blocks.get(key);
    if (block) {
      if (edit.deleted) {
        for (const line of block.lines) out.push({ id: line.id, delete: true });
      } else if (edit.place) {
        const dx = edit.place.x - block.box.x;
        const dy = edit.place.y - block.box.y;
        if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) for (const line of block.lines) out.push({ id: line.id, move: { dx, dy } });
      }
      continue;
    }
    const object = analysis.objects.find((candidate) => candidate.id === key);
    if (!object) continue;
    if (edit.deleted) {
      out.push({ id: key, delete: true });
      continue;
    }
    const target = edit.place && !samePlacement(edit.place, object.box) ? edit.place : undefined;
    if (target || edit.order) out.push({ id: key, target, order: edit.order });
  }
  return out;
}

/** True when the page has anything for the engine to do. */
export const hasExistingEdits = (edits: Readonly<Record<string, ExistingEdit>> | undefined): boolean => Boolean(edits && Object.keys(edits).length > 0);

export const boxOf = (object: Box): Box => ({ x: object.x, y: object.y, width: object.width, height: object.height });
