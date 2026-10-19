import { AppError } from "../../errors";

/** A replacement of the bytes `[start, end)` of a content stream with `text` (an insertion when `start === end`). */
export interface Splice {
  start: number;
  end: number;
  text: string;
  /** The object edit that asked for it, so that all of its replacements can be dropped together when they collide with others. */
  owner?: string;
}

/**
 * Applies replacements to a content stream. They must not overlap; insertions at the same place come out in the
 * order they were given, and an insertion at the point where a replacement ends comes after the replacement.
 */
export function applySplices(data: Uint8Array, splices: readonly Splice[]): Uint8Array {
  const sorted = splices.map((splice, index) => ({ splice, index })).sort((a, b) => a.splice.start - b.splice.start || a.splice.end - b.splice.end || a.index - b.index);
  const chunks: Uint8Array[] = [];
  let at = 0;
  for (const { splice } of sorted) {
    if (splice.start < at) throw new AppError("ENGINE_FAILED", "Two edits overlap in the page content.");
    chunks.push(data.subarray(at, splice.start), bytesOf(splice.text));
    at = splice.end;
  }
  chunks.push(data.subarray(at));
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** The bytes of replacement text: one byte per character (content streams are bytes, and copied operators may hold any byte value). */
function bytesOf(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Drops the replacements that cannot all be made. Where two overlap, the one that belongs to an object edit goes (all of
 * that edit's replacements with it); where both do, the later one goes. Returns what is left and who was dropped.
 */
export function dropConflicts(splices: readonly Splice[]): { kept: Splice[]; dropped: Set<string> } {
  let kept = [...splices];
  const dropped = new Set<string>();
  for (let guard = 0; guard < splices.length + 1; guard += 1) {
    const sorted = kept.map((splice, index) => ({ splice, index })).sort((a, b) => a.splice.start - b.splice.start || a.splice.end - b.splice.end || a.index - b.index);
    let at = 0;
    let holder: Splice | null = null;
    let loser: Splice | null = null;
    for (const { splice } of sorted) {
      if (splice.start < at && holder) {
        loser = splice.owner ? splice : holder.owner ? holder : null;
        if (!loser) loser = splice;
        break;
      }
      if (splice.end >= at) {
        at = splice.end;
        holder = splice;
      }
    }
    if (!loser) break;
    if (!loser.owner) break; // two edits of text overlapping: applying them will report it
    const owner = loser.owner;
    dropped.add(owner);
    kept = kept.filter((splice) => splice.owner !== owner);
  }
  return { kept, dropped };
}
