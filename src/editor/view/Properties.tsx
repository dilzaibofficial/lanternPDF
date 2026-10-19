import { useRef } from "react";
import { Icon } from "../../components/ui/Icon";
import { LIMITS } from "../../config/limits";
import { checkFiles, contentProblem } from "../../lib/files";
import type { AnalyzedLine } from "../../lib/pdf/engine/analyze";
import type { LineStyle } from "../../lib/pdf/engine/textEdit";
import { frameOf, isBoxObject } from "../model/geometry";
import { applyBox } from "../model/transform";
import type { EditorObject, ExistingObject, FormFieldObject, Id, ImageObject, TextBoxObject } from "../model/types";
import { usePageData, useSnapshot, useStore } from "../state/context";
import { Action, AlignSection, GroupSection, LayerSection, MergeSection, OrderSection, PictureSection, removable } from "./Arrange";
import { outcomeFor } from "./LineLayer";
import { measureWithCanvas } from "./ObjectViews";
import { ColorField, Choice, NumberField, Section, SliderField, Toggle } from "./controls";

const LABELS: Record<EditorObject["kind"], string> = {
  existing: "Part of the page",
  text: "Text box",
  image: "Image",
  rect: "Rectangle",
  ellipse: "Ellipse",
  line: "Line",
  draw: "Drawing",
  highlight: "Highlight",
  underline: "Underline",
  strikeout: "Strikeout",
  squiggly: "Squiggly underline",
  comment: "Note",
  cover: "Cover box",
  redact: "Redaction",
  field: "Form field",
};

/** The right-hand panel: whatever is selected, or the settings of the tool in use. */
export function Properties() {
  const store = useStore();
  const { view } = useSnapshot();
  const selected = store.objects(view.selection);
  let body: React.ReactNode;
  if (view.line) body = <LinePanel pageId={view.line.page} lineId={view.line.lineId} />;
  else if (selected.length === 1) body = <ObjectPanel object={selected[0] as EditorObject} />;
  else if (selected.length > 1) body = <MultiPanel objects={selected} />;
  else body = <NothingSelected />;
  return (
    <aside className="ed-panel" aria-label="Properties" data-testid="properties">
      {body}
    </aside>
  );
}

// ---- nothing selected -------------------------------------------------------------------------------------------------

function NothingSelected() {
  const store = useStore();
  const { doc, view } = useSnapshot();
  const d = view.defaults;
  const page = doc.pages.find((p) => p.id === view.currentPage);
  const set = store.setDefaults.bind(store);

  switch (view.tool) {
    case "text":
      return (
        <>
          <Header title="New text boxes" />
          <Section title="Font">
            <Choice label="Font family" value={d.text.family} options={[{ value: "sans", label: "Sans" }, { value: "serif", label: "Serif" }, { value: "mono", label: "Mono" }]} onChange={(family) => set({ text: { ...d.text, family } })} />
            <NumberField label="Size" value={d.text.size} min={4} max={200} suffix="pt" onCommit={(size) => set({ text: { ...d.text, size } })} />
            <ColorField label="Colour" value={d.text.color} onChange={(color) => set({ text: { ...d.text, color: color ?? "#000000" } })} />
          </Section>
        </>
      );
    case "rect":
    case "ellipse":
      return (
        <>
          <Header title="New shapes" />
          <Section title="Look">
            <ColorField label="Outline" value={d.shape.stroke} nullable onChange={(stroke) => set({ shape: { ...d.shape, stroke } })} />
            <ColorField label="Fill" value={d.shape.fill} nullable onChange={(fill) => set({ shape: { ...d.shape, fill } })} />
            <NumberField label="Outline width" value={d.shape.strokeWidth} min={0} max={40} step={0.5} suffix="pt" onCommit={(strokeWidth) => set({ shape: { ...d.shape, strokeWidth } })} />
          </Section>
        </>
      );
    case "line":
    case "arrow":
      return (
        <>
          <Header title="New lines" />
          <Section title="Look">
            <ColorField label="Colour" value={d.line.color} onChange={(color) => set({ line: { ...d.line, color: color ?? "#000000" } })} />
            <NumberField label="Thickness" value={d.line.strokeWidth} min={0.25} max={40} step={0.5} suffix="pt" onCommit={(strokeWidth) => set({ line: { ...d.line, strokeWidth } })} />
          </Section>
        </>
      );
    case "draw":
      return (
        <>
          <Header title="Pen" />
          <Section title="Look">
            <ColorField label="Colour" value={d.draw.color} onChange={(color) => set({ draw: { ...d.draw, color: color ?? "#000000" } })} />
            <NumberField label="Thickness" value={d.draw.strokeWidth} min={0.25} max={40} step={0.5} suffix="pt" onCommit={(strokeWidth) => set({ draw: { ...d.draw, strokeWidth } })} />
          </Section>
        </>
      );
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly": {
      const key = view.tool === "squiggly" ? "strikeout" : view.tool;
      const current = d[key];
      return (
        <>
          <Header title={`New ${view.tool === "squiggly" ? "squiggly underlines" : `${view.tool}s`}`} hint="Drag across text to mark it." />
          <Section title="Look">
            <ColorField label="Colour" value={current.color} onChange={(color) => set({ [key]: { ...current, color: color ?? "#fde047" } })} />
            <SliderField label="Strength" value={current.opacity} min={0.1} max={1} step={0.05} onChange={(opacity) => set({ [key]: { ...current, opacity } })} />
          </Section>
        </>
      );
    }
    case "cover":
      return (
        <>
          <Header title="Cover box" />
          <p className="ed-note">A cover box hides what is behind it from view. <strong>The hidden content stays in the file.</strong> To remove text or images for good, use Redact.</p>
          <ColorField label="Colour" value={d.cover.color} onChange={(color) => set({ cover: { color: color ?? "#ffffff" } })} />
        </>
      );
    case "redact":
      return (
        <>
          <Header title="Redaction" />
          <p className="ed-note">When you download, the text, image pixels and notes under each redaction box are <strong>removed from the file</strong>, and the file is checked afterwards.</p>
          <ColorField label="Box colour" value={d.redact.color} onChange={(color) => set({ redact: { ...d.redact, color: color ?? "#000000" } })} />
        </>
      );
    case "edit-text":
      return (
        <>
          <Header title="Edit text" hint="Click any text on the page to change it." />
          <p className="ed-note">The text is rewritten inside the page, not covered with a box. If a letter is not available in the document’s font, a similar font is used for that letter and you are told.</p>
        </>
      );
    default:
      break;
  }

  return (
    <>
      <Header title="Document" />
      <Section title="This document">
        <dl className="ed-facts">
          <dt>Name</dt>
          <dd data-testid="doc-name">{store.state.name}</dd>
          <dt>Pages</dt>
          <dd>{doc.pages.length}</dd>
          {page && (
            <>
              <dt>Current page size</dt>
              <dd>
                {Math.round(page.width)} × {Math.round(page.height)} pt
              </dd>
            </>
          )}
        </dl>
        {Object.values(doc.sources).some((s) => s.signed) && (
          <p className="ed-note ed-note--warning" role="note">
            <Icon name="alert" size={16} /> This document is digitally signed. Downloading a changed copy makes the signature invalid.
          </p>
        )}
      </Section>
      <Section title="Getting started">
        <ul className="ed-tips">
          <li>
            <strong>Move or delete anything:</strong> click text, a picture or a shape on the page to select it, then drag it or press Delete.
          </li>
          <li>
            <strong>Change text:</strong> double-click a line of text, or choose <em>Edit text</em> (E) and click it.
          </li>
          <li>
            <strong>Add things:</strong> text, images, shapes, highlights and notes from the bar above the page.
          </li>
          <li>
            <strong>Pages:</strong> reorder, rotate, duplicate or delete in the panel on the left.
          </li>
          <li>
            <strong>Nothing is saved to your file</strong> until you choose <em>Download as…</em>; your original is never changed.
          </li>
        </ul>
      </Section>
    </>
  );
}

function Header({ title, hint }: { title: string; hint?: string }) {
  return (
    <header className="ed-panel__head">
      <h2>{title}</h2>
      {hint && <p>{hint}</p>}
    </header>
  );
}

// ---- an existing line of text ---------------------------------------------------------------------------------------------

function LinePanel({ pageId, lineId }: { pageId: Id; lineId: string }) {
  const store = useStore();
  const { doc } = useSnapshot();
  const data = usePageData(pageId);
  const line: AnalyzedLine | undefined = data.analysis?.lines.find((l) => l.id === lineId);
  const record = doc.textEdits[pageId]?.[lineId];
  if (!line) return <Header title="Text" hint="Reading the page…" />;
  const outcome = outcomeFor(data.derived?.report, lineId);
  const style: LineStyle = record?.style ?? {};
  const text = record?.text ?? line.text;

  const update = (patch: Partial<LineStyle>, fit?: "none" | "condense" | "shrink") => {
    store.editText(pageId, { lineId, text, style: { align: line.align, ...style, ...patch }, fit: fit ?? record?.fit });
  };

  return (
    <>
      <Header title="Text" hint={line.verdict === "A" ? "This text is edited inside the page." : (line.reason ?? "This text cannot be edited.")} />
      <Section title="This line">
        <dl className="ed-facts">
          <dt>Font</dt>
          <dd>
            {line.fontName || "unknown"}
            {line.mixedFonts ? " (and others)" : ""}
          </dd>
          <dt>Size</dt>
          <dd>{Math.round(line.size * 10) / 10} pt</dd>
          {line.repeats && (
            <>
              <dt>Shared</dt>
              <dd>part of a block drawn {line.repeats} times</dd>
            </>
          )}
        </dl>
        {record && (
          <p className="ed-note" data-testid="line-outcome">
            {data.deriving && <span>Applying…</span>}
            {!data.deriving && outcome?.status === "applied" && (
              <>
                <strong>{outcome.mode === "A" ? "Edited in place" : `Redrawn partly in ${outcome.fallbackFont ?? "another font"}`}</strong>
                {outcome.verified ? " · checked after saving into the page" : ""}
              </>
            )}
            {!data.deriving && outcome?.status === "refused" && <strong>Not applied: {outcome.reason}</strong>}
            {!data.deriving && !outcome && !data.deriveError && <span>Edited.</span>}
            {data.deriveError && <strong>{data.deriveError.message}</strong>}
          </p>
        )}
        {outcome?.notes.map((note) => (
          <p key={note} className="ed-note">
            {note}
          </p>
        ))}
        {outcome?.warnings.map((warning) => (
          <p key={warning} className="ed-note ed-note--warning" role="alert">
            <Icon name="alert" size={16} /> {warning}
          </p>
        ))}
      </Section>
      {line.verdict === "A" && (
        <>
          <Section title="Look" hint="Changing the typeface rebuilds this line in a built-in font.">
            <div className="ed-row-tools">
              <Toggle label="Bold" icon="type" pressed={style.bold ?? line.bold} onChange={(bold) => update({ bold, family: style.family ?? line.family === "symbol" ? "sans" : line.family })} testId="line-bold" />
              <Toggle label="Italic" icon="pencil" pressed={style.italic ?? line.italic} onChange={(italic) => update({ italic, family: style.family ?? line.family === "symbol" ? "sans" : line.family })} testId="line-italic" />
            </div>
            <Choice label="Typeface" value={(style.family ?? (line.family === "symbol" ? "sans" : line.family)) as "sans" | "serif" | "mono"} options={[{ value: "sans", label: "Sans" }, { value: "serif", label: "Serif" }, { value: "mono", label: "Mono" }]} onChange={(family) => update({ family })} />
            <NumberField label="Size" value={style.size ?? line.size} min={4} max={200} suffix="pt" digits={1} testId="line-size" onCommit={(size) => update({ size })} />
          </Section>
          <Section title="Position" hint="Which part of the line stays put when the text gets longer or shorter.">
            <Choice label="Keep fixed" value={style.align ?? line.align} options={[{ value: "left", label: "Left edge" }, { value: "center", label: "Centre" }, { value: "right", label: "Right edge" }]} onChange={(align) => update({ align })} />
            <Choice label="Longer than before" value={record?.fit ?? "none"} options={[{ value: "none", label: "Let it grow", title: "The line gets wider; you are warned if it runs into something" }, { value: "condense", label: "Squeeze" }, { value: "shrink", label: "Shrink" }]} onChange={(fit) => update({}, fit)} />
          </Section>
        </>
      )}
      <div className="ed-panel__actions">
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => store.selectLine(null)}>
          Done
        </button>
        {record && (
          <button type="button" className="btn btn--ghost btn--sm" data-testid="line-reset" onClick={() => store.resetTextEdit(pageId, lineId)}>
            Restore the original text
          </button>
        )}
      </div>
    </>
  );
}

// ---- one object --------------------------------------------------------------------------------------------------------------

function ObjectPanel({ object }: { object: EditorObject }) {
  const store = useStore();
  if (object.kind === "existing") return <ExistingPanel object={object} />;
  const patch = (changes: Record<string, unknown>, label = `Change ${LABELS[object.kind].toLowerCase()}`, key?: string) => store.updateObjects(label, [{ id: object.id, patch: changes }], key ?? `prop:${object.id}:${Object.keys(changes).join(",")}`);

  return (
    <>
      <Header title={LABELS[object.kind]} />
      <GeometrySection object={object} />
      {object.kind === "text" && <TextBoxSection object={object} patch={patch} />}
      {object.kind === "image" && <ImageSection object={object} patch={patch} />}
      {(object.kind === "rect" || object.kind === "ellipse") && (
        <Section title="Look">
          <ColorField label="Outline" value={object.stroke} nullable onChange={(stroke) => patch({ stroke })} testId="prop-stroke" />
          <ColorField label="Fill" value={object.fill} nullable onChange={(fill) => patch({ fill })} testId="prop-fill" />
          <NumberField label="Outline width" value={object.strokeWidth} min={0} max={60} step={0.5} suffix="pt" onCommit={(strokeWidth) => patch({ strokeWidth })} />
          <Choice label="Outline style" value={object.strokeStyle} options={[{ value: "solid", label: "Solid" }, { value: "dashed", label: "Dashed" }]} onChange={(strokeStyle) => patch({ strokeStyle })} />
          {object.kind === "rect" && <NumberField label="Corner radius" value={object.radius} min={0} max={Math.min(object.width, object.height) / 2} suffix="pt" onCommit={(radius) => patch({ radius })} />}
        </Section>
      )}
      {object.kind === "line" && (
        <Section title="Look">
          <ColorField label="Colour" value={object.color} onChange={(color) => patch({ color: color ?? "#000000" })} />
          <NumberField label="Thickness" value={object.strokeWidth} min={0.25} max={60} step={0.5} suffix="pt" onCommit={(strokeWidth) => patch({ strokeWidth })} />
          <Choice label="Style" value={object.strokeStyle} options={[{ value: "solid", label: "Solid" }, { value: "dashed", label: "Dashed" }]} onChange={(strokeStyle) => patch({ strokeStyle })} />
          <Choice label="Arrowheads" value={object.arrow} options={[{ value: "none", label: "None" }, { value: "end", label: "End" }, { value: "both", label: "Both" }]} onChange={(arrow) => patch({ arrow })} />
        </Section>
      )}
      {object.kind === "draw" && (
        <Section title="Look">
          <ColorField label="Colour" value={object.color} onChange={(color) => patch({ color: color ?? "#000000" })} />
          <NumberField label="Thickness" value={object.strokeWidth} min={0.25} max={60} step={0.5} suffix="pt" onCommit={(strokeWidth) => patch({ strokeWidth })} />
        </Section>
      )}
      {(object.kind === "highlight" || object.kind === "underline" || object.kind === "strikeout" || object.kind === "squiggly") && (
        <Section title="Look" hint="Saved as a real markup annotation, so other PDF readers show it as one too.">
          <ColorField label="Colour" value={object.color} onChange={(color) => patch({ color: color ?? "#fde047" })} />
        </Section>
      )}
      {object.kind === "comment" && (
        <Section title="Note" hint="Saved as a real note annotation.">
          <div className="ed-field">
            <label htmlFor="note-text">Text</label>
            <textarea id="note-text" className="textarea" rows={4} defaultValue={object.text} data-testid="note-text" onKeyDown={(e) => e.stopPropagation()} onBlur={(event) => patch({ text: event.target.value }, "Edit note")} />
          </div>
          <div className="ed-field">
            <label htmlFor="note-author">Author</label>
            <input id="note-author" className="input" defaultValue={object.author} onKeyDown={(e) => e.stopPropagation()} onBlur={(event) => patch({ author: event.target.value }, "Change note author")} />
          </div>
        </Section>
      )}
      {object.kind === "cover" && (
        <Section title="Cover box" hint="Hides what is behind it from view. The content stays in the file: use Redact to remove it.">
          <ColorField label="Colour" value={object.color} onChange={(color) => patch({ color: color ?? "#ffffff" })} />
        </Section>
      )}
      {object.kind === "redact" && (
        <Section title="Redaction" hint="On download, the text, image pixels and notes under this box are removed from the file, and the result is checked.">
          <ColorField label="Box colour" value={object.color} onChange={(color) => patch({ color: color ?? "#000000" })} />
          <div className="ed-field">
            <label htmlFor="redact-label">Label in the box</label>
            <input id="redact-label" className="input" defaultValue={object.label} placeholder="For example REDACTED" onKeyDown={(e) => e.stopPropagation()} onBlur={(event) => patch({ label: event.target.value }, "Change redaction label")} />
          </div>
        </Section>
      )}
      {object.kind === "field" && <FieldSection object={object} patch={patch} />}
      {"opacity" in object && object.kind !== "field" && object.kind !== "redact" && (
        <Section title="Transparency">
          <SliderField label="Opacity" value={object.opacity} min={0.05} max={1} step={0.01} testId="prop-opacity" onChange={(opacity) => patch({ opacity }, "Change opacity", `opacity:${object.id}`)} />
        </Section>
      )}
      <AlignSection objects={[object]} />
      <OrderSection objects={[object]} />
      <LayerSection objects={[object]} />
      <PictureSection object={object} />
      <MergeSection objects={[object]} />
      <ManageSection objects={[object]} />
    </>
  );
}

function GeometrySection({ object }: { object: EditorObject }) {
  const store = useStore();
  const { doc } = useSnapshot();
  const page = doc.pages.find((p) => p.id === object.page);
  const existing = object.kind === "existing" ? object : null;
  const move = (box: { x?: number; y?: number; width?: number; height?: number }) => {
    const frame = frameOf(object);
    const next = applyBox(object, { x: box.x ?? frame.x, y: box.y ?? frame.y, width: box.width ?? frame.width, height: box.height ?? frame.height }, measureWithCanvas);
    store.replaceObjects("Change position or size", [next], `geo:${object.id}`);
  };
  if (object.kind === "line") {
    const set = (patch: Partial<typeof object>) => store.replaceObjects("Move line", [{ ...object, ...patch }], `geo:${object.id}`);
    return (
      <Section title="Position">
        <div className="ed-grid2">
          <NumberField label="X1" value={object.x1} suffix="pt" testId="geo-x1" onCommit={(x1) => set({ x1 })} />
          <NumberField label="Y1" value={object.y1} suffix="pt" testId="geo-y1" onCommit={(y1) => set({ y1 })} />
          <NumberField label="X2" value={object.x2} suffix="pt" testId="geo-x2" onCommit={(x2) => set({ x2 })} />
          <NumberField label="Y2" value={object.y2} suffix="pt" testId="geo-y2" onCommit={(y2) => set({ y2 })} />
        </div>
      </Section>
    );
  }
  const frame = frameOf(object);
  const resizable = existing ? existing.canResize && !existing.locked : isBoxObject(object) || object.kind === "draw";
  const rotatable = existing ? existing.canRotate && !existing.locked : isBoxObject(object) && object.kind !== "field" && object.kind !== "redact";
  const frozen = existing?.locked ?? false;
  return (
    <Section title="Position and size" hint={`In points, from the top-left corner of the page (${Math.round(page?.width ?? 0)} × ${Math.round(page?.height ?? 0)}).`}>
      <div className="ed-grid2">
        <NumberField label="X" value={frame.x} suffix="pt" testId="geo-x" disabled={frozen} onCommit={(x) => move({ x })} />
        <NumberField label="Y" value={frame.y} suffix="pt" testId="geo-y" disabled={frozen} onCommit={(y) => move({ y })} />
        {resizable && <NumberField label="Width" value={frame.width} min={1} suffix="pt" testId="geo-w" onCommit={(width) => move({ width })} />}
        {resizable && <NumberField label="Height" value={frame.height} min={1} suffix="pt" testId="geo-h" onCommit={(height) => move({ height })} />}
        {rotatable && <NumberField label="Rotation" value={(object as { rotation: number }).rotation} min={0} max={360} suffix="°" testId="geo-rot" onCommit={(rotation) => store.replaceObjects("Rotate", [{ ...object, rotation: ((rotation % 360) + 360) % 360 } as EditorObject], `rot:${object.id}`)} />}
      </div>
    </Section>
  );
}

function TextBoxSection({ object, patch }: { object: TextBoxObject; patch: (changes: Record<string, unknown>, label?: string, key?: string) => void }) {
  const store = useStore();
  return (
    <>
      <Section title="Text">
        <div className="ed-field">
          <label htmlFor="box-text">Content</label>
          <textarea id="box-text" className="textarea" rows={4} defaultValue={object.text} key={object.id + object.text} data-testid="box-text" onKeyDown={(event) => event.stopPropagation()} onBlur={(event) => event.target.value !== object.text && patch({ text: event.target.value }, "Edit text")} />
        </div>
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => store.startEditing(object.id)}>
          Edit on the page
        </button>
      </Section>
      <Section title="Font">
        <Choice label="Font family" value={object.family} options={[{ value: "sans", label: "Sans" }, { value: "serif", label: "Serif" }, { value: "mono", label: "Mono" }]} onChange={(family) => patch({ family })} testId="prop-family" />
        <NumberField label="Size" value={object.size} min={4} max={400} suffix="pt" testId="prop-size" onCommit={(size) => patch({ size })} />
        <div className="ed-row-tools">
          <Toggle label="Bold" icon="type" pressed={object.bold} onChange={(bold) => patch({ bold })} testId="prop-bold" />
          <Toggle label="Italic" icon="pencil" pressed={object.italic} onChange={(italic) => patch({ italic })} testId="prop-italic" />
          <Toggle label="Underline" icon="underline" pressed={object.underline} onChange={(underline) => patch({ underline })} testId="prop-underline" />
        </div>
        <Choice label="Alignment" value={object.align} options={[{ value: "left", label: <Icon name="align-left" size={16} />, title: "Left" }, { value: "center", label: <Icon name="align-center" size={16} />, title: "Centre" }, { value: "right", label: <Icon name="align-right" size={16} />, title: "Right" }]} onChange={(align) => patch({ align })} testId="prop-align" />
        <ColorField label="Colour" value={object.color} onChange={(color) => patch({ color: color ?? "#000000" })} testId="prop-color" />
        <NumberField label="Line height" value={object.lineHeight} min={0.5} max={4} step={0.05} digits={2} onCommit={(lineHeight) => patch({ lineHeight })} />
        <NumberField label="Letter spacing" value={object.letterSpacing} min={-5} max={40} step={0.1} suffix="pt" onCommit={(letterSpacing) => patch({ letterSpacing })} />
      </Section>
      <Section title="Box">
        <ColorField label="Background" value={object.fill} nullable onChange={(fill) => patch({ fill })} testId="prop-bg" />
        <ColorField label="Border" value={object.border.color} nullable onChange={(color) => patch({ border: { ...object.border, color } })} />
        <NumberField label="Border width" value={object.border.width} min={0} max={30} step={0.5} suffix="pt" onCommit={(width) => patch({ border: { ...object.border, width } })} />
        <NumberField label="Padding" value={object.padding} min={0} max={80} suffix="pt" onCommit={(padding) => patch({ padding })} />
        <NumberField label="Corner radius" value={object.radius} min={0} max={80} suffix="pt" onCommit={(radius) => patch({ radius })} />
      </Section>
    </>
  );
}

function ImageSection({ object, patch }: { object: ImageObject; patch: (changes: Record<string, unknown>, label?: string, key?: string) => void }) {
  const store = useStore();
  const input = useRef<HTMLInputElement>(null);
  const crop = object.crop ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const setCrop = (side: "top" | "right" | "bottom" | "left", percent: number) => {
    const next = { ...crop, [side]: Math.min(0.9, Math.max(0, percent / 100)) };
    patch({ crop: next.top + next.bottom > 0.95 || next.left + next.right > 0.95 ? crop : next }, "Crop image");
  };
  const replace = async (files: FileList | null) => {
    const file = files?.[0];
    if (input.current) input.current.value = "";
    if (!file) return;
    const loaded = await readImage(file, store.notify.bind(store));
    if (!loaded) return;
    // Same place and size; the new picture is fitted inside, keeping its own proportions.
    const ratio = loaded.width / Math.max(1, loaded.height);
    let { width, height } = object;
    if (width / height > ratio) width = height * ratio;
    else height = width / ratio;
    store.replaceObjects("Replace image", [{ ...object, image: loaded, x: object.x + (object.width - width) / 2, y: object.y + (object.height - height) / 2, width, height, crop: null } as ImageObject]);
  };
  return (
    <>
      <Section title="Picture">
        <div className="ed-row-tools">
          <Toggle label="Flip horizontally" icon="flip" pressed={object.flipX} onChange={(flipX) => patch({ flipX })} testId="prop-flipx" />
          <Toggle label="Flip vertically" icon="flip" pressed={object.flipY} onChange={(flipY) => patch({ flipY })} testId="prop-flipy" />
        </div>
        <div className="ed-grid2">
          <NumberField label="Crop left" value={crop.left * 100} min={0} max={90} suffix="%" onCommit={(v) => setCrop("left", v)} />
          <NumberField label="Crop right" value={crop.right * 100} min={0} max={90} suffix="%" onCommit={(v) => setCrop("right", v)} />
          <NumberField label="Crop top" value={crop.top * 100} min={0} max={90} suffix="%" onCommit={(v) => setCrop("top", v)} />
          <NumberField label="Crop bottom" value={crop.bottom * 100} min={0} max={90} suffix="%" onCommit={(v) => setCrop("bottom", v)} />
        </div>
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => input.current?.click()} data-testid="image-replace">
          Replace picture
        </button>
        <input ref={input} type="file" hidden accept=".png,.jpg,.jpeg,.webp,.gif,.bmp" onChange={(event) => void replace(event.target.files)} />
        <ColorField label="Border" value={object.border.color} nullable onChange={(color) => patch({ border: { ...object.border, color } })} />
      </Section>
    </>
  );
}

function FieldSection({ object, patch }: { object: FormFieldObject; patch: (changes: Record<string, unknown>, label?: string, key?: string) => void }) {
  return (
    <Section title="Form field" hint="A signature field is a place for a signature. It is not a digital signature itself.">
      <div className="ed-field">
        <label htmlFor="field-name">Name</label>
        <input id="field-name" className="input" defaultValue={object.name} data-testid="field-name" key={object.id + object.name} onKeyDown={(e) => e.stopPropagation()} onBlur={(event) => patch({ name: event.target.value.trim() || object.name }, "Rename field")} />
      </div>
      <div className="ed-field">
        <label htmlFor="field-label">Label (tooltip)</label>
        <input id="field-label" className="input" defaultValue={object.label} key={`${object.id}-l${object.label}`} onKeyDown={(e) => e.stopPropagation()} onBlur={(event) => patch({ label: event.target.value }, "Change field label")} />
      </div>
      <label className="check">
        <input type="checkbox" checked={object.required} onChange={(event) => patch({ required: event.target.checked }, "Change required")} />
        <span className="check__text">
          <span className="check__label">Required</span>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={object.readOnly} onChange={(event) => patch({ readOnly: event.target.checked }, "Change read-only")} />
        <span className="check__text">
          <span className="check__label">Read only</span>
        </span>
      </label>
      {object.fieldType === "text" && (
        <label className="check">
          <input type="checkbox" checked={object.multiline} onChange={(event) => patch({ multiline: event.target.checked }, "Change multi-line")} />
          <span className="check__text">
            <span className="check__label">Multiple lines</span>
          </span>
        </label>
      )}
      {(object.fieldType === "text" || object.fieldType === "dropdown") && (
        <div className="ed-field">
          <label htmlFor="field-default">Default value</label>
          <input id="field-default" className="input" defaultValue={object.defaultValue} key={`${object.id}-d${object.defaultValue}`} onKeyDown={(e) => e.stopPropagation()} onBlur={(event) => patch({ defaultValue: event.target.value }, "Change default value")} />
        </div>
      )}
      {object.fieldType === "dropdown" && (
        <div className="ed-field">
          <label htmlFor="field-options">Choices (one per line)</label>
          <textarea id="field-options" className="textarea" rows={4} defaultValue={object.options.join("\n")} key={`${object.id}-o${object.options.join("|")}`} onKeyDown={(e) => e.stopPropagation()} onBlur={(event) => patch({ options: event.target.value.split("\n").map((s) => s.trim()).filter(Boolean) }, "Change choices")} />
        </div>
      )}
      {object.fieldType === "radio" && (
        <div className="ed-field">
          <label htmlFor="field-group">Group</label>
          <input id="field-group" className="input" defaultValue={object.group} onKeyDown={(e) => e.stopPropagation()} onBlur={(event) => patch({ group: event.target.value.trim() || "Group1" }, "Change radio group")} />
        </div>
      )}
      <NumberField label="Text size" value={object.fontSize} min={4} max={72} suffix="pt" onCommit={(fontSize) => patch({ fontSize })} />
      <ColorField label="Background" value={object.fill} nullable onChange={(fill) => patch({ fill })} />
      <ColorField label="Border" value={object.border.color} nullable onChange={(color) => patch({ border: { ...object.border, color } })} />
    </Section>
  );
}

// ---- several objects ---------------------------------------------------------------------------------------------------------

function MultiPanel({ objects }: { objects: EditorObject[] }) {
  return (
    <>
      <Header title={`${objects.length} objects`} />
      <AlignSection objects={objects} />
      <OrderSection objects={objects} />
      <LayerSection objects={objects} />
      <GroupSection objects={objects} />
      <MergeSection objects={objects} />
      <ManageSection objects={objects} />
    </>
  );
}

/** Lock, duplicate and delete. */
function ManageSection({ objects }: { objects: readonly EditorObject[] }) {
  const store = useStore();
  const ids = objects.map((o) => o.id);
  const added = objects.filter((o) => o.kind !== "existing");
  const locked = added.length > 0 && added.every((o) => o.locked);
  const edited = objects.some((o) => o.kind === "existing" && (o.edited || o.canMove));
  return (
    <Section title="Selection">
      <div className="ed-actions ed-actions--2">
        {added.length > 0 && (
          <Action icon={locked ? "unlock" : "lock"} label={locked ? "Unlock" : "Lock"} title={locked ? "Allow it to be moved and resized again" : "Stop it being moved or resized by accident"} testId="prop-lock" onClick={() => store.updateObjects(locked ? "Unlock" : "Lock", added.map((o) => ({ id: o.id, patch: { locked: !locked } })))} />
        )}
        {added.length > 0 && <Action icon="copy" label="Duplicate" testId="duplicate" onClick={() => store.duplicate(added.map((o) => o.id))} />}
        {edited && objects.some((o) => o.kind === "existing" && o.edited) && <Action icon="refresh" label="Reset" title="Put it back where it was in the file" testId="reset-existing" onClick={() => store.resetExisting(ids)} />}
        <Action icon="trash" label="Delete" title="Delete (Del)" testId="delete" disabled={removable(objects).length === 0} onClick={() => store.removeObjects(ids)} />
      </div>
    </Section>
  );
}

// ---- something the page already draws ------------------------------------------------------------------------------------------------

const EXISTING_HINT = "This is part of the PDF. Drag it to move it, use the handles to resize it, or delete it. The file only changes when you download a new copy.";

function ExistingPanel({ object }: { object: ExistingObject }) {
  const store = useStore();
  const title = object.what === "image" ? "Image on the page" : object.what === "text" ? (object.label === "Text block" ? "Text on the page" : "Line of text on the page") : object.what === "annotation" ? `${object.label} (note or markup)` : `${object.label} on the page`;
  const firstLine = object.lines?.[0];
  return (
    <>
      <Header title={title} hint={object.reason ?? EXISTING_HINT} />
      {object.what === "image" && object.pixelWidth && object.pixelHeight && (
        <p className="ed-note">
          {object.pixelWidth} × {object.pixelHeight} pixels
        </p>
      )}
      <GeometrySection object={object} />
      {object.what === "text" && firstLine && (
        <Section title="Text" hint="Click the text twice, or use the button, to change its words.">
          <div className="ed-actions ed-actions--1">
            <Action icon="edit-text" label="Edit the text" testId="existing-edit-text" onClick={() => store.selectLine({ page: object.page, lineId: firstLine.id })} />
          </div>
        </Section>
      )}
      <AlignSection objects={[object]} />
      <OrderSection objects={[object]} />
      <ManageSection objects={[object]} />
    </>
  );
}

/** Reads an image file for placing on a page. Returns its bytes and pixel size, or tells the person why not. */
// eslint-disable-next-line react-refresh/only-export-components -- shared helper kept next to the code that uses it
export async function readImage(file: File, notify: (text: string, tone: "warning") => void): Promise<ImageObject["image"] | null> {
  const { accepted, rejected } = checkFiles([file], { extensions: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"], maxBytes: LIMITS.maxImageBytes, maxFiles: 1, existing: 0, label: "an image" });
  if (rejected.length > 0 || accepted.length === 0) {
    notify(rejected[0]?.reason ?? "That file cannot be used.", "warning");
    return null;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const problem = contentProblem(file.name, bytes);
  if (problem) {
    notify(problem, "warning");
    return null;
  }
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return { name: file.name, mime: file.type || "image/png", bytes, ...size };
  } catch {
    notify(`“${file.name}” could not be read as an image. It may be damaged or in a format this browser does not support.`, "warning");
    return null;
  }
}

