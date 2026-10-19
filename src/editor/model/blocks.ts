import type { AnalyzedLine } from "../../lib/pdf/engine/analyze";
import { unionBoxes } from "./geometry";
import type { Box } from "./types";

/**
 * Groups the lines of a page into blocks, the way a person sees "a text box": a heading is one block, a paragraph is one
 * block however many lines it runs to, and the cells of a table are separate blocks. Clicking text selects the block;
 * moving or removing it moves or removes all its lines.
 *
 * Lines are joined when they are stacked closely, are set the same way (size, face, colour, direction) and line up (a
 * shared left edge, right edge or centre, or mostly over each other). Lines in different columns are never joined.
 */

export interface TextBlock {
  /** The id of the block's first line, which names the block. */
  id: string;
  lines: AnalyzedLine[];
  /** The box that holds all its lines. */
  box: Box;
}

const near = (a: number, b: number, tolerance: number): boolean => Math.abs(a - b) <= tolerance;

/** Can `below` be the next line of the same block as `above`? */
function continues(above: AnalyzedLine, below: AnalyzedLine): boolean {
  if (Math.abs(above.angle) > 1 || Math.abs(below.angle) > 1) return false;
  if (Math.abs(above.size - below.size) > Math.max(0.6, above.size * 0.06)) return false;
  if (above.family !== below.family || above.color !== below.color) return false;
  const gap = below.box.y - (above.box.y + above.box.height);
  if (gap < -above.size * 0.55 || gap > above.size * 0.9) return false;
  const tolerance = Math.max(2, above.size * 0.35);
  const aLeft = above.box.x;
  const bLeft = below.box.x;
  const aRight = above.box.x + above.box.width;
  const bRight = below.box.x + below.box.width;
  if (near(aLeft, bLeft, tolerance) || near(aRight, bRight, tolerance) || near((aLeft + aRight) / 2, (bLeft + bRight) / 2, tolerance)) return true;
  const overlap = Math.min(aRight, bRight) - Math.max(aLeft, bLeft);
  return overlap > 0 && overlap >= 0.6 * Math.min(above.box.width, below.box.width);
}

/** The blocks of a page, in reading order (top to bottom, then left to right). Lines nobody can see are left out. */
export function groupTextBlocks(lines: readonly AnalyzedLine[]): TextBlock[] {
  const visible = lines.filter((line) => !line.invisible && line.text.trim() !== "");
  const sorted = [...visible].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  // Each line is joined to the closest line that can follow it, and each line follows at most one line.
  const next = new Map<AnalyzedLine, AnalyzedLine>();
  const taken = new Set<AnalyzedLine>();
  for (const above of sorted) {
    let best: AnalyzedLine | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const below of sorted) {
      if (below === above || taken.has(below) || below.box.y <= above.box.y) continue;
      if (!continues(above, below)) continue;
      const gap = below.box.y - above.box.y;
      if (gap < bestGap) {
        best = below;
        bestGap = gap;
      }
    }
    if (best) {
      next.set(above, best);
      taken.add(best);
    }
  }
  const blocks: TextBlock[] = [];
  for (const line of sorted) {
    if (taken.has(line)) continue; // not the first line of a block
    const members: AnalyzedLine[] = [line];
    for (let following = next.get(line); following; following = next.get(following)) members.push(following);
    blocks.push({ id: line.id, lines: members, box: unionBoxes(members.map((m) => m.box)) as Box });
  }
  return blocks;
}
