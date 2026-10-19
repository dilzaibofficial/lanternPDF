import { useEffect, useRef, useState } from "react";
import { Dropzone } from "../../components/files/Dropzone";
import { PdfFileList } from "../../components/files/PdfFileList";
import { type ResultRow, ResultTable } from "../../components/tool/ResultTable";
import { Alert, ErrorAlert } from "../../components/ui/Alerts";
import { Checkbox, ChoiceCards, Segmented } from "../../components/ui/Field";
import { Icon, type IconName } from "../../components/ui/Icon";
import { LocalNote, Panel } from "../../components/tool/Panel";
import { ProcessPanel } from "../../components/tool/ProcessPanel";
import { ResultPanel } from "../../components/tool/ResultPanel";
import { useAcceptHandoff } from "../../hooks/useHandoff";
import { useCapabilities } from "../../hooks/useCapabilities";
import { useJob } from "../../hooks/useJob";
import { type PdfItem, toPdfSource, usePdfFiles } from "../../hooks/usePdfFiles";
import { convertPdfToOffice } from "../../lib/api";
import { checkOfficeFile, pdfToDocx, pdfToPptx, pdfToXlsx } from "../../lib/convert/convert";
import { toAppError } from "../../lib/errors";
import { baseName, formatBytes, plural, uniqueName } from "../../lib/format";
import { acquireDocument, renderPageToBlob } from "../../lib/pdf/pdfjs";
import { MIME, type OutputFile } from "../../lib/pdf/types";
import type { ToolProps } from "../types";

type Kind = "docx" | "xlsx" | "pptx";
type Mode = "device" | "server";
type Progress = (fraction: number, message?: string) => void;

const KIND: Record<string, Kind> = { "pdf-to-word": "docx", "pdf-to-excel": "xlsx", "pdf-to-powerpoint": "pptx" };
const NOUN: Record<Kind, string> = { docx: "Word document", xlsx: "Excel spreadsheet", pptx: "PowerPoint presentation" };
const MIME_OF: Record<Kind, string> = { docx: MIME.docx, xlsx: MIME.xlsx, pptx: MIME.pptx };
const ICON: Record<Kind, IconName> = { docx: "word", xlsx: "excel", pptx: "powerpoint" };

interface Options {
  mode: Mode;
  /** Excel */
  layout: "per-page" | "single";
  numbers: boolean;
  /** PowerPoint, on this device: the resolution of the page pictures. */
  dpi: 100 | 150 | 200;
}

interface Outcome {
  source: string;
  output?: OutputFile;
  notes: string[];
  error?: string;
}

async function convertOnDevice(item: PdfItem, kind: Kind, options: Options, progress: Progress, signal: AbortSignal) {
  const lease = acquireDocument(toPdfSource(item));
  try {
    const doc = await lease.promise;
    const context = { signal, onProgress: progress };
    if (kind === "docx") return await pdfToDocx(doc, item.name, context);
    if (kind === "xlsx") return await pdfToXlsx(doc, item.name, { layout: options.layout, numbers: options.numbers }, context);
    return await pdfToPptx(
      doc,
      item.name,
      async (number) => {
        const page = await doc.getPage(number);
        const view = page.getViewport({ scale: 1 });
        const blob = await renderPageToBlob(page, { dpi: options.dpi, format: "jpeg", quality: 0.85, signal });
        page.cleanup();
        return { jpeg: new Uint8Array(await blob.arrayBuffer()), width: view.width, height: view.height };
      },
      context,
    );
  } finally {
    lease.release();
  }
}

async function convertOnServer(item: PdfItem, kind: "docx" | "pptx", progress: Progress, signal: AbortSignal) {
  const bytes = await convertPdfToOffice({ name: item.name, bytes: item.bytes as Uint8Array }, kind, { signal, onProgress: progress });
  checkOfficeFile(bytes, kind, item.name);
  return {
    file: { name: `${baseName(item.name)}.${kind}`, bytes, mime: MIME_OF[kind] } satisfies OutputFile,
    pages: item.pageCount ?? 0,
    notes: [`Converted by LibreOffice on your server, which keeps more of the original layout. The PDF was deleted from the server right after.`, "Check the result in Word or PowerPoint: complicated pages may still differ from the PDF."],
  };
}

export default function PdfToOfficeTool({ tool }: ToolProps) {
  const kind = KIND[tool.id] ?? "docx";
  const files = usePdfFiles({ multiple: true });
  useAcceptHandoff(files.addBytes);
  const job = useJob<Outcome[]>();
  // Only Word and PowerPoint have a server mode, so only they ask the server what it can do.
  const capabilities = useCapabilities(kind !== "xlsx");
  const [options, setOptions] = useState<Options>({ mode: "device", layout: "per-page", numbers: true, dpi: 150 });
  const heading = useRef<HTMLHeadingElement>(null);
  const finished = job.state.phase === "done";
  useEffect(() => {
    if (finished) heading.current?.focus();
  }, [finished]);

  const set = <K extends keyof Options>(key: K, value: Options[K]) => setOptions((current) => ({ ...current, [key]: value }));
  const allReady = files.items.length > 0 && files.items.every((item) => item.status === "ready");
  const needsPassword = files.ready.some((item) => item.encrypted && item.password);
  const libre = capabilities.status === "ready" ? capabilities.capabilities.engines.libreoffice : undefined;
  const serverOffered = kind !== "xlsx"; // layout-preserving conversion exists for Word and PowerPoint
  const serverUsable = Boolean(libre?.available) && !needsPassword;
  const mode: Mode = serverOffered && options.mode === "server" && serverUsable ? "server" : "device";

  const convert = () =>
    job.run(async ({ signal, onProgress }) => {
      const targets = files.ready;
      const taken: string[] = [];
      const outcomes: Outcome[] = [];
      for (const [index, item] of targets.entries()) {
        const progress: Progress = (fraction, message) => onProgress((index + fraction) / targets.length, targets.length > 1 ? `File ${index + 1} of ${targets.length}: ${message ?? item.name}` : message);
        try {
          const result = mode === "server" && kind !== "xlsx" ? await convertOnServer(item, kind, progress, signal) : await convertOnDevice(item, kind, options, progress, signal);
          const name = uniqueName(result.file.name, taken);
          taken.push(name);
          outcomes.push({ source: item.name, output: { ...result.file, name }, notes: result.notes });
        } catch (error) {
          const failure = toAppError(error);
          if (failure.code === "CANCELLED") throw failure;
          outcomes.push({ source: item.name, notes: [], error: failure.message });
        }
      }
      return outcomes;
    });

  const startOver = () => {
    job.reset();
    files.clear();
  };

  if (job.state.phase === "running") {
    return <ProcessPanel title={`Making your ${NOUN[kind].toLowerCase()}…`} fraction={job.state.fraction} message={job.state.message} onCancel={job.cancel} />;
  }

  if (job.state.phase === "done") {
    const outcomes = job.state.result;
    const made = outcomes.filter((outcome): outcome is Outcome & { output: OutputFile } => outcome.output !== undefined);
    const failures = outcomes.length - made.length;
    const rows: ResultRow[] = outcomes.map((outcome) => ({ source: outcome.source, output: outcome.output && { name: outcome.output.name, size: outcome.output.bytes.length }, error: outcome.error, notes: outcome.notes }));
    const table = <ResultTable rows={rows} caption={outcomes.length === 1 ? "Result" : "Result per file"} />;

    if (made.length === 0) {
      return (
        <div className="result" data-testid="result-panel">
          <div className="result__head">
            <span className="result__check" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
              <Icon name="alert" size={28} strokeWidth={2.5} />
            </span>
            <div>
              <h2 className="result__title" ref={heading} tabIndex={-1} data-testid="convert-failed">
                {outcomes.length === 1 ? `This PDF could not be turned into a ${NOUN[kind].toLowerCase()}` : "None of these PDFs could be converted"}
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
        title={made.length === 1 ? `Your ${NOUN[kind].toLowerCase()} is ready` : `${made.length} ${NOUN[kind].toLowerCase()}s are ready`}
        subtitle={mode === "server" ? "Converted with LibreOffice on your server." : "Made on this device. The PDF never left it."}
        files={made.map((outcome) => outcome.output)}
        stats={[
          { label: "Converted", value: String(made.length) },
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
        noPreview
        zipName={`converted-${kind}-files.zip`}
        onReset={startOver}
        onBack={job.reset}
        nextTools={tool.related.slice(0, 2)}
      />
    );
  }

  if (files.items.length === 0) {
    return (
      <Dropzone extensions={tool.accept} multiple pickLabel={tool.pickLabel} onFiles={files.addFiles} rejections={files.rejections} onDismissRejections={files.clearRejections} note={<LocalNote />} />
    );
  }

  return (
    <div className="tool-layout tool-layout--side">
      <div className="tool-layout__main">
        {job.state.phase === "error" && <ErrorAlert error={job.state.error} onDismiss={job.reset} />}
        <PdfFileList items={files.items} onMove={files.move} onRemove={files.remove} onUnlock={files.unlock} onReplace={files.replace} sortable={false} label="PDFs to convert" />
        <Dropzone compact extensions={tool.accept} multiple pickLabel={tool.pickLabel} onFiles={files.addFiles} rejections={files.rejections} onDismissRejections={files.clearRejections} />
      </div>

      <aside className="tool-layout__side">
        <Panel title={`Convert to ${NOUN[kind]}`}>
          <p className="panel__note" data-testid="convert-summary">
            {plural(files.items.length, "file")} · {formatBytes(files.items.reduce((sum, item) => sum + item.size, 0))}
          </p>

          {serverOffered && (
            <ChoiceCards<Mode>
              name="convert-mode"
              legend="How to convert"
              value={mode}
              onChange={(next) => set("mode", next)}
              options={[
                {
                  value: "device",
                  title: "On this device",
                  tag: "Private",
                  testId: "mode-device",
                  description:
                    kind === "docx"
                      ? "Rebuilds the text, headings, lists, columns and simple tables from the PDF. Pictures and exact fonts are not carried over. Nothing is uploaded."
                      : "One slide per page, each holding a picture of the page, so it looks exactly like the PDF. The text is in the notes but cannot be edited. Nothing is uploaded.",
                },
                {
                  value: "server",
                  title: "Keep the layout (LibreOffice on your server)",
                  testId: "mode-server",
                  disabled: !serverUsable,
                  description: serverUsable
                    ? "Uses LibreOffice on the server you run to keep more of the layout and make the text editable. The PDF is uploaded to your server and deleted right after."
                    : needsPassword
                      ? "Not available for a PDF you opened with a password: the server cannot open it."
                      : capabilities.status === "ready"
                        ? `Not available: ${libre?.reason ?? "LibreOffice is not installed on the server."}`
                        : capabilities.status === "unavailable"
                          ? "Not available: this site is not connected to a conversion server."
                          : "Checking whether the server has LibreOffice…",
                },
              ]}
            />
          )}

          {kind === "xlsx" && (
            <>
              <Segmented<Options["layout"]>
                name="xlsx-layout"
                legend="Sheets"
                value={options.layout}
                onChange={(value) => set("layout", value)}
                options={[
                  { value: "per-page", label: "One sheet per page" },
                  { value: "single", label: "Everything on one sheet" },
                ]}
              />
              <Checkbox checked={options.numbers} onChange={(value) => set("numbers", value)} label="Store clear numbers as numbers" hint="Such as 1,234.50, 12% or $9.99. Codes with leading zeros, dates and anything ambiguous stay text." />
            </>
          )}

          {kind === "pptx" && mode === "device" && (
            <Segmented<`${Options["dpi"]}`>
              name="pptx-dpi"
              legend="Picture quality"
              value={`${options.dpi}`}
              onChange={(value) => set("dpi", Number(value) as Options["dpi"])}
              options={[
                { value: "100", label: "Smaller file" },
                { value: "150", label: "Balanced" },
                { value: "200", label: "Sharper" },
              ]}
            />
          )}

          {files.items.length > 0 && !allReady && !files.busy && <Alert tone="warning">Open, repair or remove the files that have a problem before converting.</Alert>}
          <div className="action-bar">
            <button type="button" className="btn btn--primary btn--lg" disabled={!allReady || files.busy} onClick={convert} data-testid="convert-button">
              <Icon name={ICON[kind]} size={22} />
              {files.items.length > 1 ? `Convert ${files.items.length} PDFs` : `Convert to ${kind === "docx" ? "Word" : kind === "xlsx" ? "Excel" : "PowerPoint"}`}
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
