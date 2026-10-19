import { useState } from "react";
import { Dropzone } from "../../components/files/Dropzone";
import { FileList, type FileRowModel } from "../../components/files/FileList";
import { Alert } from "../../components/ui/Alerts";
import { Field, Segmented } from "../../components/ui/Field";
import { Icon } from "../../components/ui/Icon";
import { JobView } from "../../components/tool/JobView";
import { LocalNote, Panel } from "../../components/tool/Panel";
import { ResultPanel } from "../../components/tool/ResultPanel";
import { useJob } from "../../hooks/useJob";
import { useImageFiles } from "../../hooks/useImageFiles";
import { formatBytes, plural } from "../../lib/format";
import type { ImagesToPdfOptions, MarginOption, Orientation, PageSizeOption } from "../../lib/pdf/images";
import type { OutputFile } from "../../lib/pdf/types";
import { runOperation } from "../../lib/worker/client";
import type { ToolProps } from "../types";

const PAGE_SIZES: { value: PageSizeOption; label: string }[] = [
  { value: "a4", label: "A4 (210 × 297 mm)" },
  { value: "letter", label: "US Letter (8.5 × 11 in)" },
  { value: "legal", label: "US Legal (8.5 × 14 in)" },
  { value: "a3", label: "A3 (297 × 420 mm)" },
  { value: "a5", label: "A5 (148 × 210 mm)" },
  { value: "fit", label: "Same size as the image" },
];

export default function ImagesToPdfTool({ tool }: ToolProps) {
  const images = useImageFiles();
  const job = useJob<{ files: OutputFile[]; count: number }>();
  const [options, setOptions] = useState<ImagesToPdfOptions>({ pageSize: "a4", orientation: "auto", margin: "none", output: "single" });

  const set = <K extends keyof ImagesToPdfOptions>(key: K, value: ImagesToPdfOptions[K]) => setOptions((current) => ({ ...current, [key]: value }));
  const reset = () => {
    job.reset();
    images.clear();
  };

  const rows: FileRowModel[] = images.items.map((item) => ({
    id: item.id,
    name: item.name,
    subtitle: <span>{formatBytes(item.size)}</span>,
    status: item.status === "invalid" ? { tone: "error", text: item.message ?? "Cannot be used" } : item.status === "reading" ? { tone: "muted", text: "Reading…" } : undefined,
    thumb:
      item.status === "ready" && item.previewUrl ? (
        <img src={item.previewUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={(event) => (event.currentTarget.style.display = "none")} />
      ) : item.status === "invalid" ? (
        <Icon name="alert" size={22} />
      ) : (
        <span className="spinner" aria-hidden="true" />
      ),
  }));

  const create = () =>
    job.run(async ({ signal, onProgress }) => {
      const inputs = images.ready.map((item) => ({ name: item.name, bytes: item.bytes as Uint8Array }));
      const files = await runOperation("imagesToPdf", { images: inputs, ...options }, { signal, onProgress });
      return { files, count: inputs.length };
    });

  const canCreate = images.ready.length > 0 && !images.busy && images.items.every((item) => item.status === "ready");

  return (
    <JobView
      job={job}
      title="Creating your PDF…"
      renderResult={(result) => (
        <ResultPanel
          title={result.files.length === 1 ? "Your PDF is ready" : `Your ${result.files.length} PDFs are ready`}
          subtitle={`${plural(result.count, "image")} converted.`}
          files={result.files}
          stats={[
            { label: result.files.length === 1 ? "Pages" : "Files", value: String(result.files.length === 1 ? (result.files[0]?.pageCount ?? "—") : result.files.length) },
            { label: "Total size", value: formatBytes(result.files.reduce((sum, file) => sum + file.bytes.length, 0)) },
          ]}
          zipName="images-as-pdf.zip"
          onReset={reset}
          onBack={job.reset}
          nextTools={["compress", "merge", "organize", "protect"]}
        />
      )}
    >
      {images.items.length === 0 ? (
        <Dropzone extensions={tool.accept} multiple pickLabel={tool.pickLabel} onFiles={images.addFiles} rejections={images.rejections} onDismissRejections={images.clearRejections} note={<LocalNote />} />
      ) : (
        <div className="tool-layout tool-layout--side">
          <div className="tool-layout__main">
            <FileList rows={rows} onMove={images.move} onRemove={images.remove} label="Images, in page order" />
            <Dropzone compact extensions={tool.accept} multiple pickLabel={tool.pickLabel} onFiles={images.addFiles} rejections={images.rejections} onDismissRejections={images.clearRejections} />
          </div>
          <aside className="tool-layout__side">
            <Panel title="Page layout">
              <Field label="Page size">
                {({ id }) => (
                  <select id={id} className="select" value={options.pageSize} onChange={(event) => set("pageSize", event.target.value as PageSizeOption)} data-testid="page-size">
                    {PAGE_SIZES.map((size) => (
                      <option key={size.value} value={size.value}>
                        {size.label}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {options.pageSize !== "fit" && (
                <Segmented<Orientation>
                  name="orientation"
                  legend="Orientation"
                  value={options.orientation}
                  onChange={(value) => set("orientation", value)}
                  options={[
                    { value: "auto", label: "Automatic" },
                    { value: "portrait", label: "Portrait" },
                    { value: "landscape", label: "Landscape" },
                  ]}
                />
              )}
              <Segmented<MarginOption>
                name="margin"
                legend="Margin"
                value={options.margin}
                onChange={(value) => set("margin", value)}
                options={[
                  { value: "none", label: "None" },
                  { value: "small", label: "Small" },
                  { value: "large", label: "Large" },
                ]}
              />
              <Segmented<ImagesToPdfOptions["output"]>
                name="output"
                legend="Output"
                value={options.output}
                onChange={(value) => set("output", value)}
                options={[
                  { value: "single", label: "One PDF" },
                  { value: "separate", label: "One PDF per image" },
                ]}
              />
              <p className="panel__note">
                JPEG images are embedded as they are, without losing quality. Photos taken sideways are turned upright.
              </p>
              {images.items.some((item) => item.status === "invalid") && <Alert tone="warning">Remove the images that cannot be used before creating the PDF.</Alert>}
              <div className="action-bar">
                <button type="button" className="btn btn--primary btn--lg" disabled={!canCreate} onClick={create} data-testid="run-button">
                  <Icon name="image" size={22} />
                  Create PDF
                </button>
                <div className="action-bar__row">
                  <button type="button" className="btn btn--ghost btn--sm" onClick={images.clear}>
                    Remove all
                  </button>
                </div>
              </div>
            </Panel>
          </aside>
        </div>
      )}
    </JobView>
  );
}
