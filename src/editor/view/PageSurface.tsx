import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AnalyzedLine, PageAnalysis } from "../../lib/pdf/engine/analyze";
import { effectiveLines } from "../model/existing";
import { boundsOf, slotSize, stageTransform } from "../model/geometry";
import type { EditorObject, ExistingEdit, ExistingObject, Id, PageEntry, Pt, TextBoxObject, TextEditRecord, ToolId } from "../model/types";
import { layoutTextBox } from "../model/textLayout";
import { usePageData, useStore } from "../state/context";
import type { FindMatch } from "../state/store";
import { LineEditor, LineGhosts, LineHits } from "./LineLayer";
import { ObjectLayer } from "./ObjectLayer";
import { measureWithCanvas } from "./ObjectViews";
import { type Ghost, lift } from "./ghost";
import { PdfCanvas } from "./PdfCanvas";
import { SelectionBar } from "./SelectionBar";

interface PageSurfaceProps {
  page: PageEntry;
  /** 1-based position in the document. */
  number: number;
  zoom: number;
  active: boolean;
  tool: ToolId;
  objects: readonly EditorObject[];
  edits: Readonly<Record<string, TextEditRecord>>;
  /** The editor's changes to what the page already draws (the surface redraws when they change). */
  existingEdits: Readonly<Record<string, ExistingEdit>> | undefined;
  selection: readonly Id[];
  /** The existing line being edited on this page. */
  lineId: string | null;
  /** The line is open for typing (otherwise it is only selected). */
  lineEditing: boolean;
  editing: { id: Id; isNew: boolean } | null;
  snap: boolean;
  /** Matches of the current search on this page, and which one is the current one. */
  matches: readonly FindMatch[];
  currentMatch: FindMatch | null;
}

const EMPTY_EDITS: Readonly<Record<string, TextEditRecord>> = {};
const STICKY_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(["draw", "highlight", "underline", "strikeout", "squiggly"]);

/**
 * One page of the editor: the page as pdf.js draws it, the objects on it, the lines of text that can be edited, and
 * whichever editor is open. It lives in a slot sized for the editor's rotation and zoom.
 */
export const PageSurface = memo(function PageSurface({ page, number, zoom, active, tool, objects, edits, existingEdits, selection, lineId, lineEditing, editing, snap, matches, currentMatch }: PageSurfaceProps) {
  const store = useStore();
  const data = usePageData(page.id);
  const existing = store.existingOn(page.id);
  const svg = useRef<SVGSVGElement>(null);
  const [caret, setCaret] = useState(0);
  const render = store.renderSource(page);
  const canvas = useRef<HTMLCanvasElement>(null);

  // ---- lifting what the page already draws while its change is made in the file --------------------------------------------
  // The canvas shows the page as the file had it at the last redraw. While a change is on its way, the object is lifted
  // off (its pixels copied, its old place painted over) and shown at its new place.
  const [drawnKey, setDrawnKey] = useState<string | null>(null);
  const [ghosts, setGhosts] = useState<readonly Ghost[]>([]);
  const expectedKey = render?.pdf.key ?? null;
  const settled = !data.deriving && (expectedKey === null || drawnKey === expectedKey);
  const settledBefore = useRef(settled);
  const ghostsRef = useRef(ghosts);
  ghostsRef.current = ghosts;
  const holding = useRef(false);
  useEffect(() => {
    settledBefore.current = settled;
    // The redraw has caught up: the lifted copies are not needed any more.
    if (settled && !holding.current && ghosts.length > 0) setGhosts([]);
  }, [settled, ghosts.length]);

  const liftObjects = useCallback(
    (objects: readonly ExistingObject[]) => {
      holding.current = true;
      if (!settledBefore.current) return;
      const fresh: Ghost[] = [];
      for (const object of objects) {
        if (ghostsRef.current.some((g) => g.id === object.id)) continue;
        const copy = lift(canvas.current, page, object.id, { x: object.x, y: object.y, width: object.width, height: object.height, rotation: object.rotation }, boundsOf(object));
        if (copy) fresh.push(copy);
      }
      if (fresh.length > 0) setGhosts((previous) => [...previous, ...fresh]);
    },
    [page],
  );
  const liftDone = useCallback(() => {
    holding.current = false;
    // Nothing was changed after all: nothing to wait for.
    if (!store.getPageData(page.id).deriving) setGhosts([]);
  }, [store, page.id]);

  // Changes that do not come from the pointer (arrow keys, the panel, undo) lift what they change, too.
  const previous = useRef<readonly ExistingObject[]>(existing);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = existing;
    if (before === existing || !settledBefore.current) return;
    const now = new Map(existing.map((o) => [o.id, o]));
    const changed = before.filter((old) => {
      const next = now.get(old.id);
      return !next || next.x !== old.x || next.y !== old.y || next.width !== old.width || next.height !== old.height || next.rotation !== old.rotation;
    });
    if (changed.length > 0) liftObjects(changed);
    holding.current = false;
  }, [existing, liftObjects]);

  // Read the page's text as soon as it is near the screen (it is also needed for text selection and highlighting).
  const needsAnalysis = active && page.source !== null && data.analysis === null && data.analysisError === null;
  useEffect(() => {
    if (needsAnalysis) void store.analyze(page);
  }, [needsAnalysis, store, page]);

  const crop = page.crop ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const cw = Math.max(1, page.width - crop.left - crop.right);
  const ch = Math.max(1, page.height - crop.top - crop.bottom);
  const slot = slotSize(cw, ch, zoom, page.rotation);

  // The lines of text as they are now: a block that was moved is where it was moved to, one that was removed is gone.
  const rawAnalysis = data.analysis;
  const analysis = useMemo<PageAnalysis | null>(() => (rawAnalysis ? { ...rawAnalysis, lines: effectiveLines(rawAnalysis, existingEdits) } : null), [rawAnalysis, existingEdits]);
  const line: AnalyzedLine | null = lineId && analysis ? (analysis.lines.find((l) => l.id === lineId) ?? null) : null;
  const pendingEdits = Object.keys(edits).length > 0 && (data.deriving || data.derived === null);
  const editingBox = editing ? (objects.find((o) => o.id === editing.id && o.kind === "text") as TextBoxObject | undefined) : undefined;

  const commitLine = (target: AnalyzedLine, text: string) => {
    const existing = edits[target.id];
    const unchanged = text === target.text && !existing;
    // The typing box closes; the line stays selected so its look can be changed from the panel.
    store.stopLineEditing();
    if (unchanged) return;
    if (text === target.text && existing) {
      store.resetTextEdit(page.id, target.id);
      return;
    }
    store.editText(page.id, { lineId: target.id, text, style: { align: target.align } });
  };

  const imageUrl = store.imageUrl;
  const pageSelection = useMemo(() => selection, [selection]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const selectedHere = useMemo(() => store.objects(selection), [selection, objects, existing, store]);

  /** Double-click on text the page already has: edit the line that was clicked. */
  const editExistingText = (object: ExistingObject, at: Pt) => {
    const hit = (object.lines ?? []).find((l) => at.x >= l.box.x - 2 && at.x <= l.box.x + l.box.width + 2 && at.y >= l.box.y - 2 && at.y <= l.box.y + l.box.height + 2) ?? object.lines?.[0];
    const target = hit ? analysis?.lines.find((l) => l.id === hit.id) : undefined;
    if (!target) return;
    if (target.verdict === "A") {
      setCaret(target.text.length);
      store.selectLine({ page: page.id, lineId: target.id });
    } else store.notify(target.reason ?? "This text cannot be edited.", "warning");
  };

  return (
    <section className="ed-page" data-testid={`page-${number}`} data-page-id={page.id} aria-label={`Page ${number}`}>
      <div className="ed-slot" style={{ width: slot.width, height: slot.height }}>
        <div className="ed-crop" style={{ width: cw * zoom, height: ch * zoom, transform: stageTransform(cw, ch, zoom, page.rotation) }}>
          <div className="ed-stage" data-testid={`stage-${number}`} style={{ width: page.width * zoom, height: page.height * zoom, transform: `translate(${-crop.left * zoom}px, ${-crop.top * zoom}px)` }}>
            <PdfCanvas source={render?.pdf ?? null} pageNumber={render?.pageNumber ?? 1} width={page.width} height={page.height} zoom={zoom} active={active} label={`Page ${number}`} canvasRef={canvas} onDrawn={setDrawnKey} />
            <ObjectLayer
              page={page}
              objects={objects}
              existing={existing}
              ghosts={ghosts}
              onLift={liftObjects}
              onLiftDone={liftDone}
              tool={tool}
              selection={pageSelection}
              zoom={zoom}
              analysis={analysis}
              defaults={store.state.view.defaults}
              snap={snap}
              imageUrl={imageUrl}
              editingId={editing?.id ?? null}
              svgRef={svg}
              onSelect={(ids) => store.select(ids)}
              onCreate={(created, options) => {
                const first = created[0];
                store.addObjects(`Add ${first?.kind === "text" ? "text box" : (first?.kind ?? "object")}`, created);
                // Pens and markup tools stay active for the next stroke; everything else goes back to Select.
                if (!STICKY_TOOLS.has(tool)) store.setTool("select");
                if (options?.edit && first) store.startEditing(first.id, true);
              }}
              onChange={(changed, label, key) => store.replaceObjects(label, changed, key)}
              onEdit={(id) => store.startEditing(id, false)}
              onEditExisting={editExistingText}
              onBackgroundDoubleClick={(at) => {
                if (!analysis) return;
                const hit = analysis.lines.find((l) => at.x >= l.box.x - 2 && at.x <= l.box.x + l.box.width + 2 && at.y >= l.box.y - 2 && at.y <= l.box.y + l.box.height + 2);
                if (!hit) return;
                if (hit.verdict === "A") {
                  setCaret(hit.text.length);
                  store.selectLine({ page: page.id, lineId: hit.id });
                } else store.notify(hit.reason ?? "This text cannot be edited.", "warning");
              }}
            >
              {matches.length > 0 && (
                <g data-testid="find-hits">
                  {matches.map((match, i) => (
                    <polygon key={i} className={`ed-find-hit${match === currentMatch ? " ed-find-hit--current" : ""}`} data-find-current={match === currentMatch ? "true" : undefined} points={match.quad.map((p) => p.join(",")).join(" ")} strokeWidth={1 / zoom} />
                  ))}
                </g>
              )}
              {analysis && (
                <LineHits
                  analysis={analysis}
                  edits={edits}
                  active={tool === "edit-text"}
                  selectedId={lineId}
                  zoom={zoom}
                  onPick={(picked, at) => {
                    setCaret(at);
                    store.selectLine({ page: page.id, lineId: picked.id });
                  }}
                  onRefuse={(refused) => store.notify(`${refused.reason ?? "This text cannot be edited."}`, "warning")}
                />
              )}
            </ObjectLayer>
            {analysis && <LineGhosts analysis={analysis} edits={edits} zoom={zoom} pending={pendingEdits} skip={lineEditing ? lineId : null} />}
            {analysis && line && lineEditing && (
              <LineEditor
                key={line.id}
                line={line}
                text={edits[line.id]?.text ?? line.text}
                zoom={zoom}
                caret={caret}
                onCommit={(text) => commitLine(line, text)}
                onCancel={() => store.selectLine(null)}
              />
            )}
            {editingBox && <TextBoxEditor key={editingBox.id} object={editingBox} zoom={zoom} isNew={editing?.isNew ?? false} />}
          </div>
        </div>
      </div>
      {tool === "select" && !editing && !lineId && selectedHere.length > 0 && <SelectionBar page={page} zoom={zoom} selected={selectedHere} />}
      <span className="ed-page__number" aria-hidden="true">
        {number}
      </span>
    </section>
  );
}, equalProps);

function equalProps(a: PageSurfaceProps, b: PageSurfaceProps): boolean {
  const sameSelection = a.selection.length === b.selection.length && a.selection.every((id, i) => id === b.selection[i]);
  return (
    a.page === b.page &&
    a.number === b.number &&
    a.zoom === b.zoom &&
    a.active === b.active &&
    a.tool === b.tool &&
    a.objects === b.objects &&
    a.edits === b.edits &&
    a.existingEdits === b.existingEdits &&
    sameSelection &&
    a.lineId === b.lineId &&
    a.lineEditing === b.lineEditing &&
    a.editing?.id === b.editing?.id &&
    a.snap === b.snap &&
    a.matches === b.matches &&
    a.currentMatch === b.currentMatch
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- shared helper kept next to the code that uses it
export { EMPTY_EDITS };

// ---------------------------------------------------------------------------------------------------------------

interface TextBoxEditorProps {
  object: TextBoxObject;
  zoom: number;
  isNew: boolean;
}

/** Typing into a text box, set in the box's own font, size and colour at its own place on the page. */
function TextBoxEditor({ object, zoom, isNew }: TextBoxEditorProps) {
  const store = useStore();
  const [value, setValue] = useState(object.text);
  const area = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const layout = useMemo(() => layoutTextBox({ ...object, text: value === "" ? " " : value }, measureWithCanvas), [object, value]);

  useEffect(() => {
    const element = area.current;
    element?.focus({ preventScroll: true });
    element?.setSelectionRange(element.value.length, element.value.length);
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    store.stopEditing();
    if (!commit) {
      if (isNew) store.removeObjects([object.id], "Cancel text box");
      return;
    }
    if (value.trim() === "") {
      if (isNew) store.removeObjects([object.id], "Remove empty text box");
      else if (object.text !== "") store.updateObjects("Edit text", [{ id: object.id, patch: { text: "" } }]);
      return;
    }
    const height = object.autoHeight ? Math.max(layout.contentHeight, object.size + object.padding * 2) : object.height;
    store.updateObjects("Edit text", [{ id: object.id, patch: { text: value, height } }], `text:${object.id}`);
  };

  const width = object.width * zoom;
  const height = Math.max(object.height, layout.contentHeight) * zoom;
  const family = { sans: 'Helvetica, Arial, "Liberation Sans", sans-serif', serif: '"Times New Roman", Times, "Liberation Serif", serif', mono: '"Courier New", Courier, "Liberation Mono", monospace' }[object.family];
  return (
    <div className="ed-boxeditor" style={{ left: object.x * zoom, top: object.y * zoom, width, height, transform: object.rotation ? `rotate(${object.rotation}deg)` : undefined }}>
      <textarea
        ref={area}
        className="ed-boxeditor__area"
        data-testid="text-editor"
        aria-label="Text of the text box. Press Escape to cancel, or click elsewhere to finish."
        value={value}
        placeholder="Type here"
        spellCheck
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish(false);
          } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            finish(true);
          }
          event.stopPropagation();
        }}
        style={{
          width,
          height,
          padding: object.padding * zoom,
          fontFamily: family,
          fontSize: object.size * zoom,
          fontWeight: object.bold ? 700 : 400,
          fontStyle: object.italic ? "italic" : "normal",
          textDecoration: object.underline ? "underline" : "none",
          textAlign: object.align,
          lineHeight: object.lineHeight,
          letterSpacing: object.letterSpacing * zoom,
          color: object.color,
          background: object.fill ?? "rgba(255,255,255,0.92)",
        }}
      />
    </div>
  );
}
