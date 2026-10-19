import { type TextLine, codePoints, glyphBoundaries } from "./lines";

/**
 * Works out which glyphs of a line an edit replaces. The line's old and new text are compared from both ends; what
 * is left in the middle is "remove these glyphs, insert this text". Positions are glyph indexes (`line.chars`), so
 * the edit lands on whole glyphs even where one glyph stands for several characters (an "fi" ligature).
 */

export interface LineDiff {
  /** First glyph of the line that is replaced (an insert point when `from === to`). */
  from: number;
  /** One past the last replaced glyph. */
  to: number;
  /** Characters to put in its place, as code points. */
  insert: string[];
  /** True when old and new text are identical. */
  same: boolean;
}

export function diffLine(line: TextLine, newText: string): LineDiff {
  const oldPoints = codePoints(line.text);
  const newPoints = codePoints(newText);
  if (line.text === newText) return { from: 0, to: 0, insert: [], same: true };

  let prefix = 0;
  const shortest = Math.min(oldPoints.length, newPoints.length);
  while (prefix < shortest && oldPoints[prefix] === newPoints[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shortest - prefix && oldPoints[oldPoints.length - 1 - suffix] === newPoints[newPoints.length - 1 - suffix]) suffix += 1;

  const removedStart = prefix;
  const removedEnd = oldPoints.length - suffix;
  const bounds = glyphBoundaries(line);
  const count = line.chars.length;

  // First glyph that starts at or after the cut; if the cut is inside a ligature, the glyph that contains it.
  let from = 0;
  while (from < count && (bounds[from + 1] as number) <= removedStart) from += 1;
  let to = from;
  while (to < count && (bounds[to] as number) < removedEnd) to += 1;
  // A pure insertion exactly between two glyphs keeps `from === to`; a cut inside a glyph widens to the whole glyph.
  if (removedStart === removedEnd) {
    to = from;
    if ((bounds[from] as number) < removedStart && from < count) to = from + 1; // inside a ligature
  }

  let insert = newPoints.slice(prefix, newPoints.length - suffix);
  // The part of a widened glyph that was not actually deleted is put back.
  const keptBefore = oldPoints.slice(bounds[from] as number, removedStart);
  const keptAfter = oldPoints.slice(removedEnd, bounds[to] as number);
  if ((bounds[from] as number) < removedStart && from < count) insert = [...keptBefore, ...insert];
  if (removedEnd < (bounds[to] as number)) insert = [...insert, ...keptAfter];

  return { from, to, insert, same: false };
}
