import { useMemo, useState } from "react";
import { type CropFractions, CropOverlay } from "../../components/pdf/CropOverlay";
import { PagePreview } from "../../components/pdf/PagePreview";
import { PageScopeField, usePageScope } from "../../components/pdf/PageScopeField";
import { Alert } from "../../components/ui/Alerts";
import { Field, Segmented } from "../../components/ui/Field";
import { Icon } from "../../components/ui/Icon";
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
import type { CropOptions } from "../../lib/pdf/crop";
import type { OutputFile } from "../../lib/pdf/types";
import { runOperation } from "../../lib/worker/client";
import type { ToolProps } from "../types";

type Unit = "mm" | "in" | "pt" | "percent";
type Basis = "percent" | "pt";

const UNIT_LABEL: Record<Unit, string> = { mm: "mm", in: "in", pt: "pt", percent: "%" };

/** Points per unit (percent is handled separately). */
const PT_PER: Record<Exclude<Unit, "percent">, number> = { mm: 72 / 25.4, in: 72, pt: 1 };

const EMPTY: CropFractions = { left: 0, top: 0, right: 0, bottom: 0 };
const DEFAULT_BOX: CropFractions = { left: 0.08, top: 0.08, right: 0.08, bottom: 0.08 };

export default function CropTool({ tool }: ToolProps) {
  const files = usePdfFiles({ multiple: false });
  useAcceptHandoff(files.addBytes);
  const job = useJob<OutputFile>();

  return (
    <JobView
      job={job}
      title="Cropping your PDF…"
      renderResult={(file) => (
        <ResultPanel
          title="Your cropped PDF is ready"
          files={[file]}
          stats={[
            { label: "Pages", value: String(file.pageCount ?? "—") },
            { label: "Size", value: formatBytes(file.bytes.length) },
          ]}
          notes={
            <Alert tone="info" title="Cropping hides, it does not erase">
              <p>The area outside the crop box is no longer shown, but its content is still inside the file. Do not rely on cropping to remove sensitive information.</p>
            </Alert>
          }
          onReset={() => {
            job.reset();
            files.clear();
          }}
          onBack={job.reset}
          nextTools={["page-numbers", "rotate", "compress"]}
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
  const [box, setBox] = useState<CropFractions>(DEFAULT_BOX);
  const [unit, setUnit] = useState<Unit>("mm");
  const [basis, setBasis] = useState<Basis>("percent");
  const [mode, setMode] = useState<"edit" | "result">("edit");
  const [previewPage, setPreviewPage] = useState(1);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const scope = usePageScope(pageCount);
  const single = useSinglePage(item, previewPage);

  const hasCrop = box.left + box.right + box.top + box.bottom > 0.0001;

  // The margins the engine will apply.
  const cropOptions = (pages: number[] | null): CropOptions => {
    const toPercent = (fraction: number) => fraction * 100;
    return basis === "percent" && size
      ? { unit: "percent", pages, margins: { left: toPercent(box.left), right: toPercent(box.right), top: toPercent(box.top), bottom: toPercent(box.bottom) } }
      : { unit: "pt", pages, margins: { left: box.left * (size?.width ?? 0), right: box.right * (size?.width ?? 0), top: box.top * (size?.height ?? 0), bottom: box.bottom * (size?.height ?? 0) } };
  };

  const settings = useDebounced(useMemo(() => ({ box, basis, size, mode }), [box, basis, size, mode]), 250);
  const resultPreview = useLivePreview(mode === "result" ? single.bytes : null, settings, async (bytes) => {
    const options = cropOptions(null);
    const file = await runOperation("crop", { input: { name: "preview.pdf", bytes }, options });
    return file.bytes;
  });

  // Margin fields show the box in the chosen unit; editing one updates the box.
  const toUnit = (fraction: number, axis: "width" | "height") => {
    if (!size) return "";
    const points = fraction * size[axis];
    const value = unit === "percent" ? fraction * 100 : points / PT_PER[unit];
    return String(Math.round(value * 100) / 100);
  };
  const fromUnit = (text: string, axis: "width" | "height") => {
    const value = Number(text);
    if (!Number.isFinite(value) || !size) return 0;
    return unit === "percent" ? value / 100 : (value * PT_PER[unit]) / size[axis];
  };
  const setMargin = (side: keyof CropFractions, text: string) => {
    const axis = side === "left" || side === "right" ? "width" : "height";
    const opposite: keyof CropFractions = { left: "right", right: "left", top: "bottom", bottom: "top" }[side] as keyof CropFractions;
    const value = Math.max(0, Math.min(1 - box[opposite] - 0.1, fromUnit(text, axis)));
    setBox({ ...box, [side]: value });
  };

  const apply = () => run(({ signal, onProgress }) => runOperation("crop", { input: toPdfInput(item), options: cropOptions(scope.resolved.pages) }, { signal, onProgress }));

  const field = (side: keyof CropFractions, label: string) => (
    <Field label={`${label} (${UNIT_LABEL[unit]})`}>
      {({ id }) => (
        <input
          id={id}
          className="input"
          type="number"
          min={0}
          step={unit === "percent" ? 1 : unit === "in" ? 0.05 : 1}
          disabled={!size} // the conversion needs the page size, which the preview reports once it has drawn
          value={toUnit(box[side], side === "left" || side === "right" ? "width" : "height")}
          onChange={(event) => setMargin(side, event.target.value)}
        />
      )}
    </Field>
  );

  return (
    <div className="tool-layout tool-layout--side">
      <div className="tool-layout__main">
        <div className="cluster" style={{ justifyContent: "space-between" }}>
          <Segmented<"edit" | "result"> name="crop-mode" legend="View" hideLegend value={mode} onChange={setMode} options={[{ value: "edit", label: "Position the crop box" }, { value: "result", label: "Preview the result" }]} />
          <Field label="Preview page" hint={`1 to ${pageCount}`}>
            {({ id }) => <input id={id} className="input" style={{ width: "6rem" }} type="number" min={1} max={pageCount} value={previewPage} onChange={(event) => setPreviewPage(Math.min(pageCount, Math.max(1, Number(event.target.value) || 1)))} />}
          </Field>
        </div>
        {mode === "edit" ? (
          <PagePreview bytes={single.bytes} error={single.error} label={`Page ${previewPage}. Drag the crop box to choose the area to keep.`} onSize={setSize}>
            <CropOverlay value={box} onChange={setBox} />
          </PagePreview>
        ) : (
          <PagePreview bytes={resultPreview.bytes} busy={resultPreview.busy} error={resultPreview.error} label={`Page ${previewPage} after cropping`} />
        )}
        <p className="panel__note">Drag the box or its handles. To size it exactly, type the margins on the right.</p>
      </div>

      <aside className="tool-layout__side">
        <Panel title="Crop">
          <Segmented<Unit>
            name="crop-unit"
            legend="Units"
            value={unit}
            onChange={setUnit}
            options={[
              { value: "mm", label: "mm" },
              { value: "in", label: "in" },
              { value: "pt", label: "pt" },
              { value: "percent", label: "%" },
            ]}
          />
          <div className="margin-grid">
            {field("top", "Top")}
            {field("bottom", "Bottom")}
            {field("left", "Left")}
            {field("right", "Right")}
          </div>
          <div className="cluster">
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => setBox(DEFAULT_BOX)}>
              Reset box
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setBox(EMPTY)}>
              Clear
            </button>
          </div>
          <Segmented<Basis>
            name="crop-basis"
            legend="On pages of different sizes"
            value={basis}
            onChange={setBasis}
            options={[
              { value: "percent", label: "Same share of each page" },
              { value: "pt", label: "Same distance on each page" },
            ]}
          />
          <PageScopeField pageCount={pageCount} state={scope} label="Crop" />
          <div className="action-bar">
            <button type="button" className="btn btn--primary btn--lg" disabled={!hasCrop || !size || scope.resolved.empty} onClick={apply} data-testid="run-button">
              <Icon name="crop" size={22} />
              Crop PDF
            </button>
          </div>
        </Panel>
      </aside>
    </div>
  );
}
