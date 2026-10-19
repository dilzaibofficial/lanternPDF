import { Dropzone } from "../../components/files/Dropzone";
import { PdfFileList } from "../../components/files/PdfFileList";
import { Alert, ErrorAlert } from "../../components/ui/Alerts";
import { Icon } from "../../components/ui/Icon";
import { LocalNote, Panel } from "../../components/tool/Panel";
import { ProcessPanel } from "../../components/tool/ProcessPanel";
import { ResultPanel } from "../../components/tool/ResultPanel";
import { useAcceptHandoff } from "../../hooks/useHandoff";
import { useJob } from "../../hooks/useJob";
import { toPdfInput, usePdfFiles } from "../../hooks/usePdfFiles";
import { formatBytes, plural } from "../../lib/format";
import type { OutputFile } from "../../lib/pdf/types";
import { runOperation } from "../../lib/worker/client";
import type { ToolProps } from "../types";

interface MergeResult {
  file: OutputFile;
  sources: number;
  inputBytes: number;
}

export default function MergeTool({ tool }: ToolProps) {
  const files = usePdfFiles({ multiple: true });
  useAcceptHandoff(files.addBytes);
  const job = useJob<MergeResult>();

  const allReady = files.items.length > 0 && files.items.every((item) => item.status === "ready");
  const canMerge = files.ready.length >= 2 && allReady;
  const totalPages = files.ready.reduce((sum, item) => sum + (item.pageCount ?? 0), 0);
  const totalBytes = files.ready.reduce((sum, item) => sum + item.size, 0);
  const anyUnlocked = files.ready.some((item) => item.password);

  const merge = () =>
    job.run(async ({ signal, onProgress }) => {
      const inputs = files.ready.map(toPdfInput);
      const file = await runOperation("merge", { inputs }, { signal, onProgress });
      return { file, sources: inputs.length, inputBytes: totalBytes };
    });

  const startOver = () => {
    job.reset();
    files.clear();
  };

  if (job.state.phase === "running") {
    return <ProcessPanel title="Merging your PDFs…" fraction={job.state.fraction} message={job.state.message} onCancel={job.cancel} />;
  }

  if (job.state.phase === "done") {
    const { file, sources, inputBytes } = job.state.result;
    return (
      <ResultPanel
        title="Your merged PDF is ready"
        subtitle={`${plural(sources, "file")} combined into one document.`}
        files={[file]}
        stats={[
          { label: "Pages", value: String(file.pageCount ?? "—") },
          { label: "Size", value: formatBytes(file.bytes.length) },
          { label: "Inputs combined", value: formatBytes(inputBytes) },
        ]}
        notes={anyUnlocked ? <Alert tone="info">The merged PDF is not password-protected. Use Protect PDF to add a password.</Alert> : undefined}
        onReset={startOver}
        onBack={job.reset}
        nextTools={["compress", "organize", "page-numbers", "protect"]}
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
        note={<LocalNote />}
      />
    );
  }

  return (
    <div className="tool-layout tool-layout--side">
      <div className="tool-layout__main">
        {job.state.phase === "error" && <ErrorAlert error={job.state.error} onDismiss={job.reset} />}
        <PdfFileList items={files.items} onMove={files.move} onRemove={files.remove} onUnlock={files.unlock} onReplace={files.replace} label="PDFs to merge, in order" />
        <Dropzone
          compact
          extensions={tool.accept}
          multiple
          pickLabel={tool.pickLabel}
          onFiles={files.addFiles}
          rejections={files.rejections}
          onDismissRejections={files.clearRejections}
        />
      </div>

      <aside className="tool-layout__side">
        <Panel title="Merge">
          <p className="panel__note" data-testid="merge-summary">
            {plural(files.items.length, "file")}
            {totalPages > 0 && ` · ${plural(totalPages, "page")}`} · {formatBytes(totalBytes)}
          </p>
          <p className="panel__note">PDFs are joined in the order shown. Drag them, or use the arrows, to change it.</p>
          {files.ready.length < 2 && <Alert tone="info">Add at least two PDFs to merge.</Alert>}
          {files.items.length > 0 && !allReady && !files.busy && (
            <Alert tone="warning">Open, repair or remove the files that have a problem before merging.</Alert>
          )}
          <div className="action-bar">
            <button type="button" className="btn btn--primary btn--lg" disabled={!canMerge} onClick={merge} data-testid="merge-button">
              <Icon name="merge" size={22} />
              Merge PDFs
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
