import { Dropzone } from "../../components/files/Dropzone";
import { PdfFileList } from "../../components/files/PdfFileList";
import { Alert } from "../../components/ui/Alerts";
import { Icon } from "../../components/ui/Icon";
import { JobView } from "../../components/tool/JobView";
import { LocalNote, Panel } from "../../components/tool/Panel";
import { ResultPanel } from "../../components/tool/ResultPanel";
import { useAcceptHandoff } from "../../hooks/useHandoff";
import { useJob } from "../../hooks/useJob";
import { toPdfInput, usePdfFiles } from "../../hooks/usePdfFiles";
import { formatBytes } from "../../lib/format";
import type { RepairResult } from "../../lib/pdf/repair";
import { runOperation } from "../../lib/worker/client";
import type { ToolProps } from "../types";

export default function RepairTool({ tool }: ToolProps) {
  const files = usePdfFiles({ multiple: false });
  useAcceptHandoff(files.addBytes);
  const job = useJob<RepairResult>();
  const item = files.items[0];

  // A damaged PDF is exactly what this tool is for, so it is accepted even though it cannot be opened.
  const usable = item && item.bytes !== null && (item.status === "damaged" || item.status === "ready");
  const damaged = item?.status === "damaged";

  const repair = () => {
    if (!item || !item.bytes) return;
    void job.run(({ signal, onProgress }) => runOperation("repair", { input: toPdfInput(item) }, { signal, onProgress }));
  };

  return (
    <JobView
      job={job}
      title="Repairing your PDF…"
      renderResult={(result) => (
        <ResultPanel
          title="Your repaired PDF is ready"
          subtitle={`${result.file.pageCount} ${result.file.pageCount === 1 ? "page" : "pages"} recovered.`}
          files={[result.file]}
          stats={[
            { label: "Pages", value: String(result.file.pageCount ?? "—") },
            { label: "Size", value: formatBytes(result.file.bytes.length) },
            { label: "Method", value: result.method === "rebuild" ? "Index rebuilt" : "Rewritten" },
          ]}
          notes={
            <Alert tone={result.method === "rebuild" ? "warning" : "success"} title={result.method === "rebuild" ? "Check the result" : "All good"}>
              {result.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </Alert>
          }
          onReset={() => {
            job.reset();
            files.clear();
          }}
          onBack={job.reset}
          nextTools={["compress", "merge", "organize"]}
        />
      )}
    >
      {!item ? (
        <Dropzone extensions={tool.accept} multiple={false} pickLabel={tool.pickLabel} onFiles={files.addFiles} rejections={files.rejections} onDismissRejections={files.clearRejections} note={<LocalNote />} />
      ) : (
        <div className="tool-layout tool-layout--side">
          <div className="tool-layout__main">
            <PdfFileList items={[item]} onMove={files.move} onRemove={files.remove} onUnlock={files.unlock} onReplace={files.replace} sortable={false} offerRepair={false} label="Selected PDF" />
            {usable && damaged && (
              <Alert tone="warning" title="This file cannot be read as it is">
                <p>Repair rebuilds the file’s internal index so its pages can be found again.</p>
              </Alert>
            )}
            {usable && !damaged && (
              <Alert tone="success" title="This PDF opens normally">
                <p>No problem was found. You can still run the repair to rewrite the file cleanly.</p>
              </Alert>
            )}
          </div>
          <aside className="tool-layout__side">
            <Panel title="Repair">
              <p className="panel__note">
                Repair recovers what it can find. Content that is physically missing from a truncated file cannot be restored, so review the result.
              </p>
              <div className="action-bar">
                <button type="button" className="btn btn--primary btn--lg" disabled={!usable} onClick={repair} data-testid="run-button">
                  <Icon name="wrench" size={22} />
                  Repair PDF
                </button>
              </div>
            </Panel>
          </aside>
        </div>
      )}
    </JobView>
  );
}
