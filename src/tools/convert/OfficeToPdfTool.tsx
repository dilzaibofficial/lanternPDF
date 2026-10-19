import { useEffect, useRef, useState } from "react";
import { Dropzone } from "../../components/files/Dropzone";
import { FileList } from "../../components/files/FileList";
import { type ResultRow, ResultTable } from "../../components/tool/ResultTable";
import { Alert, ErrorAlert } from "../../components/ui/Alerts";
import { Checkbox, ChoiceCards, Segmented } from "../../components/ui/Field";
import { Icon } from "../../components/ui/Icon";
import { Panel } from "../../components/tool/Panel";
import { ProcessPanel } from "../../components/tool/ProcessPanel";
import { ResultPanel } from "../../components/tool/ResultPanel";
import { ServerNotice } from "../../components/tool/ServerNotice";
import { LIMITS } from "../../config/limits";
import { useCapabilities, useEngineAvailable } from "../../hooks/useCapabilities";
import { type DocItem, useDocFiles } from "../../hooks/useDocFiles";
import { useJob } from "../../hooks/useJob";
import { AppError, toAppError } from "../../lib/errors";
import { convertOfficeToPdf } from "../../lib/api";
import { baseName, formatBytes, plural, uniqueName } from "../../lib/format";
import { MIME, type OutputFile } from "../../lib/pdf/types";
import { runOperation } from "../../lib/worker/client";
import type { ToolProps } from "../types";

interface Outcome {
  source: string;
  output?: OutputFile;
  error?: string;
  /** What could not be reproduced, in plain sentences. */
  notes?: string[];
}

type Kind = "docx" | "xlsx" | "pptx";
type Mode = "device" | "server";
type Orientation = "auto" | "portrait" | "landscape";

const KIND_OF: Record<string, Kind> = { "word-to-pdf": "docx", "excel-to-pdf": "xlsx", "powerpoint-to-pdf": "pptx" };

/** The file types the converters that run on this device can read. */
const DEVICE_EXTENSIONS: Record<Kind, readonly string[]> = {
  docx: [".docx", ".docm", ".dotx"],
  xlsx: [".xlsx", ".xlsm", ".csv"],
  pptx: [".pptx", ".pptm"],
};

/** Which kinds can be converted on this device. */
const DEVICE_READY: Record<Kind, boolean> = { docx: true, xlsx: true, pptx: true };

const KIND_NAME: Record<Kind, string> = { docx: "Word", xlsx: "Excel", pptx: "PowerPoint" };

/**
 * Word, Excel and PowerPoint to PDF. By default the file is converted right here in the browser tab. The optional
 * LibreOffice mode sends it to the self-hosted server instead, which can keep more of an unusual layout.
 */
export default function OfficeToPdfTool({ tool }: ToolProps) {
  const kind = KIND_OF[tool.id] ?? "docx";
  const deviceReady = DEVICE_READY[kind];
  const available = useEngineAvailable("libreoffice");
  const capabilities = useCapabilities();
  const serverUsable = available === true;
  const [mode, setMode] = useState<Mode>(deviceReady ? "device" : "server");
  const [fitWidth, setFitWidth] = useState(true);
  const [orientation, setOrientation] = useState<Orientation>("auto");
  const serverLimit = capabilities.status === "ready" ? capabilities.capabilities.limits.maxUploadBytes : undefined;
  const onDevice = mode === "device" && deviceReady;
  const files = useDocFiles({
    extensions: onDevice ? DEVICE_EXTENSIONS[kind] : tool.accept,
    label: tool.pickLabel,
    maxBytes: !onDevice && serverLimit ? Math.min(serverLimit, LIMITS.maxFileBytes) : LIMITS.maxFileBytes,
  });
  const job = useJob<Outcome[]>();
  const heading = useRef<HTMLHeadingElement>(null);
  const finished = job.state.phase === "done";
  useEffect(() => {
    if (finished) heading.current?.focus();
  }, [finished]);

  const allReady = files.items.length > 0 && files.items.every((item) => item.status === "ready");

  const convert = () =>
    job.run(async ({ signal, onProgress }) => {
      const targets = files.ready as (DocItem & { bytes: Uint8Array })[];
      const taken: string[] = [];
      const outcomes: Outcome[] = [];
      for (const [index, item] of targets.entries()) {
        const share = (fraction: number, message?: string) => onProgress((index + fraction) / targets.length, targets.length > 1 ? `File ${index + 1} of ${targets.length}: ${message ?? item.name}` : message);
        try {
          let bytes: Uint8Array;
          let notes: string[] | undefined;
          if (onDevice) {
            const result = await runOperation(
              "officeToPdf",
              { name: item.name, bytes: item.bytes, options: kind === "xlsx" ? { fitWidth, orientation } : undefined },
              { signal, onProgress: (fraction, message) => share(fraction * 0.9, message) },
            );
            bytes = result.bytes;
            notes = result.warnings.length > 0 ? result.warnings : undefined;
          } else {
            bytes = await convertOfficeToPdf({ name: item.name, bytes: item.bytes }, { signal, onProgress: (fraction, message) => share(fraction * 0.9, message) });
          }
          share(0.92, "Checking the PDF");
          // Whatever came back is only offered when it really opens as a PDF.
          const probe = await runOperation("probe", { bytes }, { signal });
          if (probe.state !== "ok" || !probe.pageCount) throw new AppError("VERIFICATION_FAILED", onDevice ? "The converted file is not a readable PDF, so it was discarded." : "The server returned something that is not a readable PDF, so it was discarded.");
          const name = uniqueName(`${baseName(item.name)}.pdf`, taken);
          taken.push(name);
          outcomes.push({ source: item.name, output: { name, bytes, mime: MIME.pdf, pageCount: probe.pageCount }, notes });
        } catch (error) {
          const failure = toAppError(error);
          if (failure.code === "CANCELLED") throw failure;
          outcomes.push({ source: item.name, error: failure.message });
        }
      }
      return outcomes;
    });

  const startOver = () => {
    job.reset();
    files.clear();
  };

  // The server mode needs the server; say so before a file is chosen.
  if (!onDevice && available !== true && files.items.length === 0 && mode === "server") {
    return <ServerNotice engine="libreoffice" what={`${tool.name} conversion`} />;
  }

  if (job.state.phase === "running") {
    return <ProcessPanel title="Converting…" fraction={job.state.fraction} message={job.state.message} onCancel={job.cancel} />;
  }

  if (job.state.phase === "done") {
    const outcomes = job.state.result;
    const made = outcomes.filter((outcome): outcome is Outcome & { output: OutputFile } => outcome.output !== undefined);
    const rows: ResultRow[] = outcomes.map((outcome) => ({ source: outcome.source, output: outcome.output && { name: outcome.output.name, size: outcome.output.bytes.length }, error: outcome.error, notes: outcome.notes }));
    const failures = outcomes.length - made.length;
    const withNotes = outcomes.filter((outcome) => outcome.notes && outcome.notes.length > 0).length;
    const table = <ResultTable rows={rows} caption={outcomes.length === 1 ? "Result" : "Result per file"} />;
    if (made.length === 0) {
      return (
        <div className="result" data-testid="result-panel">
          <div className="result__head">
            <span className="result__check" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
              <Icon name="alert" size={28} strokeWidth={2.5} />
            </span>
            <div>
              <h2 className="result__title" ref={heading} tabIndex={-1}>
                {outcomes.length === 1 ? "The file could not be converted" : "None of the files could be converted"}
              </h2>
              <p className="result__sub">Nothing was produced. The reason for each file is below.</p>
            </div>
          </div>
          {table}
          <div className="result__actions">
            <button type="button" className="btn btn--primary btn--lg" onClick={job.reset}>
              Back to the files
            </button>
            <button type="button" className="btn btn--ghost btn--lg" onClick={startOver}>
              Start over
            </button>
          </div>
        </div>
      );
    }
    return (
      <ResultPanel
        title={made.length === 1 ? "Your PDF is ready" : `${made.length} PDFs are ready`}
        subtitle={onDevice ? "Converted on this device. Your file never left it." : "Converted by LibreOffice on your server. The uploaded files were deleted there as soon as the conversion finished."}
        files={made.map((outcome) => outcome.output)}
        stats={[
          { label: "Converted", value: String(made.length) },
          { label: "Pages in total", value: String(made.reduce((sum, outcome) => sum + (outcome.output.pageCount ?? 0), 0)) },
          { label: "Size", value: formatBytes(made.reduce((sum, outcome) => sum + outcome.output.bytes.length, 0)) },
        ]}
        notes={
          <>
            {failures > 0 && (
              <Alert tone="warning" title={`${plural(failures, "file")} could not be converted`}>
                <p>The others finished. The reason for each file is in the table.</p>
              </Alert>
            )}
            {withNotes > 0 && (
              <Alert tone="warning" title="Some parts could not be reproduced" testId="conversion-notes">
                <p>
                  {withNotes === 1 ? "One file contains" : `${withNotes} files contain`} things this converter cannot draw. Open “What was done” in the table to see exactly what was left out, and check the PDF before you send it. For difficult
                  layouts, the LibreOffice mode on a server you run can do more.
                </p>
              </Alert>
            )}
            {table}
          </>
        }
        zipName="converted-pdfs.zip"
        onReset={startOver}
        onBack={job.reset}
        nextTools={["merge", "compress", "protect"]}
      />
    );
  }

  if (files.items.length === 0) {
    return (
      <div className="stack">
        {deviceReady && (
          <ChoiceCards<Mode>
            name="convert-mode"
            legend="How to convert"
            value={mode}
            onChange={setMode}
            options={[
              {
                value: "device",
                title: "On this device",
                tag: "Private",
                testId: "mode-device",
                description: `Converts ${KIND_NAME[kind]} files right here in your browser. Nothing is uploaded. Pictures, tables, lists, headers and footers are kept; features it cannot draw are listed after the conversion.`,
              },
              {
                value: "server",
                title: "LibreOffice on your server",
                testId: "mode-server",
                disabled: !serverUsable,
                description: serverUsable
                  ? "Uses LibreOffice on the server you run. The file is uploaded to your server and deleted right after. Accepts older .doc, .xls and OpenDocument files too."
                  : capabilities.status === "ready"
                    ? "Not available: LibreOffice is not installed on the server."
                    : capabilities.status === "unavailable"
                      ? "Not available: this site is not connected to a conversion server."
                      : "Checking whether the server has LibreOffice…",
              },
            ]}
          />
        )}
        <Dropzone
          extensions={onDevice ? DEVICE_EXTENSIONS[kind] : tool.accept}
          multiple
          pickLabel={tool.pickLabel}
          onFiles={files.addFiles}
          rejections={files.rejections}
          onDismissRejections={files.clearRejections}
          note={
            onDevice ? (
              <>
                <Icon name="shield" size={16} />
                Converted on this device. Your files are never uploaded.
              </>
            ) : (
              <>
                <Icon name="server" size={16} />
                Sent to the server you run, converted, and deleted as soon as it is done.
              </>
            )
          }
        />
      </div>
    );
  }

  return (
    <div className="tool-layout tool-layout--side">
      <div className="tool-layout__main">
        {job.state.phase === "error" && <ErrorAlert error={job.state.error} onDismiss={job.reset} />}
        <FileList
          label="Files to convert"
          sortable={false}
          onMove={files.move}
          onRemove={files.remove}
          rows={files.items.map((item) => ({
            id: item.id,
            name: item.name,
            thumb: <Icon name={tool.icon} size={26} />,
            subtitle: <span>{formatBytes(item.size)}</span>,
            status: item.status === "reading" ? { tone: "muted", text: "Reading…" } : item.status === "invalid" ? { tone: "error", text: item.message ?? "This file cannot be used." } : undefined,
          }))}
        />
        <Dropzone compact extensions={onDevice ? DEVICE_EXTENSIONS[kind] : tool.accept} multiple pickLabel={tool.pickLabel} onFiles={files.addFiles} rejections={files.rejections} onDismissRejections={files.clearRejections} />
      </div>
      <aside className="tool-layout__side">
        <Panel title="Convert to PDF">
          <p className="panel__note" data-testid="convert-summary">
            {plural(files.items.length, "file")} · {formatBytes(files.items.reduce((sum, item) => sum + item.size, 0))}
          </p>
          {onDevice ? (
            <p className="panel__note">The files are converted in this browser tab. Nothing is uploaded anywhere.</p>
          ) : (
            <p className="panel__note">The files are uploaded to the server you run, converted with LibreOffice, and deleted from it right after. Nothing goes to any other service.</p>
          )}
          {onDevice && kind === "xlsx" && (
            <>
              <Checkbox checked={fitWidth} onChange={setFitWidth} label="Fit wide sheets to the page width" hint="Shrinks a sheet that is wider than the page (never below half size) so its columns are not split across pages." />
              <Segmented<Orientation>
                name="sheet-orientation"
                legend="Page orientation"
                value={orientation}
                onChange={setOrientation}
                options={[
                  { value: "auto", label: "Automatic" },
                  { value: "portrait", label: "Portrait" },
                  { value: "landscape", label: "Landscape" },
                ]}
              />
            </>
          )}
          {files.items.length > 0 && !allReady && !files.busy && <Alert tone="warning">Remove the files that have a problem before converting.</Alert>}
          <div className="action-bar">
            <button type="button" className="btn btn--primary btn--lg" disabled={!allReady || files.busy} onClick={convert} data-testid="convert-button">
              <Icon name={onDevice ? tool.icon : "server"} size={22} />
              {files.items.length > 1 ? `Convert ${files.items.length} files` : "Convert to PDF"}
            </button>
            <div className="action-bar__row">
              <button type="button" className="btn btn--ghost btn--sm" onClick={files.clear}>
                Remove all
              </button>
            </div>
          </div>
        </Panel>
      </aside>
    </div>
  );
}
