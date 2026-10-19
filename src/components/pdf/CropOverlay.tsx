import { type KeyboardEvent, type PointerEvent, useRef } from "react";

/** How much to remove from each edge, as a fraction (0..1) of the page's width or height. */
export interface CropFractions {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type Edge = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "move";

const EDGES: Exclude<Edge, "move">[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
/** The smallest crop box: a tenth of the page in each direction. */
const MIN = 0.1;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function apply(start: CropFractions, edge: Edge, dx: number, dy: number): CropFractions {
  const next = { ...start };
  if (edge === "move") {
    const shiftX = clamp(dx, -start.left, start.right);
    const shiftY = clamp(dy, -start.top, start.bottom);
    return { left: start.left + shiftX, right: start.right - shiftX, top: start.top + shiftY, bottom: start.bottom - shiftY };
  }
  if (edge.includes("w")) next.left = clamp(start.left + dx, 0, 1 - start.right - MIN);
  if (edge.includes("e")) next.right = clamp(start.right - dx, 0, 1 - start.left - MIN);
  if (edge.includes("n")) next.top = clamp(start.top + dy, 0, 1 - start.bottom - MIN);
  if (edge.includes("s")) next.bottom = clamp(start.bottom - dy, 0, 1 - start.top - MIN);
  return next;
}

interface Props {
  value: CropFractions;
  onChange: (value: CropFractions) => void;
}

/**
 * The draggable crop rectangle drawn over a page preview. It fills the page area (its parent) and
 * works in fractions, so it does not care how large the preview is drawn. The numeric fields next to
 * it are the keyboard-friendly alternative to dragging.
 */
export function CropOverlay({ value, onChange }: Props) {
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<{ edge: Edge; startX: number; startY: number; start: CropFractions } | null>(null);

  const begin = (edge: Edge) => (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag.current = { edge, startX: event.clientX, startY: event.clientY, start: value };
  };
  const move = (event: PointerEvent) => {
    const state = drag.current;
    const box = area.current?.getBoundingClientRect();
    if (!state || !box || box.width === 0 || box.height === 0) return;
    onChange(apply(state.start, state.edge, (event.clientX - state.startX) / box.width, (event.clientY - state.startY) / box.height));
  };
  const end = () => {
    drag.current = null;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 0.05 : 0.01;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const delta = moves[event.key];
    if (!delta) return;
    event.preventDefault();
    onChange(apply(value, "move", delta[0], delta[1]));
  };

  return (
    <div ref={area} style={{ position: "absolute", inset: 0 }} data-testid="crop-area">
      <div
        className="crop-box"
        role="group"
        aria-label="Crop box. Use the arrow keys to move it, or the margin fields to size it."
        tabIndex={0}
        data-testid="crop-box"
        style={{ left: `${value.left * 100}%`, top: `${value.top * 100}%`, right: `${value.right * 100}%`, bottom: `${value.bottom * 100}%` }}
        onPointerDown={begin("move")}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={onKeyDown}
      >
        {EDGES.map((edge) => (
          <span key={edge} className="crop-box__handle" data-edge={edge} onPointerDown={begin(edge)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
        ))}
      </div>
    </div>
  );
}
