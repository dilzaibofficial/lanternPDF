import { useMemo, useState } from "react";
import { PageRangeField } from "../../components/pdf/PageRangeField";
import { Alert } from "../../components/ui/Alerts";
import { Field, Segmented } from "../../components/ui/Field";
import { Icon } from "../../components/ui/Icon";
import { JobView } from "../../components/tool/JobView";
import { Panel } from "../../components/tool/Panel";
import { ResultPanel } from "../../components/tool/ResultPanel";
import { SinglePdfGate } from "../../components/tool/SinglePdfGate";
import { useAcceptHandoff } from "../../hooks/useHandoff";
import { useJob } from "../../hooks/useJob";
import { type PdfItem, toPdfSource, usePdfFiles } from "../../hooks/usePdfFiles";
import { AppError } from "../../lib/errors";
import { baseName, formatBytes, plural } from "../../lib/format";
import { type PdfToImagesResult, pdfToImages } from "../../lib/pdf/pdfToImages";
import { expandRanges, parsePageRanges } from "../../lib/ranges";
import type { ToolProps } from "../types";

type Format = "jpeg" | "png";

const RESOLUTIONS = [
  { dpi: 72, label: "72 dpi: screen" },
  { dpi: 150, label: "150 dpi: good for reading" },
  { dpi: 200, label: "200 dpi: sharp" },
  { dpi: 300, label: "300 dpi: print" },
];

export default function PdfToImagesTool({ tool }: ToolProps) {
  const files = usePdfFiles({ multiple: false });
  useAcceptHandoff(files.addBytes);
  const job = useJob<PdfToImagesResult & { name: string }>();

  return (
    <JobView
      job={job}
      title="Rendering your pages…"
      renderResult={(result) => (
        <ResultPanel
          title={result.files.length === 1 ? "Your image is ready" : `Your ${result.files.length} images are ready`}
          subtitle={`Rendered from ${result.name}.`}
          files={result.files}
          stats={[
            { label: "Images", value: String(result.files.length) },
            { label: "Total size", value: formatBytes(result.files.reduce((sum, file) => sum + file.bytes.length, 0)) },
          ]}
          notes={
            result.capped.length > 0 ? (
              <Alert tone="info">
                {result.capped.length === 1 ? `Page ${result.capped[0]} is` : `Pages ${result.capped.join(", ")} are`} very large, so the resolution was reduced to keep the image under 8000 pixels on its longest side.
              </Alert>
            ) : undefined
          }
          zipName={`${baseName(result.name)}_images.zip`}
          onReset={() => {
            job.reset();
            files.clear();
          }}
          onBack={job.reset}
          nextTools={[]}
        />
      )}
    >
      <SinglePdfGate tool={tool} files={files}>
        {(item) => <Workspace item={item} run={(work) => job.run(work)} />}
      </SinglePdfGate>
    </JobView>
  );
}

type Run = (work: (context: { signal: AbortSignal; onProgress: (f: number, m?: string) => void }) => Promise<PdfToImagesResult & { name: string }>) => void;

function Workspace({ item, run }: { item: PdfItem; run: Run }) {
  const pageCount = item.pageCount ?? 0;
  const [format, setFormat] = useState<Format>("jpeg");
  const [dpi, setDpi] = useState(150);
  const [quality, setQuality] = useState(90);
  const [scope, setScope] = useState<"all" | "range">("all");
  const [rangeText, setRangeText] = useState("");
  const source = useMemo(() => toPdfSource(item), [item]);

  const selection = useMemo((): { pages: number[]; error: string | null } => {
    if (scope === "all") return { pages: Array.from({ length: pageCount }, (_, i) => i + 1), error: null };
    if (rangeText.trim() === "") return { pages: [], error: null };
    try {
      return { pages: [...new Set(expandRanges(parsePageRanges(rangeText, pageCount)))].sort((a, b) => a - b), error: null };
    } catch (error) {
      return { pages: [], error: error instanceof AppError ? error.message : "Check the page range." };
    }
  }, [scope, rangeText, pageCount]);

  const start = () =>
    run(async ({ signal, onProgress }) => {
      const result = await pdfToImages(source, { format, dpi, quality: quality / 100, pages: selection.pages, signal }, { onProgress });
      return { ...result, name: item.name };
    });

  return (
    <div className="tool-layout tool-layout--side">
      <div className="tool-layout__main">
        <Alert tone="info" title="How it works">
          <p>
            Each page is drawn at the resolution you pick and saved as an image. {pageCount > 1 ? "Several images are bundled into a ZIP file." : ""} Higher resolutions give sharper images and bigger files.
          </p>
        </Alert>
        {dpi >= 300 && pageCount > 40 && selection.pages.length > 40 && (
          <Alert tone="warning">Converting {plural(selection.pages.length, "page")} at 300 dpi needs a lot of memory and may be slow. Consider a lower resolution or a smaller page range.</Alert>
        )}
      </div>
      <aside className="tool-layout__side">
        <Panel title="Image options">
          <Segmented<Format>
            name="format"
            legend="Format"
            value={format}
            onChange={setFormat}
            options={[
              { value: "jpeg", label: "JPG" },
              { value: "png", label: "PNG" },
            ]}
          />
          <Field label="Resolution">
            {({ id }) => (
              <select id={id} className="select" value={dpi} onChange={(event) => setDpi(Number(event.target.value))} data-testid="dpi">
                {RESOLUTIONS.map((option) => (
                  <option key={option.dpi} value={option.dpi}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {format === "jpeg" && (
            <Field label={`JPG quality: ${quality}%`} hint="Lower quality makes smaller files.">
              {({ id }) => <input id={id} type="range" min={50} max={100} step={5} value={quality} onChange={(event) => setQuality(Number(event.target.value))} />}
            </Field>
          )}
          <Segmented<"all" | "range">
            name="scope"
            legend="Pages"
            value={scope}
            onChange={setScope}
            options={[
              { value: "all", label: `All ${pageCount}` },
              { value: "range", label: "A selection" },
            ]}
          />
          {scope === "range" && <PageRangeField value={rangeText} onChange={setRangeText} pageCount={pageCount} error={selection.error} />}
          <p className="panel__note" aria-live="polite" data-testid="selection-summary">
            {selection.pages.length === 0 ? "Choose at least one page." : `${plural(selection.pages.length, "image")} will be created.`}
          </p>
          <div className="action-bar">
            <button type="button" className="btn btn--primary btn--lg" disabled={selection.pages.length === 0 || Boolean(selection.error)} onClick={start} data-testid="run-button">
              <Icon name="image" size={22} />
              Convert to {format === "jpeg" ? "JPG" : "PNG"}
            </button>
          </div>
        </Panel>
      </aside>
    </div>
  );
}
