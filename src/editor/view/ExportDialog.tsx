import { useEffect, useMemo, useRef, useState } from "react";
import { ProcessPanel } from "../../components/tool/ProcessPanel";
import { Alert, ErrorAlert } from "../../components/ui/Alerts";
import { Icon } from "../../components/ui/Icon";
import { useJob } from "../../hooks/useJob";
import { downloadBlob, toBlob } from "../../lib/download";
import { formatBytes, plural, sanitizeFileName } from "../../lib/format";
import type { ExportResult } from "../../lib/pdf/export/exportDocument";
import { runOperation } from "../../lib/worker/client";
import { useSnapshot, useStore } from "../state/context";
import { buildExportPlan, suggestName, summarize } from "../state/plan";

/** A file name that ends in .pdf and cannot confuse an operating system. */
// eslint-disable-next-line react-refresh/only-export-components -- shared helper kept next to the code that uses it
export function cleanPdfName(input: string): string {
  const stem = sanitizeFileName(input.replace(/\.pdf$/i, ""));
  return `${stem}.pdf`;
}

/**
 * "Download as…": choose a name, create the file, download it. The original file is never overwritten: the result
 * is always a new download with the name given here, and the dialog says so.
 */
export function ExportDialog({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const { doc, name } = useSnapshot();
  const job = useJob<ExportResult>();
  const [fileName, setFileName] = useState(() => suggestName(name));
  const [author, setAuthor] = useState("");
  // With redaction, the rest of what a file can give away is cleared too, unless the person says otherwise.
  const [removeProperties, setRemoveProperties] = useState(true);
  const [removeBookmarks, setRemoveBookmarks] = useState(true);
  const [removeAttachments, setRemoveAttachments] = useState(true);
  const summary = useMemo(() => summarize(doc), [doc]);
  const first = useRef<HTMLInputElement>(null);
  const downloaded = useRef<ExportResult | null>(null);

  useEffect(() => {
    first.current?.focus();
    first.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && job.state.phase !== "running") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, job.state.phase]);

  const finalName = cleanPdfName(fileName);
  const sameAsOriginal = finalName.toLowerCase() === name.toLowerCase();

  const start = () =>
    job.run(async ({ signal, onProgress }) => {
      const plan = await buildExportPlan(store, finalName, author, summary.redactions > 0 ? { removeProperties, removeBookmarks, removeAttachments } : {});
      const result = await runOperation("exportDocument", { plan }, { signal, onProgress });
      downloadBlob(result.name, toBlob(result));
      downloaded.current = result;
      store.markExported();
      return result;
    });

  const running = job.state.phase === "running";
  const result = job.state.phase === "done" ? job.state.result : null;

  return (
    <div className="ed-modal" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && !running && onClose()}>
      <div className="ed-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title" data-testid="export-dialog">
        <header className="ed-dialog__head">
          <h2 id="export-title">Download as…</h2>
          <button type="button" className="ed-iconbtn" aria-label="Close" disabled={running} onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className="ed-dialog__body">
          {running && job.state.phase === "running" && <ProcessPanel title="Creating your PDF…" fraction={job.state.fraction} message={job.state.message} onCancel={job.cancel} />}

          {job.state.phase === "error" && <ErrorAlert error={job.state.error} onDismiss={job.reset} />}

          {result && (
            <div className="stack" data-testid="export-result">
              <Alert tone="success" title="Your PDF was created and downloaded" live="polite">
                <p>
                  <strong data-testid="export-result-name">{result.name}</strong> · {plural(result.pageCount ?? 0, "page")} · {formatBytes(result.bytes.length)}
                </p>
                <p>Your original file was not changed.</p>
              </Alert>
              <ExportReportView result={result} />
              <div className="ed-dialog__actions">
                <button type="button" className="btn btn--secondary" data-testid="export-again" onClick={() => downloadBlob(result.name, toBlob(result))}>
                  <Icon name="download" size={18} /> Download again
                </button>
                <button type="button" className="btn btn--primary" data-testid="export-done" onClick={onClose}>
                  Keep editing
                </button>
              </div>
            </div>
          )}

          {!running && !result && job.state.phase !== "done" && (
            <div className="stack">
              <div className="ed-field">
                <label htmlFor="export-name">File name</label>
                <input id="export-name" ref={first} className="input" value={fileName} data-testid="export-name" onChange={(event) => setFileName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void start()} />
                <span className="field__hint">
                  Saved as <strong data-testid="export-final-name">{finalName}</strong>. A new file is always created; the file you opened is never overwritten.
                </span>
                {sameAsOriginal && <span className="field__hint">This is the same name as the file you opened. Your browser will save it as a new file next to it.</span>}
              </div>

              <section aria-label="What will be saved">
                <h3 className="ed-section__title">What will be saved</h3>
                <ul className="ed-summary" data-testid="export-summary">
                  <li>{plural(summary.pages, "page")}</li>
                  <li>{summary.edits === 0 ? "No changes to existing text" : `${plural(summary.edits, "change")} to existing text`}</li>
                  {summary.removed > 0 && <li>{plural(summary.removed, "item")} that were part of the pages removed</li>}
                  {summary.moved > 0 && <li>{plural(summary.moved, "item")} that were part of the pages moved, resized or reordered</li>}
                  {summary.objects > 0 && <li>{plural(summary.objects, "object")} added to pages (text, images, shapes)</li>}
                  {summary.markup > 0 && <li>{plural(summary.markup, "highlight, underline or note", "highlights, underlines and notes")} as real annotations</li>}
                  {summary.covers > 0 && <li>{plural(summary.covers, "cover box", "cover boxes")}: hidden from view, content stays in the file</li>}
                  {summary.redactions > 0 && <li>{plural(summary.redactions, "redaction")}: content under them is removed</li>}
                  {summary.fields > 0 && <li>{plural(summary.fields, "form field")}</li>}
                </ul>
              </section>

              {summary.signed && (
                <Alert tone="warning" title="This document is digitally signed">
                  <p>Saving a changed copy makes the signature invalid. The signed original is not touched.</p>
                </Alert>
              )}
              {summary.redactions > 0 && (
                <Alert tone="warning" title="Redaction is permanent in the copy you download">
                  <p>The text, picture pixels, notes and form fields under each redaction box are taken out of the new file, and the file is checked afterwards. Your original is not changed.</p>
                  <div className="stack">
                    <label className="check">
                      <input type="checkbox" checked={removeProperties} onChange={(event) => setRemoveProperties(event.target.checked)} data-testid="redact-properties" />
                      <span className="check__text">
                        <span className="check__label">Also clear the document properties (title, author, subject, keywords)</span>
                      </span>
                    </label>
                    <label className="check">
                      <input type="checkbox" checked={removeBookmarks} onChange={(event) => setRemoveBookmarks(event.target.checked)} data-testid="redact-bookmarks" />
                      <span className="check__text">
                        <span className="check__label">Also remove the bookmarks (their titles may repeat words you redacted)</span>
                      </span>
                    </label>
                    <label className="check">
                      <input type="checkbox" checked={removeAttachments} onChange={(event) => setRemoveAttachments(event.target.checked)} data-testid="redact-attachments" />
                      <span className="check__text">
                        <span className="check__label">Also remove file attachments</span>
                      </span>
                    </label>
                  </div>
                </Alert>
              )}
              {summary.covers > 0 && (
                <Alert tone="info" title="Cover boxes do not remove anything">
                  <p>The text or image under a cover box is still in the file and can be copied. Use the Redact tool to remove content for good.</p>
                </Alert>
              )}

              <div className="ed-field">
                <label htmlFor="export-author">Author name for notes and markup (optional)</label>
                <input id="export-author" className="input" value={author} placeholder="Shown on notes and highlights" onChange={(event) => setAuthor(event.target.value)} />
              </div>

              <p className="ed-privacy">
                <Icon name="shield" size={16} /> Everything happens on your device. Nothing is uploaded.
              </p>

              <div className="ed-dialog__actions">
                <button type="button" className="btn btn--secondary" onClick={onClose}>
                  Cancel
                </button>
                <button type="button" className="btn btn--primary" onClick={() => void start()} data-testid="export-start">
                  <Icon name="download" size={18} /> Create and download
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** What redaction took out, in words. */
function redactionSummary(redactions: ExportResult["report"]["redactions"]): string {
  const total = (key: "glyphs" | "imagesBlanked" | "imagesRemoved" | "shapesRemoved" | "annotationsRemoved" | "blocksRemoved") => redactions.reduce((sum, r) => sum + r[key], 0);
  const parts: string[] = [];
  if (total("glyphs") > 0) parts.push(plural(total("glyphs"), "character"));
  if (total("imagesBlanked") > 0) parts.push(`${plural(total("imagesBlanked"), "picture")} with the covered part blanked`);
  if (total("imagesRemoved") > 0) parts.push(`${plural(total("imagesRemoved"), "picture")} removed`);
  if (total("shapesRemoved") > 0) parts.push(plural(total("shapesRemoved"), "drawn shape"));
  if (total("annotationsRemoved") > 0) parts.push(`${plural(total("annotationsRemoved"), "note, link or form field")}`);
  if (total("blocksRemoved") > 0) parts.push(plural(total("blocksRemoved"), "shared block"));
  return parts.length === 0 ? "nothing was under the boxes." : `removed from the file: ${parts.join(", ")}.`;
}

function ExportReportView({ result }: { result: ExportResult }) {
  const { report } = result;
  const applied = report.edits.filter((e) => e.outcome.status === "applied");
  const redrawn = applied.filter((e) => e.outcome.mode === "B");
  return (
    <ul className="ed-summary" data-testid="export-report">
      {report.edits.length > 0 && (
        <li>
          {applied.length} of {plural(report.edits.length, "text edit")} applied
          {redrawn.length > 0 ? `; ${redrawn.length} drawn partly in a similar font` : ""}
        </li>
      )}
      {report.changes.some((c) => c.outcome.status === "applied") && <li>{plural(report.changes.filter((c) => c.outcome.status === "applied").length, "change")} made to things that were already on the pages</li>}
      {report.redactions.length > 0 && (
        <li data-testid="redaction-result">
          <strong>Redaction:</strong> {redactionSummary(report.redactions)}
          {report.redactions.every((r) => r.verified) ? " Checked afterwards: nothing under the boxes could be found in the new file." : ""}
        </li>
      )}
      {report.objectsDrawn > 0 && <li>{plural(report.objectsDrawn, "object")} drawn on pages</li>}
      {report.annotations > 0 && <li>{plural(report.annotations, "annotation")} added</li>}
      {report.warnings.map((warning) => (
        <li key={warning} className="ed-summary__warning">
          <Icon name="alert" size={14} /> {warning}
        </li>
      ))}
    </ul>
  );
}
