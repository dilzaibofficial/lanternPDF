import { useRef, useEffect } from "react";
import { Dropzone } from "../../components/files/Dropzone";
import { FileList } from "../../components/files/FileList";
import { type ResultRow, ResultTable } from "../../components/tool/ResultTable";
import { Alert, ErrorAlert } from "../../components/ui/Alerts";
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
}

/** Word, Excel and PowerPoint to PDF: the file goes to the self-hosted server, LibreOffice converts it, and the PDF is checked on return. */
export default function OfficeToPdfTool({ tool }: ToolProps) {
  const available = useEngineAvailable("libreoffice");
  const capabilities = useCapabilities();
  const serverLimit = capabilities.status === "ready" ? capabilities.capabilities.limits.maxUploadBytes : undefined;
  const files = useDocFiles({ extensions: tool.accept, label: tool.pickLabel, maxBytes: serverLimit ? Math.min(serverLimit, LIMITS.maxFileBytes) : LIMITS.maxFileBytes });
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
          const bytes = await convertOfficeToPdf({ name: item.name, bytes: item.bytes }, { signal, onProgress: (fraction, message) => share(fraction * 0.9, message) });
          share(0.92, "Checking the PDF");
          // Whatever came back is only offered when it really opens as a PDF.
          const probe = await runOperation("probe", { bytes }, { signal });
          if (probe.state !== "ok" || !probe.pageCount) throw new AppError("VERIFICATION_FAILED", "The server returned something that is not a readable PDF, so it was discarded.");
          const name = uniqueName(`${baseName(item.name)}.pdf`, taken);
          taken.push(name);
          outcomes.push({ source: item.name, output: { name, bytes, mime: MIME.pdf, pageCount: probe.pageCount } });
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

  if (available !== true) {
    return <ServerNotice engine="libreoffice" what={`${tool.name} conversion`} />;
  }

  if (job.state.phase === "running") {
    return <ProcessPanel title="Converting…" fraction={job.state.fraction} message={job.state.message} onCancel={job.cancel} />;
  }

  if (job.state.phase === "done") {
    const outcomes = job.state.result;
    const made = outcomes.filter((outcome): outcome is Outcome & { output: OutputFile } => outcome.output !== undefined);
    const rows: ResultRow[] = outcomes.map((outcome) => ({ source: outcome.source, output: outcome.output && { name: outcome.output.name, size: outcome.output.bytes.length }, error: outcome.error }));
    const failures = outcomes.length - made.length;
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
        subtitle="Converted by LibreOffice on your server. The uploaded files were deleted there as soon as the conversion finished."
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
      <Dropzone
        extensions={tool.accept}
        multiple
        pickLabel={tool.pickLabel}
        onFiles={files.addFiles}
        rejections={files.rejections}
        onDismissRejections={files.clearRejections}
        note={
          <>
            <Icon name="server" size={16} />
            Sent to the server you run, converted, and deleted as soon as it is done.
          </>
        }
      />
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
        <Dropzone compact extensions={tool.accept} multiple pickLabel={tool.pickLabel} onFiles={files.addFiles} rejections={files.rejections} onDismissRejections={files.clearRejections} />
      </div>
      <aside className="tool-layout__side">
        <Panel title="Convert to PDF">
          <p className="panel__note" data-testid="convert-summary">
            {plural(files.items.length, "file")} · {formatBytes(files.items.reduce((sum, item) => sum + item.size, 0))}
          </p>
          <p className="panel__note">The files are uploaded to the server you run, converted with LibreOffice, and deleted from it right after. Nothing goes to any other service.</p>
          {files.items.length > 0 && !allReady && !files.busy && <Alert tone="warning">Remove the files that have a problem before converting.</Alert>}
          <div className="action-bar">
            <button type="button" className="btn btn--primary btn--lg" disabled={!allReady || files.busy} onClick={convert} data-testid="convert-button">
              <Icon name="server" size={22} />
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
