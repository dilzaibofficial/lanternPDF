import { useMemo, useState } from "react";
import { PageCard } from "../../components/pdf/PageCard";
import { PageRangeField } from "../../components/pdf/PageRangeField";
import { Alert } from "../../components/ui/Alerts";
import { Checkbox } from "../../components/ui/Field";
import { Icon } from "../../components/ui/Icon";
import { JobView } from "../../components/tool/JobView";
import { Panel } from "../../components/tool/Panel";
import { ResultPanel } from "../../components/tool/ResultPanel";
import { SinglePdfGate } from "../../components/tool/SinglePdfGate";
import { useAcceptHandoff } from "../../hooks/useHandoff";
import { useJob } from "../../hooks/useJob";
import { type PageSelection, usePageSelection } from "../../hooks/usePageSelection";
import { type PdfItem, toPdfInput, toPdfSource, usePdfFiles } from "../../hooks/usePdfFiles";
import { baseName, formatBytes, plural } from "../../lib/format";
import type { OutputFile } from "../../lib/pdf/types";
import { complementPages } from "../../lib/ranges";
import { runOperation } from "../../lib/worker/client";
import type { ToolProps } from "../types";

export type SelectionMode = "extract" | "delete";

interface Result {
  files: OutputFile[];
  sourceName: string;
  pagesBefore: number;
  removed?: number;
}

/**
 * Pick pages by clicking thumbnails or typing ranges. Shared by "Extract pages" (keep the selection)
 * and "Delete pages" (remove the selection).
 */
export function PageSelectionTool({ tool, mode }: ToolProps & { mode: SelectionMode }) {
  const files = usePdfFiles({ multiple: false });
  useAcceptHandoff(files.addBytes);
  const job = useJob<Result>();

  return (
    <JobView
      job={job}
      title={mode === "extract" ? "Extracting pages…" : "Removing pages…"}
      renderResult={(result) => (
        <ResultPanel
          title={result.files.length > 1 ? `Your ${result.files.length} PDFs are ready` : "Your PDF is ready"}
          subtitle={mode === "extract" ? `Pages extracted from ${result.sourceName}.` : `${plural(result.removed ?? 0, "page")} removed from ${result.sourceName}.`}
          files={result.files}
          stats={
            result.files.length === 1
              ? [
                  { label: "Pages", value: String(result.files[0]?.pageCount ?? "—") },
                  { label: "Before", value: `${result.pagesBefore} pages` },
                  { label: "Size", value: formatBytes(result.files[0]?.bytes.length ?? 0) },
                ]
              : [{ label: "Files", value: String(result.files.length) }]
          }
          zipName={`${baseName(result.sourceName)}_pages.zip`}
          onReset={() => {
            job.reset();
            files.clear();
          }}
          onBack={job.reset}
          nextTools={["organize", "compress", "merge", "protect"]}
        />
      )}
    >
      <SinglePdfGate tool={tool} files={files}>
        {(item) => <Workspace item={item} mode={mode} run={(work) => job.run(work)} />}
      </SinglePdfGate>
    </JobView>
  );
}

interface WorkspaceProps {
  item: PdfItem;
  mode: SelectionMode;
  run: (work: (context: { signal: AbortSignal; onProgress: (f: number, m?: string) => void }) => Promise<Result>) => void;
}

function Workspace({ item, mode, run }: WorkspaceProps) {
  const pageCount = item.pageCount ?? 0;
  const selection = usePageSelection(pageCount);
  const [separate, setSeparate] = useState(false);
  const source = useMemo(() => toPdfSource(item), [item]);
  const extract = mode === "extract";
  const remaining = pageCount - selection.pages.length;
  const canRun = selection.pages.length > 0 && !selection.error && (extract || remaining > 0);

  const start = () =>
    run(async ({ signal, onProgress }) => {
      const input = toPdfInput(item);
      const stem = baseName(item.name);
      if (extract && separate) {
        const ranges = selection.pages.map((page) => ({ start: page, end: page }));
        const files = await runOperation("split", { input, plan: { mode: "ranges", ranges } }, { signal, onProgress });
        return { files, sourceName: item.name, pagesBefore: pageCount };
      }
      const pages = extract ? selection.pages : complementPages(selection.pages, pageCount);
      const file = await runOperation(
        "selectPages",
        { input, pages, outputName: extract ? `${stem}_extracted.pdf` : `${stem}_edited.pdf` },
        { signal, onProgress },
      );
      return { files: [file], sourceName: item.name, pagesBefore: pageCount, removed: extract ? undefined : selection.pages.length };
    });

  return (
    <div className="tool-layout tool-layout--side">
      <div className="tool-layout__main">
        <SelectionBar selection={selection} pageCount={pageCount} extract={extract} />
        <ul className="page-grid" aria-label="Pages of the document">
          {Array.from({ length: pageCount }, (_, index) => index + 1).map((page) => (
            <PageCard
              key={page}
              source={source}
              pageNumber={page}
              label={`Page ${page}`}
              state={selection.selected.has(page) ? (extract ? "selected" : "removed") : "normal"}
              onToggle={() => selection.toggle(page)}
            />
          ))}
        </ul>
      </div>

      <aside className="tool-layout__side">
        <Panel title={extract ? "Pages to extract" : "Pages to delete"}>
          <PageRangeField value={selection.text} onChange={selection.setText} pageCount={pageCount} error={selection.error} />
          {extract && (
            <Checkbox checked={separate} onChange={setSeparate} label="Save each page as its own PDF" hint="Downloads a ZIP with one file per selected page." />
          )}
          <p className="panel__note" data-testid="selection-summary" aria-live="polite">
            {selection.pages.length === 0
              ? extract
                ? "Select the pages you want to keep."
                : "Select the pages you want to remove."
              : extract
                ? `${plural(selection.pages.length, "page")} will be saved${separate ? ` as ${plural(selection.pages.length, "separate PDF")}` : " in one new PDF"}.`
                : `${plural(selection.pages.length, "page")} will be removed. ${plural(remaining, "page")} will remain.`}
          </p>
          {!extract && remaining === 0 && selection.pages.length > 0 && <Alert tone="warning">You cannot remove every page. Keep at least one.</Alert>}
          <div className="action-bar">
            <button type="button" className="btn btn--primary btn--lg" disabled={!canRun} onClick={start} data-testid="run-button">
              <Icon name={extract ? "extract" : "trash"} size={22} />
              {extract ? "Extract pages" : "Delete pages"}
            </button>
          </div>
        </Panel>
      </aside>
    </div>
  );
}

function SelectionBar({ selection, pageCount, extract }: { selection: PageSelection; pageCount: number; extract: boolean }) {
  return (
    <div className="selection-bar">
      <span className="selection-bar__count" role="status" aria-live="polite">
        {selection.pages.length} of {pageCount} {extract ? "selected" : "marked for removal"}
      </span>
      <button type="button" className="btn btn--secondary btn--sm" onClick={selection.selectAll}>
        All
      </button>
      <button type="button" className="btn btn--secondary btn--sm" onClick={selection.clear}>
        None
      </button>
      <button type="button" className="btn btn--secondary btn--sm" onClick={selection.invert}>
        Invert
      </button>
      <button type="button" className="btn btn--secondary btn--sm" onClick={selection.selectOdd}>
        Odd
      </button>
      <button type="button" className="btn btn--secondary btn--sm" onClick={selection.selectEven}>
        Even
      </button>
    </div>
  );
}
