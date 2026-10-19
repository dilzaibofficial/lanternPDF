import { useMemo, useState } from "react";
import { PageCard } from "../../components/pdf/PageCard";
import { PageRangeField } from "../../components/pdf/PageRangeField";
import { Alert } from "../../components/ui/Alerts";
import { Checkbox, Field, Segmented } from "../../components/ui/Field";
import { Icon } from "../../components/ui/Icon";
import { JobView } from "../../components/tool/JobView";
import { Panel } from "../../components/tool/Panel";
import { ResultPanel } from "../../components/tool/ResultPanel";
import { SinglePdfGate } from "../../components/tool/SinglePdfGate";
import { useAcceptHandoff } from "../../hooks/useHandoff";
import { useJob } from "../../hooks/useJob";
import { type PdfItem, toPdfInput, toPdfSource, usePdfFiles } from "../../hooks/usePdfFiles";
import { AppError } from "../../lib/errors";
import { baseName, plural } from "../../lib/format";
import type { SplitPlan } from "../../lib/pdf/pages";
import type { OutputFile } from "../../lib/pdf/types";
import { type PageRange, parsePageRanges } from "../../lib/ranges";
import { runOperation } from "../../lib/worker/client";
import type { ToolProps } from "../types";

type Mode = "ranges" | "every" | "each";

interface SplitResult {
  files: OutputFile[];
  name: string;
}

const label = (range: PageRange): string => (range.start === range.end ? `page ${range.start}` : `pages ${range.start}–${range.end}`);

function chunks(pageCount: number, size: number): PageRange[] {
  const result: PageRange[] = [];
  for (let start = 1; start <= pageCount; start += size) result.push({ start, end: Math.min(pageCount, start + size - 1) });
  return result;
}

export default function SplitTool({ tool }: ToolProps) {
  const files = usePdfFiles({ multiple: false });
  useAcceptHandoff(files.addBytes);
  const job = useJob<SplitResult>();

  return (
    <JobView
      job={job}
      title="Splitting your PDF…"
      renderResult={(result) => (
        <ResultPanel
          title={result.files.length === 1 ? "Your PDF is ready" : `Your ${result.files.length} PDFs are ready`}
          subtitle={`Split from ${result.name}.`}
          files={result.files}
          stats={[
            { label: "Files", value: String(result.files.length) },
            { label: "Pages in total", value: String(result.files.reduce((sum, f) => sum + (f.pageCount ?? 0), 0)) },
          ]}
          zipName={`${baseName(result.name)}_split.zip`}
          onReset={() => {
            job.reset();
            files.clear();
          }}
          onBack={job.reset}
          nextTools={["compress", "protect"]}
        />
      )}
    >
      <SinglePdfGate tool={tool} files={files}>
        {(item) => <SplitWorkspace item={item} onSplit={(plan) => job.run(async ({ signal, onProgress }) => ({ files: await runOperation("split", { input: toPdfInput(item), plan }, { signal, onProgress }), name: item.name }))} />}
      </SinglePdfGate>
    </JobView>
  );
}

function SplitWorkspace({ item, onSplit }: { item: PdfItem; onSplit: (plan: SplitPlan) => void }) {
  const pageCount = item.pageCount ?? 0;
  const [mode, setMode] = useState<Mode>("ranges");
  const [rangeText, setRangeText] = useState("");
  const [mergeAll, setMergeAll] = useState(false);
  const [every, setEvery] = useState("2");
  const source = useMemo(() => toPdfSource(item), [item]);

  // Work out what the current settings would produce (or why they are invalid).
  const plan = useMemo((): { groups: PageRange[]; plan: SplitPlan | null; error: string | null } => {
    if (pageCount < 2) return { groups: [], plan: null, error: null };
    if (mode === "each") {
      return { groups: chunks(pageCount, 1), plan: { mode: "every", n: 1 }, error: null };
    }
    if (mode === "every") {
      const n = Number(every);
      if (!Number.isInteger(n) || n < 1) return { groups: [], plan: null, error: "Enter a whole number of pages, such as 2." };
      if (n >= pageCount) return { groups: [], plan: null, error: `Choose fewer than ${pageCount} pages: splitting every ${n} would give one file.` };
      return { groups: chunks(pageCount, n), plan: { mode: "every", n }, error: null };
    }
    if (rangeText.trim() === "") return { groups: [], plan: null, error: null };
    try {
      const ranges = parsePageRanges(rangeText, pageCount);
      return { groups: ranges, plan: { mode: "ranges", ranges, mergeAll }, error: null };
    } catch (error) {
      return { groups: [], plan: null, error: error instanceof AppError ? error.message : "Check the page ranges." };
    }
  }, [mode, rangeText, every, mergeAll, pageCount]);

  const groupOfPage = useMemo(() => {
    const map = new Map<number, number>();
    plan.groups.forEach((range, index) => {
      for (let page = range.start; page <= range.end; page += 1) if (!map.has(page)) map.set(page, index);
    });
    return map;
  }, [plan.groups]);

  if (pageCount < 2) {
    return <Alert tone="info">This PDF has only one page, so there is nothing to split. Choose a PDF with at least two pages.</Alert>;
  }

  const filesCreated = mode === "ranges" && mergeAll ? 1 : plan.groups.length;

  return (
    <div className="tool-layout tool-layout--side">
      <div className="tool-layout__main">
        <p className="panel__note">
          {plan.groups.length > 0
            ? "Pages with the same colour frame end up in the same file."
            : "Choose how to split on the right. A preview of the result appears here."}
        </p>
        <ul className="page-grid" aria-label="Pages of the document">
          {Array.from({ length: pageCount }, (_, index) => index + 1).map((page) => (
            <PageCard key={page} source={source} pageNumber={page} label={`Page ${page}`} sourceIndex={groupOfPage.get(page)} badge={groupOfPage.has(page) ? `${(groupOfPage.get(page) as number) + 1}` : undefined} />
          ))}
        </ul>
      </div>

      <aside className="tool-layout__side">
        <Panel title="Split options">
          <Segmented<Mode>
            name="split-mode"
            legend="Split by"
            value={mode}
            onChange={setMode}
            options={[
              { value: "ranges", label: "Page ranges" },
              { value: "every", label: "Every N pages" },
              { value: "each", label: "Every page" },
            ]}
          />

          {mode === "ranges" && (
            <div className="panel__section">
              <PageRangeField label="Page ranges" value={rangeText} onChange={setRangeText} pageCount={pageCount} error={plan.error} placeholder="e.g. 1-3, 4-6, 7-" hint="Each range becomes its own PDF." />
              <Checkbox checked={mergeAll} onChange={setMergeAll} label="Merge all ranges into one PDF" hint="Gives a single file containing just these pages." />
            </div>
          )}

          {mode === "every" && (
            <Field label="Pages per file" error={plan.error} hint={`A new PDF starts after every N pages of this ${pageCount}-page document.`}>
              {({ id, describedBy, invalid }) => (
                <input id={id} className="input" type="number" min={1} max={pageCount - 1} step={1} inputMode="numeric" value={every} aria-describedby={describedBy} aria-invalid={invalid || undefined} onChange={(event) => setEvery(event.target.value)} />
              )}
            </Field>
          )}

          {plan.plan && (
            <div className="panel__note" data-testid="split-summary" aria-live="polite">
              <strong>{plural(filesCreated, "file")}</strong> will be created
              {filesCreated <= 6 && filesCreated > 0 && !(mode === "ranges" && mergeAll) && ": " + plan.groups.map(label).join(", ")}.
            </div>
          )}

          <div className="action-bar">
            <button type="button" className="btn btn--primary btn--lg" disabled={!plan.plan} onClick={() => plan.plan && onSplit(plan.plan)} data-testid="split-button">
              <Icon name="split" size={22} />
              Split PDF
            </button>
          </div>
        </Panel>
      </aside>
    </div>
  );
}
