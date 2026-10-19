import { type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, useMemo, useRef, useState } from "react";
import { simplifyPoints } from "../../lib/pdf/annotateModel";
import type { PageAnalysis } from "../../lib/pdf/engine/analyze";
import {
  CORNER_HANDLES,
  type Guide,
  HANDLES,
  type Handle,
  boundsOf,
  boxFromCorners,
  carryPoint,
  centreOf,
  frameOf,
  handlePoint,
  hits,
  isBoxObject,
  resizeFromHandle,
  rotatePoint,
  rotationToward,
  snapBox,
  translate,
} from "../model/geometry";
import { applyBox, constrainAngle, marqueeSelect, selectionBounds, selectionQuads } from "../model/transform";
import { CLICK_SIZES, type ToolDefaults, makeComment, makeCover, makeDraw, makeField, makeLine, makeMarkup, makeRedaction, makeShape, makeTextBox } from "../model/defaults";
import type { Box, EditorObject, ExistingObject, Id, ImageObject, PageEntry, Pt, ToolId } from "../model/types";
import { type Ghost, ghostTransform } from "./ghost";
import { ObjectView, measureWithCanvas } from "./ObjectViews";

type Gesture =
  | { type: "move"; ids: Id[]; start: Pt; originals: EditorObject[]; dx: number; dy: number; moved: boolean; guides: Guide[] }
  | { type: "resize"; id: Id; handle: Handle; original: EditorObject; current: EditorObject }
  | { type: "rotate"; id: Id; original: EditorObject; current: EditorObject }
  | { type: "endpoint"; id: Id; which: 1 | 2; original: Extract<EditorObject, { kind: "line" }>; current: Extract<EditorObject, { kind: "line" }> }
  | { type: "create"; tool: ToolId; start: Pt; current: Pt; points: [number, number][]; shift: boolean }
  | { type: "marquee"; start: Pt; current: Pt; additive: boolean; base: Id[] };

const TOOL_CURSOR: Partial<Record<ToolId, string>> = { text: "text", hand: "grab" };
const ROTATABLE = new Set(["text", "image", "rect", "ellipse", "cover"]);
const DOUBLE_PRESS_MS = 380;
const MIN_DRAG = 3;

const nameFor = (tool: ToolId, existing: number) => `${tool.replace("field-", "")}${existing + 1}`;

export interface ObjectLayerProps {
  page: PageEntry;
  /** What was added to the page. */
  objects: readonly EditorObject[];
  /** What the page already draws, bottom first. */
  existing: readonly ExistingObject[];
  /** Copies of existing objects lifted off the page while their change is made in the file. */
  ghosts: readonly Ghost[];
  /** An existing object is about to change: lift it off the page. */
  onLift: (objects: readonly ExistingObject[]) => void;
  /** The pointer is done with it. */
  onLiftDone: () => void;
  tool: ToolId;
  selection: readonly Id[];
  zoom: number;
  analysis: PageAnalysis | null;
  defaults: ToolDefaults;
  snap: boolean;
  imageUrl: (image: ImageObject["image"]) => string;
  /** Text box being typed in: its own text is not drawn under the editor. */
  editingId: Id | null;
  svgRef: RefObject<SVGSVGElement | null>;
  onSelect: (ids: Id[]) => void;
  onCreate: (objects: EditorObject[], options?: { edit?: boolean }) => void;
  onChange: (objects: EditorObject[], label: string, key: string) => void;
  onEdit: (id: Id) => void;
  /** Double-click on text the page already has: the line under the pointer can be edited. */
  onEditExisting?: (object: ExistingObject, at: Pt) => void;
  /** Double-click on empty page: the line of text under it can be edited. */
  onBackgroundDoubleClick?: (at: Pt) => void;
  /** Drawn inside the SVG above the page's objects (the clickable lines of text). */
  children?: ReactNode;
}

/** The objects on one page and everything that happens to them with the pointer. */
export function ObjectLayer(props: ObjectLayerProps) {
  const { page, objects, existing, ghosts, onLift, onLiftDone, tool, selection, zoom, analysis, defaults, snap, imageUrl, editingId, svgRef, onSelect, onCreate, onChange, onEdit, onEditExisting, onBackgroundDoubleClick, children } = props;
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [hover, setHover] = useState<Id | null>(null);
  const lastPress = useRef<{ id: Id | "page"; at: number } | null>(null);
  const px = 1 / zoom;
  const tolerance = 6 * px;

  const toBase = (event: { clientX: number; clientY: number }): Pt => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return { x: 0, y: 0 };
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  };

  // Everything that can be picked, bottom first: what sits behind the page's own content, what the page draws, what is on top.
  const all = useMemo<EditorObject[]>(() => [...objects.filter((o) => o.behind), ...existing, ...objects.filter((o) => !o.behind)], [objects, existing]);

  const topAt = (point: Pt): EditorObject | null => {
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const object = all[i] as EditorObject;
      if (hits(object, point, tolerance)) return object;
    }
    return null;
  };

  /** The ids that are chosen together with `id`: its whole group. */
  const withGroup = (id: Id): Id[] => {
    const found = all.find((o) => o.id === id);
    return found?.group ? all.filter((o) => o.group === found.group).map((o) => o.id) : [id];
  };

  // What is on screen: the objects with the gesture applied to them.
  const shown = useMemo(() => {
    if (!gesture) return all;
    if (gesture.type === "move") {
      const by = new Map(gesture.originals.map((o) => [o.id, translate(o, gesture.dx, gesture.dy)]));
      return all.map((o) => by.get(o.id) ?? o);
    }
    if (gesture.type === "resize" || gesture.type === "rotate" || gesture.type === "endpoint") return all.map((o) => (o.id === gesture.current.id ? gesture.current : o));
    return all;
  }, [all, gesture]);

  const selected = shown.filter((o) => selection.includes(o.id));
  const interactive = tool === "select";

  // ---- starting gestures --------------------------------------------------------------------------------------------------

  const capture = (event: ReactPointerEvent) => {
    svgRef.current?.setPointerCapture(event.pointerId);
    // Starting a gesture on the page takes the keyboard from whatever button was used last, so the arrow keys and Delete
    // act on the selection (the default focus change is prevented to keep a drag from selecting text).
    svgRef.current?.closest<HTMLElement>(".ed-viewport")?.focus({ preventScroll: true });
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (tool === "hand") return;
    const point = toBase(event);

    if (tool === "edit-text") {
      onSelect([]);
      return;
    }

    if (tool === "select") {
      const target = topAt(point);
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;
      if (target) {
        event.preventDefault();
        capture(event);
        const now = Date.now();
        const double = lastPress.current?.id === target.id && now - lastPress.current.at < DOUBLE_PRESS_MS;
        lastPress.current = { id: target.id, at: now };
        let ids: Id[];
        const family = withGroup(target.id);
        if (selection.includes(target.id)) ids = additive ? selection.filter((id) => !family.includes(id)) : [...selection];
        else ids = additive ? [...new Set([...selection, ...family])] : family;
        onSelect(ids);
        if (double && (target.kind === "text" || target.kind === "comment")) {
          onEdit(target.id);
          return;
        }
        if (double && target.kind === "existing" && target.what === "text") {
          onEditExisting?.(target, point);
          return;
        }
        if (ids.includes(target.id)) {
          const movers = all.filter((o) => ids.includes(o.id) && !o.locked);
          if (movers.length > 0) setGesture({ type: "move", ids: movers.map((o) => o.id), start: point, originals: movers, dx: 0, dy: 0, moved: false, guides: [] });
        }
        return;
      }
      const now = Date.now();
      const double = lastPress.current?.id === "page" && now - lastPress.current.at < DOUBLE_PRESS_MS;
      lastPress.current = { id: "page", at: now };
      if (double && onBackgroundDoubleClick) {
        onBackgroundDoubleClick(point);
        return;
      }
      event.preventDefault();
      capture(event);
      setGesture({ type: "marquee", start: point, current: point, additive, base: additive ? [...selection] : [] });
      if (!additive) onSelect([]);
      return;
    }

    event.preventDefault();
    capture(event);
    setGesture({ type: "create", tool, start: point, current: point, points: [[point.x, point.y]], shift: event.shiftKey });
  };

  const startResize = (event: ReactPointerEvent, object: EditorObject, handle: Handle) => {
    event.stopPropagation();
    event.preventDefault();
    capture(event);
    setGesture({ type: "resize", id: object.id, handle, original: object, current: object });
  };

  const startRotate = (event: ReactPointerEvent, object: EditorObject) => {
    event.stopPropagation();
    event.preventDefault();
    capture(event);
    setGesture({ type: "rotate", id: object.id, original: object, current: object });
  };

  const startEndpoint = (event: ReactPointerEvent, object: Extract<EditorObject, { kind: "line" }>, which: 1 | 2) => {
    event.stopPropagation();
    event.preventDefault();
    capture(event);
    setGesture({ type: "endpoint", id: object.id, which, original: object, current: object });
  };

  // ---- moving ----------------------------------------------------------------------------------------------------------------

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const point = toBase(event);
    if (!gesture) {
      if (interactive) {
        const over = topAt(point)?.id ?? null;
        if (over !== hover) setHover(over);
      }
      return;
    }
    switch (gesture.type) {
      case "move": {
        let dx = point.x - gesture.start.x;
        let dy = point.y - gesture.start.y;
        if (event.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        let guides: Guide[] = [];
        const bounds = selectionBounds(gesture.originals);
        if (snap && bounds && !event.altKey) {
          const others = all.filter((o) => !gesture.ids.includes(o.id)).map(boundsOf);
          const result = snapBox({ ...bounds, x: bounds.x + dx, y: bounds.y + dy }, others, page, 6 * px);
          dx += result.dx;
          dy += result.dy;
          guides = result.guides;
        }
        const moved = gesture.moved || Math.hypot(dx, dy) > 0.5 * px;
        if (moved && !gesture.moved) onLift(gesture.originals.filter((o): o is ExistingObject => o.kind === "existing"));
        setGesture({ ...gesture, dx, dy, guides, moved });
        return;
      }
      case "resize": {
        const original = gesture.original;
        if (original.kind === "line") return;
        const frame = frameOf(original);
        const rotation = isBoxObject(original) ? original.rotation : 0;
        const keepAspect = (event.shiftKey || original.kind === "image" || (original.kind === "existing" && original.what === "image")) && !event.altKey && (CORNER_HANDLES as readonly string[]).includes(gesture.handle);
        const box = resizeFromHandle(frame, rotation, gesture.handle, point, { keepAspect, fromCentre: event.altKey });
        let next = applyBox(original, box, measureWithCanvas);
        if (next.kind === "text" && (gesture.handle.includes("n") || gesture.handle.includes("s"))) next = { ...next, autoHeight: false };
        if (original.kind === "existing" && gesture.current === gesture.original) onLift([original]);
        setGesture({ ...gesture, current: next });
        return;
      }
      case "rotate": {
        const original = gesture.original;
        if (!isBoxObject(original)) return;
        const angle = rotationToward(centreOf(frameOf(original)), point, event.shiftKey ? 15 : 0);
        if (original.kind === "existing" && gesture.current === gesture.original) onLift([original]);
        setGesture({ ...gesture, current: { ...original, rotation: Math.round(angle * 10) / 10 } });
        return;
      }
      case "endpoint": {
        const other = gesture.which === 1 ? { x: gesture.original.x2, y: gesture.original.y2 } : { x: gesture.original.x1, y: gesture.original.y1 };
        const to = event.shiftKey ? constrainAngle(other, point) : point;
        setGesture({ ...gesture, current: gesture.which === 1 ? { ...gesture.original, x1: to.x, y1: to.y } : { ...gesture.original, x2: to.x, y2: to.y } });
        return;
      }
      case "create": {
        if (gesture.tool === "draw") {
          const last = gesture.points[gesture.points.length - 1] as [number, number];
          if (Math.hypot(point.x - last[0], point.y - last[1]) < 0.4 * px) return;
          setGesture({ ...gesture, points: [...gesture.points, [point.x, point.y]], current: point });
        } else {
          setGesture({ ...gesture, current: point, shift: event.shiftKey });
        }
        return;
      }
      case "marquee":
        setGesture({ ...gesture, current: point });
    }
  };

  // ---- finishing ---------------------------------------------------------------------------------------------------------------

  const finishCreate = (g: Extract<Gesture, { type: "create" }>) => {
    const dragged = Math.hypot(g.current.x - g.start.x, g.current.y - g.start.y) >= MIN_DRAG * px;
    const box = boxFromCorners(g.start, g.current);
    const click = CLICK_SIZES[g.tool];
    const id = page.id;
    const existing = objects.filter((o) => o.kind === "field").length;
    switch (g.tool) {
      case "text": {
        const made = dragged ? makeTextBox(id, g.start, defaults, { x: box.x, y: box.y, width: Math.max(box.width, 24) }) : makeTextBox(id, g.start, defaults, { x: g.start.x, y: g.start.y - defaults.text.size * 0.5 });
        onCreate([made], { edit: true });
        return;
      }
      case "rect":
      case "ellipse":
        onCreate([makeShape(id, g.tool, dragged ? box : { x: g.start.x - 70, y: g.start.y - 45, width: 140, height: 90 }, defaults)]);
        return;
      case "cover":
        onCreate([makeCover(id, dragged ? box : { x: g.start.x, y: g.start.y, width: click?.width ?? 160, height: click?.height ?? 28 }, defaults)]);
        return;
      case "redact":
        onCreate([makeRedaction(id, dragged ? box : { x: g.start.x, y: g.start.y, width: click?.width ?? 160, height: click?.height ?? 28 }, defaults)]);
        return;
      case "line":
      case "arrow": {
        if (!dragged) return;
        const to = g.shift ? constrainAngle(g.start, g.current) : g.current;
        onCreate([makeLine(id, g.start, to, g.tool === "arrow", defaults)]);
        return;
      }
      case "draw": {
        const points = simplifyPoints(g.points, 0.7 * px);
        onCreate([makeDraw(id, points.length === 1 ? [points[0] as [number, number], [(points[0] as [number, number])[0] + 0.01, (points[0] as [number, number])[1]]] : points, defaults)]);
        return;
      }
      case "highlight":
      case "underline":
      case "strikeout":
      case "squiggly": {
        if (!dragged) return;
        const quads = selectionQuads(g.start, g.current, analysis?.lines ?? []);
        if (quads.length > 0) onCreate([makeMarkup(id, g.tool, quads, defaults)]);
        return;
      }
      case "comment":
        onCreate([makeComment(id, g.start, defaults)], { edit: true });
        return;
      case "field-text":
      case "field-checkbox":
      case "field-radio":
      case "field-dropdown":
      case "field-signature": {
        const kind = g.tool.replace("field-", "") as "text" | "checkbox" | "radio" | "dropdown" | "signature";
        const size = click ?? { width: 160, height: 26 };
        onCreate([makeField(id, kind, dragged ? box : { x: g.start.x, y: g.start.y, ...size }, nameFor(g.tool, existing))]);
        return;
      }
      default:
        return;
    }
  };

  const finish = () => {
    const g = gesture;
    setGesture(null);
    if (!g) return;
    switch (g.type) {
      case "move":
        if (g.moved)
          onChange(
            g.originals.map((o) => translate(o, g.dx, g.dy)),
            g.originals.length > 1 ? `Move ${g.originals.length} objects` : "Move",
            `move:${g.ids.join(",")}`,
          );
        onLiftDone();
        return;
      case "resize":
        if (g.current !== g.original) onChange([g.current], "Resize", `resize:${g.id}`);
        onLiftDone();
        return;
      case "rotate":
        if (g.current !== g.original) onChange([g.current], "Rotate", `rotate:${g.id}`);
        onLiftDone();
        return;
      case "endpoint":
        if (g.current !== g.original) onChange([g.current], "Move line end", `end:${g.id}`);
        return;
      case "create":
        finishCreate(g);
        return;
      case "marquee": {
        const box = boxFromCorners(g.start, g.current);
        if (box.width < MIN_DRAG * px && box.height < MIN_DRAG * px) return;
        const found = marqueeSelect(all, box);
        onSelect([...new Set([...g.base, ...found.flatMap(withGroup)])]);
      }
    }
  };

  // ---- drawing ---------------------------------------------------------------------------------------------------------------

  const cursor = (() => {
    if (gesture?.type === "move") return "grabbing";
    if (tool !== "select") return TOOL_CURSOR[tool] ?? "crosshair";
    return hover ? "move" : "default";
  })();

  const hovered = interactive && !gesture && hover && !selection.includes(hover) ? (all.find((o) => o.id === hover) ?? null) : null;
  const preview = gesture?.type === "create" ? previewObject(gesture, page, defaults, analysis) : null;
  const marquee = gesture?.type === "marquee" ? boxFromCorners(gesture.start, gesture.current) : null;
  const single = selected.length === 1 ? (selected[0] as EditorObject) : null;
  const multiBounds = selected.length > 1 ? selectionBounds(selected) : null;
  const guides = gesture?.type === "move" ? gesture.guides : [];

  const behind = shown.filter((object) => object.behind);

  return (
    <>
      {behind.length > 0 && (
        <svg className="ed-behind" viewBox={`0 0 ${page.width} ${page.height}`} width={page.width * zoom} height={page.height * zoom} aria-hidden="true" data-testid="behind-layer">
          {behind.map((object) => (
            <ObjectView key={object.id} object={object} imageUrl={imageUrl} />
          ))}
        </svg>
      )}
      <svg
        ref={svgRef}
        className="ed-overlay"
        viewBox={`0 0 ${page.width} ${page.height}`}
        width={page.width * zoom}
        height={page.height * zoom}
        role="group"
        aria-label={`Objects on the page`}
        data-testid="overlay"
        style={{ cursor, touchAction: tool === "select" && !gesture ? "pan-x pan-y pinch-zoom" : "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={() => {
          setGesture(null);
          onLiftDone();
        }}
        onPointerLeave={() => setHover(null)}
      >
        {ghosts.length > 0 && (
          <g style={{ pointerEvents: "none" }} data-testid="lifted">
            {ghosts.map((ghost) => {
              const now = shown.find((o) => o.id === ghost.id);
              return (
                <g key={ghost.id}>
                  <rect x={ghost.area.x} y={ghost.area.y} width={ghost.area.width} height={ghost.area.height} fill={ghost.patch} />
                  {now && now.kind === "existing" && (
                    <image
                      href={ghost.url}
                      x={ghost.area.x}
                      y={ghost.area.y}
                      width={ghost.area.width}
                      height={ghost.area.height}
                      preserveAspectRatio="none"
                      transform={ghostTransform(ghost.from, { x: now.x, y: now.y, width: now.width, height: now.height, rotation: now.rotation })}
                    />
                  )}
                </g>
              );
            })}
          </g>
        )}
        <g style={{ pointerEvents: "none" }}>
          {shown
            .filter((object) => !object.behind)
            .map((object) => (
              <ObjectView key={object.id} object={object} imageUrl={imageUrl} hideText={object.id === editingId} />
            ))}
          {preview && <ObjectView object={preview} imageUrl={imageUrl} />}
          {hovered && <HoverOutline object={hovered} px={px} />}
        </g>

        {children}

        {interactive && !gesture?.type?.startsWith("create") && <Chrome single={single} multiBounds={multiBounds} px={px} onResize={startResize} onRotate={startRotate} onEndpoint={startEndpoint} moving={gesture?.type === "move"} />}

        {guides.map((guide, i) => (
          <line
            key={i}
            className="ed-guide"
            x1={guide.axis === "x" ? guide.position : guide.from}
            y1={guide.axis === "x" ? guide.from : guide.position}
            x2={guide.axis === "x" ? guide.position : guide.to}
            y2={guide.axis === "x" ? guide.to : guide.position}
            strokeWidth={px}
          />
        ))}

        {marquee && <rect className="ed-marquee" x={marquee.x} y={marquee.y} width={marquee.width} height={marquee.height} strokeWidth={px} strokeDasharray={`${4 * px} ${3 * px}`} />}
      </svg>
    </>
  );
}

/** A thin outline around what the pointer is over, so it is clear what a click would pick. */
function HoverOutline({ object, px }: { object: EditorObject; px: number }) {
  if (object.kind === "existing") {
    if (object.what === "text" && object.lines) {
      return (
        <g data-testid="hover-outline" className="ed-hover">
          {object.lines.map((line) => (
            <rect key={line.id} x={line.box.x - 1} y={line.box.y - 1} width={line.box.width + 2} height={line.box.height + 2} strokeWidth={1.5 * px} />
          ))}
        </g>
      );
    }
    if (object.what === "shape" && object.outline && object.outline.length > 0) {
      return (
        <g data-testid="hover-outline" className="ed-hover">
          {object.outline.map((run, i) => {
            const d = run.points.map((p, k) => {
              const at = carryPoint(object, p);
              return `${k === 0 ? "M" : "L"} ${at.x} ${at.y}`;
            });
            return <path key={i} d={`${d.join(" ")}${run.closed ? " Z" : ""}`} strokeWidth={2 * px} strokeLinejoin="round" />;
          })}
        </g>
      );
    }
  }
  const frame = frameOf(object);
  const c = centreOf(frame);
  const rotation = isBoxObject(object) ? object.rotation : 0;
  return (
    <g data-testid="hover-outline" className="ed-hover" transform={rotation ? `rotate(${rotation} ${c.x} ${c.y})` : undefined}>
      <rect x={frame.x} y={frame.y} width={frame.width} height={frame.height} strokeWidth={1.5 * px} />
    </g>
  );
}

/** The shape being drawn by a creation gesture. */
function previewObject(g: Extract<Gesture, { type: "create" }>, page: PageEntry, defaults: ToolDefaults, analysis: PageAnalysis | null): EditorObject | null {
  const box = boxFromCorners(g.start, g.current);
  const id = "preview";
  const small = box.width < 1 && box.height < 1;
  switch (g.tool) {
    case "rect":
    case "ellipse":
      return small ? null : { ...makeShape(page.id, g.tool, box, defaults), id };
    case "cover":
      return small ? null : { ...makeCover(page.id, box, defaults), id };
    case "redact":
      return small ? null : { ...makeRedaction(page.id, box, defaults), id };
    case "line":
    case "arrow":
      return small ? null : { ...makeLine(page.id, g.start, g.shift ? constrainAngle(g.start, g.current) : g.current, g.tool === "arrow", defaults), id };
    case "draw":
      return g.points.length < 2 ? null : { ...makeDraw(page.id, g.points, defaults), id };
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly":
      return small ? null : { ...makeMarkup(page.id, g.tool, selectionQuads(g.start, g.current, analysis?.lines ?? []), defaults), id };
    case "text":
      return small ? null : { ...makeTextBox(page.id, g.start, defaults, { ...box, height: box.height }), id, border: { color: "#2563eb", width: 1, style: "dashed" } };
    default:
      return small ? null : { ...makeField(page.id, g.tool.replace("field-", "") as "text", box, "preview"), id };
  }
}

interface ChromeProps {
  single: EditorObject | null;
  multiBounds: Box | null;
  px: number;
  moving: boolean;
  onResize: (event: ReactPointerEvent, object: EditorObject, handle: Handle) => void;
  onRotate: (event: ReactPointerEvent, object: EditorObject) => void;
  onEndpoint: (event: ReactPointerEvent, object: Extract<EditorObject, { kind: "line" }>, which: 1 | 2) => void;
}

const CURSORS: Record<Handle, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };

/** The frame, handles and rotation knob of the selection. */
function Chrome({ single, multiBounds, px, moving, onResize, onRotate, onEndpoint }: ChromeProps) {
  if (multiBounds) {
    return (
      <rect
        className="ed-selection"
        data-testid="selection-multi"
        x={multiBounds.x}
        y={multiBounds.y}
        width={multiBounds.width}
        height={multiBounds.height}
        strokeWidth={1.25 * px}
        strokeDasharray={`${5 * px} ${3 * px}`}
        pointerEvents="none"
      />
    );
  }
  if (!single) return null;

  if (single.kind === "line") {
    return (
      <g data-testid="selection">
        {([1, 2] as const).map((which) => (
          <circle
            key={which}
            className="ed-handle"
            data-testid={`handle-p${which}`}
            cx={which === 1 ? single.x1 : single.x2}
            cy={which === 1 ? single.y1 : single.y2}
            r={6 * px}
            strokeWidth={2 * px}
            style={{ cursor: "grab", touchAction: "none" }}
            onPointerDown={(event) => onEndpoint(event, single, which)}
          />
        ))}
      </g>
    );
  }

  const frame = frameOf(single);
  const rotation = isBoxObject(single) ? single.rotation : 0;
  const c = centreOf(frame);
  const existing = single.kind === "existing" ? single : null;
  const resizable = existing ? existing.canResize && !existing.locked : isBoxObject(single) || single.kind === "draw";
  const handles: readonly Handle[] = single.kind === "image" || single.kind === "draw" || existing?.what === "image" ? CORNER_HANDLES : HANDLES;
  const canRotate = existing ? existing.canRotate && !existing.locked : ROTATABLE.has(single.kind);
  const knob = rotatePoint({ x: c.x, y: frame.y - 22 * px }, c, rotation);
  const top = handlePoint(frame, rotation, "n");

  return (
    <g data-testid="selection" transform={undefined}>
      <g transform={rotation ? `rotate(${rotation} ${c.x} ${c.y})` : undefined} pointerEvents="none">
        <rect className="ed-selection" x={frame.x} y={frame.y} width={frame.width} height={frame.height} strokeWidth={1.25 * px} strokeDasharray={`${5 * px} ${3 * px}`} />
      </g>
      {!moving &&
        resizable &&
        handles.map((handle) => {
          const at = handlePoint(frame, rotation, handle);
          return (
            <rect
              key={handle}
              className="ed-handle"
              data-testid={`handle-${handle}`}
              x={at.x - 5 * px}
              y={at.y - 5 * px}
              width={10 * px}
              height={10 * px}
              rx={2 * px}
              strokeWidth={2 * px}
              style={{ cursor: CURSORS[handle], touchAction: "none" }}
              onPointerDown={(event) => onResize(event, single, handle)}
            />
          );
        })}
      {!moving && canRotate && (
        <>
          <line className="ed-selection" x1={top.x} y1={top.y} x2={knob.x} y2={knob.y} strokeWidth={px} pointerEvents="none" />
          <circle className="ed-handle" data-testid="handle-rotate" cx={knob.x} cy={knob.y} r={6 * px} strokeWidth={2 * px} style={{ cursor: "grab", touchAction: "none" }} onPointerDown={(event) => onRotate(event, single)} />
        </>
      )}
    </g>
  );
}
