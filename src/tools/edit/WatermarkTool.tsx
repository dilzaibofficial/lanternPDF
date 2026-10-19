import { useEffect, useMemo, useRef, useState } from "react";
import { PagePreview } from "../../components/pdf/PagePreview";
import { PageScopeField, usePageScope } from "../../components/pdf/PageScopeField";
import { Alert } from "../../components/ui/Alerts";
import { Checkbox, Field, Segmented } from "../../components/ui/Field";
import { Icon } from "../../components/ui/Icon";
import { PositionPicker } from "../../components/ui/PositionPicker";
import { JobView } from "../../components/tool/JobView";
import { Panel } from "../../components/tool/Panel";
import { ResultPanel } from "../../components/tool/ResultPanel";
import { SinglePdfGate } from "../../components/tool/SinglePdfGate";
import { LIMITS } from "../../config/limits";
import { useDebounced } from "../../hooks/useDebounced";
import { useAcceptHandoff } from "../../hooks/useHandoff";
import { useJob } from "../../hooks/useJob";
import { useLivePreview, useSinglePage } from "../../hooks/usePagePreview";
import { type PdfItem, toPdfInput, usePdfFiles } from "../../hooks/usePdfFiles";
import { checkFiles, contentProblem } from "../../lib/files";
import { formatBytes } from "../../lib/format";
import type { FontFamily } from "../../lib/pdf/fonts";
import type { OutputFile } from "../../lib/pdf/types";
import { DEFAULT_WATERMARK_OPTIONS, type WatermarkOptions, type WatermarkPosition } from "../../lib/pdf/watermark";
import { runOperation } from "../../lib/worker/client";
import type { ToolProps } from "../types";

const CELLS: { value: WatermarkPosition; label: string }[] = [
  { value: "top-left", label: "Top left" },
  { value: "top-center", label: "Top centre" },
  { value: "top-right", label: "Top right" },
  { value: "middle-left", label: "Middle left" },
  { value: "center", label: "Centre" },
  { value: "middle-right", label: "Middle right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "bottom-center", label: "Bottom centre" },
  { value: "bottom-right", label: "Bottom right" },
];

export default function WatermarkTool({ tool }: ToolProps) {
  const files = usePdfFiles({ multiple: false });
  useAcceptHandoff(files.addBytes);
  const job = useJob<OutputFile>();

  return (
    <JobView
      job={job}
      title="Adding the watermark…"
      renderResult={(file) => (
        <ResultPanel
          title="Your watermarked PDF is ready"
          files={[file]}
          stats={[
            { label: "Pages", value: String(file.pageCount ?? "—") },
            { label: "Size", value: formatBytes(file.bytes.length) },
          ]}
          onReset={() => {
            job.reset();
            files.clear();
          }}
          onBack={job.reset}
          nextTools={["page-numbers", "compress", "protect"]}
        />
      )}
    >
      <SinglePdfGate tool={tool} files={files}>
        {(item) => <Workspace item={item} run={(work) => job.run(work)} />}
      </SinglePdfGate>
    </JobView>
  );
}

type Run = (work: (context: { signal: AbortSignal; onProgress: (f: number, m?: string) => void }) => Promise<OutputFile>) => void;

function Workspace({ item, run }: { item: PdfItem; run: Run }) {
  const pageCount = item.pageCount ?? 1;
  const [options, setOptions] = useState<WatermarkOptions>({ ...DEFAULT_WATERMARK_OPTIONS });
  const [previewPage, setPreviewPage] = useState(1);
  const [imageNote, setImageNote] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const scope = usePageScope(pageCount);
  const set = <K extends keyof WatermarkOptions>(key: K, value: WatermarkOptions[K]) => setOptions((current) => ({ ...current, [key]: value }));

  useEffect(() => () => void (imageUrl && URL.revokeObjectURL(imageUrl)), [imageUrl]);

  const single = useSinglePage(item, previewPage);
  const stamped = scope.resolved.pages === null || scope.resolved.pages.includes(previewPage);
  const ready = options.kind === "text" ? options.text.trim() !== "" : Boolean(options.image);
  const settings = useDebounced(useMemo(() => ({ options, stamped, ready }), [options, stamped, ready]), 250);

  const preview = useLivePreview(single.bytes, settings, async (bytes) => {
    if (!settings.stamped || !settings.ready) return bytes;
    const file = await runOperation("watermark", { input: { name: "preview.pdf", bytes }, options: { ...settings.options, pages: null } });
    return file.bytes;
  });

  const chooseImage = async (list: FileList | null) => {
    const file = list?.[0];
    if (picker.current) picker.current.value = "";
    if (!file) return;
    const { accepted, rejected } = checkFiles([file], { extensions: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"], maxBytes: LIMITS.maxImageBytes, maxFiles: 1, existing: 0, label: "an image" });
    if (rejected.length > 0 || accepted.length === 0) {
      setImageNote(rejected[0]?.reason ?? "That file cannot be used.");
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const problem = contentProblem(file.name, bytes);
    if (problem) {
      setImageNote(problem);
      return;
    }
    setImageNote(null);
    setImageUrl(URL.createObjectURL(new Blob([bytes as BlobPart], { type: file.type })));
    set("image", { name: file.name, bytes });
  };

  const apply = () => run(({ signal, onProgress }) => runOperation("watermark", { input: toPdfInput(item), options: { ...options, pages: scope.resolved.pages } }, { signal, onProgress }));

  return (
    <div className="tool-layout tool-layout--side">
      <div className="tool-layout__main">
        <div className="cluster" style={{ justifyContent: "space-between" }}>
          <Field label="Preview page" hint={`1 to ${pageCount}`}>
            {({ id }) => <input id={id} className="input" style={{ width: "6rem" }} type="number" min={1} max={pageCount} value={previewPage} onChange={(event) => setPreviewPage(Math.min(pageCount, Math.max(1, Number(event.target.value) || 1)))} />}
          </Field>
          {!stamped && <p className="muted">This page is not watermarked with the current settings.</p>}
          {stamped && !ready && <p className="muted">{options.kind === "text" ? "Type the watermark text." : "Choose an image to see the preview."}</p>}
        </div>
        <PagePreview bytes={preview.bytes ?? single.bytes} busy={preview.busy} error={single.error ?? preview.error} label={`Preview of page ${previewPage} with the watermark`} />
        {options.layer === "under" && <Alert tone="info">A watermark behind the content is hidden by anything opaque on the page, such as scanned images or filled shapes.</Alert>}
      </div>

      <aside className="tool-layout__side">
        <Panel title="Watermark">
          <Segmented<"text" | "image">
            name="watermark-kind"
            legend="Type"
            value={options.kind}
            onChange={(value) => set("kind", value)}
            options={[
              { value: "text", label: "Text" },
              { value: "image", label: "Image" },
            ]}
          />

          {options.kind === "text" ? (
            <div className="panel__section">
              <Field label="Text" hint="Press Enter for a second line.">
                {({ id, describedBy }) => <textarea id={id} className="textarea" style={{ minHeight: "4.5rem" }} value={options.text} aria-describedby={describedBy} onChange={(event) => set("text", event.target.value)} data-testid="watermark-text" />}
              </Field>
              <div className="field-row">
                <Field label="Typeface">
                  {({ id }) => (
                    <select id={id} className="select" value={options.family} onChange={(event) => set("family", event.target.value as FontFamily)}>
                      <option value="sans">Sans-serif</option>
                      <option value="serif">Serif</option>
                      <option value="mono">Monospace</option>
                    </select>
                  )}
                </Field>
                <Field label="Size (pt)">
                  {({ id }) => <input id={id} className="input" type="number" min={4} max={400} value={options.fontSize} onChange={(event) => set("fontSize", Number(event.target.value) || 48)} />}
                </Field>
                <Field label="Colour">{({ id }) => <input id={id} type="color" value={options.color} onChange={(event) => set("color", event.target.value)} />}</Field>
              </div>
              <div className="cluster">
                <Checkbox checked={options.bold} onChange={(value) => set("bold", value)} label="Bold" />
                <Checkbox checked={options.italic} onChange={(value) => set("italic", value)} label="Italic" />
              </div>
            </div>
          ) : (
            <div className="panel__section">
              <input ref={picker} type="file" hidden accept=".png,.jpg,.jpeg,.webp,.gif,.bmp" data-testid="watermark-image-input" onChange={(event) => void chooseImage(event.target.files)} />
              <button type="button" className="btn btn--secondary" onClick={() => picker.current?.click()}>
                <Icon name="image" size={18} />
                {options.image ? "Choose a different image" : "Choose an image"}
              </button>
              {options.image && imageUrl && (
                <div className="cluster">
                  <img src={imageUrl} alt="" style={{ width: "3rem", height: "3rem", objectFit: "contain", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--checker-b)" }} />
                  <span className="muted" style={{ fontSize: "var(--text-sm)", overflowWrap: "anywhere" }}>
                    {options.image.name}
                  </span>
                </div>
              )}
              {imageNote && <Alert tone="warning">{imageNote}</Alert>}
              <Field label={`Size: ${options.imageScale}% of the page width`}>
                {({ id }) => <input id={id} type="range" min={5} max={100} step={5} value={options.imageScale} onChange={(event) => set("imageScale", Number(event.target.value))} />}
              </Field>
            </div>
          )}

          <Field label={`Opacity: ${Math.round(options.opacity * 100)}%`}>
            {({ id }) => <input id={id} type="range" min={5} max={100} step={5} value={Math.round(options.opacity * 100)} onChange={(event) => set("opacity", Number(event.target.value) / 100)} />}
          </Field>
          <Field label={`Rotation: ${options.rotation}°`}>
            {({ id }) => <input id={id} type="range" min={-90} max={90} step={5} value={options.rotation} onChange={(event) => set("rotation", Number(event.target.value))} />}
          </Field>

          <PositionPicker<WatermarkPosition> legend="Position" value={options.position} onChange={(value) => set("position", value)} cells={CELLS} extra={{ value: "tiled", label: "Repeat across the page" }} />

          <Segmented<"over" | "under">
            name="layer"
            legend="Layer"
            value={options.layer}
            onChange={(value) => set("layer", value)}
            options={[
              { value: "over", label: "Over the content" },
              { value: "under", label: "Behind the content" },
            ]}
          />
          <PageScopeField pageCount={pageCount} state={scope} label="Stamp" />

          <div className="action-bar">
            <button type="button" className="btn btn--primary btn--lg" disabled={!ready || scope.resolved.empty} onClick={apply} data-testid="run-button">
              <Icon name="droplet" size={22} />
              Add watermark
            </button>
          </div>
        </Panel>
      </aside>
    </div>
  );
}
