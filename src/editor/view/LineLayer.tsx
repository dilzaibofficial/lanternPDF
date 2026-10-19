import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import type { AnalyzedLine, PageAnalysis } from "../../lib/pdf/engine/analyze";
import type { EditOutcome } from "../../lib/pdf/engine/textEdit";
import type { Id, TextEditRecord } from "../model/types";

const FAMILIES: Record<AnalyzedLine["family"], string> = {
  sans: 'Helvetica, Arial, "Liberation Sans", "Segoe UI", sans-serif',
  serif: '"Times New Roman", Times, "Liberation Serif", Georgia, serif',
  mono: '"Courier New", Courier, "Liberation Mono", Consolas, monospace',
  symbol: 'Symbol, "Segoe UI Symbol", sans-serif',
};

/** CSS for text set like the line it stands in for. */
// eslint-disable-next-line react-refresh/only-export-components -- shared helper kept next to the code that uses it
export function lineTextStyle(line: AnalyzedLine, zoom: number): CSSProperties {
  return {
    fontFamily: FAMILIES[line.family],
    fontSize: line.size * zoom,
    fontWeight: line.bold ? 700 : 400,
    fontStyle: line.italic ? "italic" : "normal",
    color: line.color ?? "#000000",
    lineHeight: 1.2,
    whiteSpace: "pre",
  };
}

/** The little rectangle a line of text occupies, in its own turned frame: x along the baseline, y from the top of the letters. */
function frameOf(line: AnalyzedLine) {
  return { x: line.origin.x, y: line.origin.y - line.size * 0.86, width: Math.max(line.length, line.size * 0.6), height: line.size * 1.2 };
}

// ---------------------------------------------------------------------------------------------------------------

interface HitsProps {
  analysis: PageAnalysis;
  edits: Readonly<Record<string, TextEditRecord>>;
  /** Show the lines as clickable targets (the edit-text tool). */
  active: boolean;
  selectedId: string | null;
  zoom: number;
  onPick: (line: AnalyzedLine, caretIndex: number) => void;
  onRefuse: (line: AnalyzedLine) => void;
}

/** SVG layer over a page: every line of text as a target, with an outline on hover and a mark on edited lines. */
export function LineHits({ analysis, edits, active, selectedId, zoom, onPick, onRefuse }: HitsProps) {
  const px = 1 / zoom;
  return (
    <g data-testid="line-hits">
      {analysis.lines.map((line) => {
        const frame = frameOf(line);
        const edited = line.id in edits;
        const editable = line.verdict === "A";
        if (!active && !edited) return null;
        return (
          <g key={line.id} transform={`rotate(${line.angle} ${line.origin.x} ${line.origin.y})`}>
            {edited && <rect x={frame.x - 1} y={frame.y + frame.height - 1.2 * px * 2} width={frame.width + 2} height={2 * px} fill="var(--primary)" opacity={0.85} pointerEvents="none" data-testid="edited-mark" />}
            {active && (
              <rect
                className={`ed-line${editable ? "" : " ed-line--locked"}${selectedId === line.id ? " ed-line--selected" : ""}`}
                data-testid={`line-${line.id}`}
                data-line={line.id}
                data-editable={editable}
                x={frame.x - 2}
                y={frame.y - 1}
                width={frame.width + 4}
                height={frame.height + 2}
                rx={2 * px}
                strokeWidth={1.25 * px}
                onPointerDown={(event) => {
                  if (event.pointerType === "mouse" && event.button !== 0) return;
                  event.stopPropagation();
                  event.preventDefault();
                  if (!editable) {
                    onRefuse(line);
                    return;
                  }
                  onPick(line, caretFromPointer(event, line, zoom));
                }}
              >
                <title>{editable ? "Click to edit this text" : (line.reason ?? "This text cannot be edited")}</title>
              </rect>
            )}
          </g>
        );
      })}
    </g>
  );
}

/** Which character the pointer is nearest, so the caret starts where the person clicked. */
function caretFromPointer(event: ReactPointerEvent<SVGRectElement>, line: AnalyzedLine, zoom: number): number {
  const rect = event.currentTarget.getBoundingClientRect();
  // The rect is turned with the line; measure along the baseline using the unrotated width and the pointer's projection.
  const radians = (line.angle * Math.PI) / 180;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  void cx;
  void cy;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const svg = event.currentTarget.ownerSVGElement;
  const matrix = svg?.getScreenCTM();
  if (!matrix) return line.charOffsets.length - 1;
  const inverse = matrix.inverse();
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(inverse);
  const along = ((point.x - line.origin.x) * cos + (point.y - line.origin.y) * sin) * 1;
  void zoom;
  let best = 0;
  for (let i = 0; i < line.charOffsets.length; i += 1) if ((line.charOffsets[i] as number) <= along) best = i;
  const next = line.charOffsets[best + 1];
  const here = line.charOffsets[best] as number;
  if (next !== undefined && along - here > (next - here) / 2) best += 1;
  return Math.min(best, line.charOffsets.length - 1);
}

// ---------------------------------------------------------------------------------------------------------------

interface EditorProps {
  line: AnalyzedLine;
  text: string;
  zoom: number;
  caret: number;
  /** Letters of the text that the line's font cannot draw. */
  onCommit: (text: string) => void;
  onCancel: () => void;
}

/** The characters of `text` that need another font, given the letters the line's own font can draw. */
// eslint-disable-next-line react-refresh/only-export-components -- shared helper kept next to the code that uses it
export function lettersNeedingFallback(line: AnalyzedLine, text: string): string[] {
  const own = new Set(Array.from(line.availableChars));
  const missing = new Set<string>();
  for (const ch of Array.from(text)) {
    if (/\s/.test(ch) || own.has(ch)) continue;
    missing.add(ch);
  }
  return [...missing];
}

/** The box where an existing line is typed over: same font, size and place as the text it covers. */
export function LineEditor({ line, text, zoom, caret, onCommit, onCancel }: EditorProps) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(text);
  const done = useRef(false);
  const missing = useMemo(() => lettersNeedingFallback(line, value), [line, value]);
  const style = lineTextStyle(line, zoom);
  const left = line.origin.x * zoom;
  const top = (line.origin.y - line.size * 0.86) * zoom;
  const width = Math.max(line.length * zoom + 28, 90);

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    const at = Math.min(caret, element.value.length);
    element.setSelectionRange(at, at);
    // Placed once, when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };

  return (
    <div className="ed-lineeditor" style={{ left, top, transformOrigin: `0 ${line.size * 0.86 * zoom}px`, transform: `rotate(${line.angle}deg)` }}>
      <input
        ref={input}
        className="ed-lineeditor__input"
        data-testid="line-editor"
        aria-label={`Edit the text “${line.text}”. Press Enter to apply, Escape to cancel.`}
        value={value}
        spellCheck
        style={{ ...style, width, height: line.size * 1.3 * zoom }}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            finish(true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish(false);
          }
          event.stopPropagation();
        }}
      />
      {missing.length > 0 && (
        <p className="ed-lineeditor__note" data-testid="line-editor-note" style={{ top: line.size * 1.3 * zoom + 4 }}>
          {missing.join(" ")} {missing.length > 1 ? "are" : "is"} not in this document’s font, so {missing.length > 1 ? "they" : "it"} will be drawn in a similar one.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------

interface GhostProps {
  analysis: PageAnalysis;
  edits: Readonly<Record<string, TextEditRecord>>;
  zoom: number;
  /** True while the real result is still being worked out. */
  pending: boolean;
  skip: string | null;
}

/** While an edit is being applied to the page, the new text is shown over the old so the old never flashes back. */
export function LineGhosts({ analysis, edits, zoom, pending, skip }: GhostProps) {
  if (!pending) return null;
  return (
    <>
      {analysis.lines
        .filter((line) => line.id in edits && line.id !== skip)
        .map((line) => {
          const record = edits[line.id] as TextEditRecord;
          const style = lineTextStyle(line, zoom);
          const left = line.origin.x * zoom;
          const top = (line.origin.y - line.size * 0.86) * zoom;
          return (
            <div key={line.id} className="ed-ghost" aria-hidden="true" style={{ left, top, transformOrigin: `0 ${line.size * 0.86 * zoom}px`, transform: `rotate(${line.angle}deg)`, minWidth: line.length * zoom + 4, height: line.size * 1.25 * zoom, ...style }}>
              {record.text}
            </div>
          );
        })}
    </>
  );
}

/** What the engine said about an edit, for the properties panel. */
// eslint-disable-next-line react-refresh/only-export-components -- shared helper kept next to the code that uses it
export function outcomeFor(report: { outcomes: EditOutcome[] } | null | undefined, lineId: Id): EditOutcome | null {
  return report?.outcomes.find((o) => o.lineId === lineId) ?? null;
}
