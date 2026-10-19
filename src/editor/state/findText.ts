import type { AnalyzedLine, PageAnalysis } from "../../lib/pdf/engine/analyze";
import type { DocState, PageEntry } from "../model/types";
import type { FindMatch } from "./store";

/**
 * Finds text in what the editor knows of a page: the lines the engine read, with edits already applied. Matches are
 * in code points of the line's current text, so a replacement can be made by editing exactly that range.
 */

const fold = (text: string, caseSensitive: boolean) => (caseSensitive ? text : text.toLocaleLowerCase());

/** The four corners, in display space, of the stretch of a line between two character positions. */
export function quadOf(line: AnalyzedLine, from: number, to: number): [number, number][] {
  const offsets = line.charOffsets;
  const start = offsets[Math.min(from, offsets.length - 1)] ?? 0;
  const end = offsets[Math.min(to, offsets.length - 1)] ?? line.length;
  const radians = (line.angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const top = -line.size * 0.86;
  const bottom = line.size * 0.34;
  const point = (along: number, across: number): [number, number] => [line.origin.x + along * cos - across * sin, line.origin.y + along * sin + across * cos];
  return [point(start, top), point(end, top), point(end, bottom), point(start, bottom)];
}

export function findInAnalysis(doc: DocState, page: PageEntry, analysis: PageAnalysis, query: string, caseSensitive: boolean): FindMatch[] {
  const needle = Array.from(fold(query, caseSensitive));
  if (needle.length === 0) return [];
  const matches: FindMatch[] = [];
  for (const line of analysis.lines) {
    const edit = doc.textEdits[page.id]?.[line.id];
    const text = edit?.text ?? line.text;
    const haystack = Array.from(fold(text, caseSensitive));
    for (let i = 0; i + needle.length <= haystack.length; i += 1) {
      let same = true;
      for (let k = 0; k < needle.length; k += 1) {
        if (haystack[i + k] !== needle[k]) {
          same = false;
          break;
        }
      }
      if (!same) continue;
      // For a line that has been edited the offsets of the original no longer line up, so the whole line is marked.
      const quad = edit ? quadOf(line, 0, Array.from(line.text).length) : quadOf(line, i, i + needle.length);
      matches.push({ page: page.id, lineId: line.id, start: i, end: i + needle.length, quad });
      i += needle.length - 1;
    }
  }
  return matches;
}
