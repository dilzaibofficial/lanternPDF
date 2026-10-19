import type { TextRun } from "./interpret";
import type { TextLine } from "./lines";
import { type Matrix, applyVector, invert, multiply, translation } from "./matrix";
import type { Splice } from "./splice";
import { parseSource } from "./streams";
import { formatNumber } from "./tokenizer";

/**
 * Moving and removing whole lines of text.
 *
 * A line is moved by putting an absolute `Tm` in front of it (its own text matrix, shifted) and, after it, putting back
 * the line matrix and pen position the page had there, so everything drawn later stays where it was. Removing a line
 * deletes its text-showing operators and puts the same state back. Neither touches the font or the glyphs.
 */

export interface LineChange {
  splices: Splice[];
  /** Why the line cannot be changed; when set there are no splices. */
  refusal: string | null;
}

const precise = (value: number) => formatNumber(Math.round(value * 1e6) / 1e6).replace(/^-0$/, "0");
const matrixText = (m: Matrix) => m.map(precise).join(" ");

/** Operators after which the line matrix and the pen no longer matter. */
const RESETS = new Set(["ET", "Tm", "BT"]);

/** Why a line cannot be moved or removed as it is, or null. */
export function whyLineLocked(line: TextLine): string | null {
  const first = line.runs[0];
  for (const run of line.runs) {
    if (run.font.vertical) return "Vertical text is not supported.";
    if (run.actualText !== null) return "This text carries replacement text for accessibility (ActualText) that moving or removing it would leave out of step.";
    if (run.source.unreadable > 0 || run.source.tooLarge) return "Its content could not be read completely.";
    if (run.fontSize === 0) return "Its type has no size.";
  }
  if (first && line.runs.some((run) => run.textObject !== first.textObject)) return "This line is built from pieces drawn separately, so it cannot be moved as one.";
  return null;
}

/** Puts the line matrix and the pen back where they were after `last`, as text to write after it; empty when nothing needs it. */
function restoreAfter(last: TextRun): string | null {
  const ops = parseSource(last.source).ops;
  const next = ops[last.opIndex + 1];
  if (next && RESETS.has(next.op)) return "";
  if (!next) return "";
  const pen = multiply(translation(last.advance, 0), last.textMatrix);
  const line = last.lineMatrix;
  const inverse = invert([line[0], line[1], line[2], line[3], 0, 0]);
  if (!inverse) return null;
  const [kx, ky] = applyVector(inverse, pen[4] - line[4], pen[5] - line[5]);
  if (Math.abs(ky) > 1e-3 * Math.max(1, Math.abs(kx))) return null;
  let text = `${matrixText(line)} Tm`;
  if (Math.abs(kx) > 1e-6) text += ` [${precise((-kx * 1000) / (last.fontSize * last.hScale))}] TJ`;
  return ` ${text}`;
}

/**
 * Moves a line by (`dx`, `dy`), given in the space the stream draws in (user space for a page's own content).
 */
export function planLineMove(line: TextLine, dx: number, dy: number): LineChange {
  const blocked = whyLineLocked(line);
  if (blocked) return { splices: [], refusal: blocked };
  const first = line.runs[0] as TextRun;
  const last = line.runs[line.runs.length - 1] as TextRun;
  const inverse = invert([first.ctm[0], first.ctm[1], first.ctm[2], first.ctm[3], 0, 0]);
  if (!inverse) return { splices: [], refusal: "The text is drawn in a collapsed coordinate system." };
  const [tx, ty] = applyVector(inverse, dx, dy);
  const shift = (m: Matrix): Matrix => [m[0], m[1], m[2], m[3], m[4] + tx, m[5] + ty];

  const splices: Splice[] = [];
  const ops = parseSource(first.source).ops;

  // The line starts from its own text matrix, shifted. (For ' and " the line feed comes after this, so start one line up.)
  const newline = first.operator === "'" || first.operator === '"';
  const base = newline ? multiply(translation(0, first.leading), first.lineMatrix) : first.textMatrix;
  splices.push({ start: first.op.start, end: first.op.start, text: ` ${matrixText(shift(base))} Tm ` });

  // Pieces placed by their own absolute Tm follow the move too.
  for (let i = first.opIndex + 1; i < last.opIndex; i += 1) {
    const op = ops[i];
    if (!op || op.op !== "Tm") continue;
    const values = op.args.slice(-6).map((a) => (a.t === "num" ? a.v : Number.NaN));
    if (values.length !== 6 || !values.every(Number.isFinite)) return { splices: [], refusal: "A positioning operator in this line could not be read." };
    splices.push({ start: op.start, end: op.end, text: ` ${matrixText(shift(values as unknown as Matrix))} Tm ` });
  }

  const restore = restoreAfter(last);
  if (restore === null) return { splices: [], refusal: "The text position after this line could not be restored, so moving it would shift what follows." };
  if (restore !== "") splices.push({ start: last.op.end, end: last.op.end, text: `${restore} ` });
  return { splices, refusal: null };
}

/** Removes a line: its text-showing operators go, and the state after it is put back for what follows. */
export function planLineDelete(line: TextLine): LineChange {
  const blocked = whyLineLocked(line);
  if (blocked) return { splices: [], refusal: blocked };
  const splices: Splice[] = [];
  for (const segment of line.segments) {
    const last = segment.runs[segment.runs.length - 1] as TextRun;
    const restore = restoreAfter(last);
    if (restore === null) return { splices: [], refusal: "The text position after this line could not be restored, so removing it would shift what follows." };
    splices.push({ start: segment.spanStart, end: segment.spanEnd, text: restore === "" ? " " : restore });
  }
  return { splices, refusal: null };
}
