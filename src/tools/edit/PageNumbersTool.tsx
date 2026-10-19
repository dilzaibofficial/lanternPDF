import { useMemo, useState } from "react";
import { PagePreview } from "../../components/pdf/PagePreview";
import { PageScopeField, usePageScope } from "../../components/pdf/PageScopeField";
import { Checkbox, Field, Segmented } from "../../components/ui/Field";
import { Icon } from "../../components/ui/Icon";
import { PositionPicker } from "../../components/ui/PositionPicker";
import { JobView } from "../../components/tool/JobView";
import { Panel } from "../../components/tool/Panel";
import { ResultPanel } from "../../components/tool/ResultPanel";
import { SinglePdfGate } from "../../components/tool/SinglePdfGate";
import { useDebounced } from "../../hooks/useDebounced";
import { useAcceptHandoff } from "../../hooks/useHandoff";
import { useJob } from "../../hooks/useJob";
import { useLivePreview, useSinglePage } from "../../hooks/usePagePreview";
import { type PdfItem, toPdfInput, usePdfFiles } from "../../hooks/usePdfFiles";
import { formatBytes } from "../../lib/format";
import type { FontFamily } from "../../lib/pdf/fonts";
import { DEFAULT_PAGE_NUMBER_OPTIONS, type NumberPosition, type NumberStyle, type PageNumberOptions } from "../../lib/pdf/pageNumbers";
import type { OutputFile } from "../../lib/pdf/types";
import { runOperation } from "../../lib/worker/client";
import type { ToolProps } from "../types";

const POSITIONS: { value: NumberPosition; label: string }[] = [
  { value: "top-left", label: "Top left" },
  { value: "top-center", label: "Top centre" },
  { value: "top-right", label: "Top right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "bottom-center", label: "Bottom centre" },
  { value: "bottom-right", label: "Bottom right" },
];

const PRESETS = ["{n}", "Page {n}", "Page {n} of {total}", "{n} / {total}", "- {n} -"];

export default function PageNumbersTool({ tool }: ToolProps) {
  const files = usePdfFiles({ multiple: false });
  useAcceptHandoff(files.addBytes);
  const job = useJob<OutputFile>();

  return (
    <JobView
      job={job}
      title="Adding page numbers…"
      renderResult={(file) => (
        <ResultPanel
          title="Your numbered PDF is ready"
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
          nextTools={["watermark", "compress", "protect", "metadata"]}
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
  const [options, setOptions] = useState<PageNumberOptions>({ ...DEFAULT_PAGE_NUMBER_OPTIONS });
  const [previewPage, setPreviewPage] = useState(1);
  const scope = usePageScope(pageCount);
  const set = <K extends keyof PageNumberOptions>(key: K, value: PageNumberOptions[K]) => setOptions((current) => ({ ...current, [key]: value }));

  const single = useSinglePage(item, previewPage);

  // The number this page will get in the full result (or none, when the scope skips it).
  const numbered = scope.resolved.pages === null ? Array.from({ length: pageCount }, (_, i) => i + 1) : scope.resolved.pages;
  const indexOfPreview = numbered.indexOf(previewPage);
  const settings = useDebounced(useMemo(() => ({ options, indexOfPreview, count: numbered.length, previewPage }), [options, indexOfPreview, numbered.length, previewPage]), 250);

  const preview = useLivePreview(single.bytes, settings, async (bytes) => {
    if (settings.indexOfPreview < 0) return bytes; // this page is not numbered: show it as it is
    const file = await runOperation("pageNumbers", {
      input: { name: "preview.pdf", bytes },
      options: {
        ...settings.options,
        pages: null,
        startAt: settings.options.startAt + settings.indexOfPreview,
        preview: { total: settings.options.startAt + settings.count - 1, pageNumber: settings.previewPage },
      },
    });
    return file.bytes;
  });

  const apply = () =>
    run(({ signal, onProgress }) => runOperation("pageNumbers", { input: toPdfInput(item), options: { ...options, pages: scope.resolved.pages } }, { signal, onProgress }));

  return (
    <div className="tool-layout tool-layout--side">
      <div className="tool-layout__main">
        <div className="cluster" style={{ justifyContent: "space-between" }}>
          <Field label="Preview page" className="" hint={`1 to ${pageCount}`}>
            {({ id }) => (
              <input
                id={id}
                className="input"
                style={{ width: "6rem" }}
                type="number"
                min={1}
                max={pageCount}
                value={previewPage}
                onChange={(event) => setPreviewPage(Math.min(pageCount, Math.max(1, Number(event.target.value) || 1)))}
              />
            )}
          </Field>
          {indexOfPreview < 0 && <p className="muted">This page is not numbered with the current settings.</p>}
        </div>
        <PagePreview bytes={preview.bytes ?? single.bytes} busy={preview.busy} error={single.error ?? preview.error} label={`Preview of page ${previewPage} with its page number`} />
      </div>

      <aside className="tool-layout__side">
        <Panel title="Page numbers">
          <PositionPicker<NumberPosition> legend="Position" value={options.position} onChange={(value) => set("position", value)} cells={POSITIONS} />

          <div className="panel__section">
            <Field label="Text" hint="{n} is the page number and {total} the last number.">
              {({ id, describedBy }) => <input id={id} className="input" value={options.format} aria-describedby={describedBy} onChange={(event) => set("format", event.target.value)} data-testid="format" />}
            </Field>
            <div className="chips" role="group" aria-label="Text presets">
              {PRESETS.map((preset) => (
                <button key={preset} type="button" className="chip" aria-pressed={options.format === preset} onClick={() => set("format", preset)}>
                  {preset.replace("{n}", "1").replace("{total}", "10")}
                </button>
              ))}
            </div>
            <Segmented<NumberStyle>
              name="number-style"
              legend="Numerals"
              value={options.style}
              onChange={(value) => set("style", value)}
              options={[
                { value: "decimal", label: "1, 2, 3" },
                { value: "roman", label: "i, ii, iii" },
                { value: "upper-roman", label: "I, II, III" },
              ]}
            />
            <Field label="First number">
              {({ id }) => <input id={id} className="input" type="number" min={0} max={99999} value={options.startAt} onChange={(event) => set("startAt", Math.trunc(Number(event.target.value) || 0))} />}
            </Field>
          </div>

          <PageScopeField pageCount={pageCount} state={scope} label="Number" />
          {options.position.endsWith("center") ? null : <Checkbox checked={options.facing} onChange={(value) => set("facing", value)} label="Facing pages" hint="Mirrors the position on even pages, for printing as a book." />}

          <details>
            <summary style={{ cursor: "pointer", fontWeight: 650 }}>Font and spacing</summary>
            <div className="panel__section" style={{ marginTop: "var(--space-3)" }}>
              <Field label="Typeface">
                {({ id }) => (
                  <select id={id} className="select" value={options.family} onChange={(event) => set("family", event.target.value as FontFamily)}>
                    <option value="sans">Sans-serif</option>
                    <option value="serif">Serif</option>
                    <option value="mono">Monospace</option>
                  </select>
                )}
              </Field>
              <div className="cluster">
                <Checkbox checked={options.bold} onChange={(value) => set("bold", value)} label="Bold" />
                <Checkbox checked={options.italic} onChange={(value) => set("italic", value)} label="Italic" />
              </div>
              <div className="field-row">
                <Field label="Size (pt)">
                  {({ id }) => <input id={id} className="input" type="number" min={4} max={96} value={options.fontSize} onChange={(event) => set("fontSize", Number(event.target.value) || 11)} />}
                </Field>
                <Field label="Margin (pt)">
                  {({ id }) => <input id={id} className="input" type="number" min={0} max={300} value={options.margin} onChange={(event) => set("margin", Number(event.target.value) || 0)} />}
                </Field>
                <Field label="Colour">{({ id }) => <input id={id} type="color" value={options.color} onChange={(event) => set("color", event.target.value)} />}</Field>
              </div>
            </div>
          </details>

          <div className="action-bar">
            <button type="button" className="btn btn--primary btn--lg" disabled={scope.resolved.empty || Boolean(preview.error && !preview.bytes)} onClick={apply} data-testid="run-button">
              <Icon name="hash" size={22} />
              Add page numbers
            </button>
          </div>
        </Panel>
      </aside>
    </div>
  );
}
