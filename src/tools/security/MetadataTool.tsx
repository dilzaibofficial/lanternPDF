import { useEffect, useMemo, useState } from "react";
import { Alert, ErrorAlert } from "../../components/ui/Alerts";
import { Field } from "../../components/ui/Field";
import { Icon } from "../../components/ui/Icon";
import { JobView } from "../../components/tool/JobView";
import { Panel } from "../../components/tool/Panel";
import { ResultPanel } from "../../components/tool/ResultPanel";
import { SinglePdfGate } from "../../components/tool/SinglePdfGate";
import { useAcceptHandoff } from "../../hooks/useHandoff";
import { useJob } from "../../hooks/useJob";
import { type PdfItem, toPdfInput, usePdfFiles } from "../../hooks/usePdfFiles";
import { type AppError, toAppError } from "../../lib/errors";
import { formatBytes, plural } from "../../lib/format";
import type { MetadataChanges, PdfMetadata } from "../../lib/pdf/metadata";
import type { OutputFile } from "../../lib/pdf/types";
import { runOperation } from "../../lib/worker/client";
import type { ToolProps } from "../types";

type TextField = "title" | "author" | "subject" | "keywords" | "creator" | "producer";
const TEXT_FIELDS: { key: TextField; label: string; hint?: string }[] = [
  { key: "title", label: "Title" },
  { key: "author", label: "Author", hint: "Often your name or your organisation's." },
  { key: "subject", label: "Subject" },
  { key: "keywords", label: "Keywords" },
  { key: "creator", label: "Created with", hint: "The program that made the original document." },
  { key: "producer", label: "PDF producer", hint: "The program that wrote the PDF file." },
];

/** ISO date string -> the value an <input type="datetime-local"> expects (local time). */
function toLocalInput(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function MetadataTool({ tool }: ToolProps) {
  const files = usePdfFiles({ multiple: false });
  useAcceptHandoff(files.addBytes);
  const job = useJob<{ file: OutputFile; cleared: boolean }>();

  return (
    <JobView
      job={job}
      title="Updating the document…"
      renderResult={({ file, cleared }) => (
        <ResultPanel
          title={cleared ? "Your cleaned PDF is ready" : "Your updated PDF is ready"}
          subtitle={cleared ? "All document properties and the hidden XMP data were removed." : "The new details are saved in the file."}
          files={[file]}
          stats={[
            { label: "Pages", value: String(file.pageCount ?? "—") },
            { label: "Size", value: formatBytes(file.bytes.length) },
          ]}
          onReset={() => {
            job.reset();
            files.clear();
          }}
          onBack={job.reset}
          nextTools={["protect", "compress", "merge"]}
        />
      )}
    >
      <SinglePdfGate tool={tool} files={files}>
        {(item) => <Workspace item={item} run={(work) => job.run(work)} />}
      </SinglePdfGate>
    </JobView>
  );
}

type Run = (work: (context: { signal: AbortSignal; onProgress: (f: number, m?: string) => void }) => Promise<{ file: OutputFile; cleared: boolean }>) => void;

function Workspace({ item, run }: { item: PdfItem; run: Run }) {
  const [meta, setMeta] = useState<PdfMetadata | null>(null);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [values, setValues] = useState<Record<TextField, string>>({ title: "", author: "", subject: "", keywords: "", creator: "", producer: "" });
  const [created, setCreated] = useState("");
  const [modified, setModified] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setMeta(null);
    setLoadError(null);
    runOperation("readMetadata", { input: toPdfInput(item) })
      .then((info) => {
        if (cancelled) return;
        setMeta(info);
        setValues({ title: info.title ?? "", author: info.author ?? "", subject: info.subject ?? "", keywords: info.keywords ?? "", creator: info.creator ?? "", producer: info.producer ?? "" });
        setCreated(toLocalInput(info.creationDate));
        setModified(toLocalInput(info.modificationDate));
      })
      .catch((error) => !cancelled && setLoadError(toAppError(error)));
    return () => {
      cancelled = true;
    };
  }, [item]);

  // Only fields the user actually edited are sent.
  const changes = useMemo((): MetadataChanges => {
    if (!meta) return {};
    const result: MetadataChanges = {};
    for (const { key } of TEXT_FIELDS) {
      const before = meta[key] ?? "";
      if (values[key] !== before) result[key] = values[key] === "" ? null : values[key];
    }
    if (created !== toLocalInput(meta.creationDate)) result.creationDate = created ? new Date(created) : null;
    if (modified !== toLocalInput(meta.modificationDate)) result.modificationDate = modified ? new Date(modified) : null;
    return result;
  }, [meta, values, created, modified]);
  const changed = Object.keys(changes).length > 0;

  if (loadError) return <ErrorAlert error={loadError} />;
  if (!meta) {
    return (
      <div className="viewer__loading" role="status">
        <span className="spinner" aria-hidden="true" /> Reading the document…
      </div>
    );
  }

  const save = () => run(async ({ signal, onProgress }) => ({ file: await runOperation("writeMetadata", { input: toPdfInput(item), changes }, { signal, onProgress }), cleared: false }));
  const clearAll = () => run(async ({ signal, onProgress }) => ({ file: await runOperation("writeMetadata", { input: toPdfInput(item), changes: { clearAll: true } }, { signal, onProgress }), cleared: true }));

  const notes: { tone: "info" | "warning"; text: string }[] = [];
  if (meta.author) notes.push({ tone: "info", text: `The author field names “${meta.author}”.` });
  if (meta.hasXmp) notes.push({ tone: "info", text: "The file carries a hidden XMP metadata block, which can repeat the title, author and editing history." });
  if (meta.attachmentCount > 0) notes.push({ tone: "warning", text: `It has ${plural(meta.attachmentCount, "embedded file")} attached. They travel with the PDF.` });
  if (meta.hasJavaScript) notes.push({ tone: "warning", text: "It contains JavaScript, which some readers will run." });

  return (
    <div className="tool-layout tool-layout--side">
      <div className="tool-layout__main">
        {notes.map((note) => (
          <Alert key={note.text} tone={note.tone}>
            <p>{note.text}</p>
          </Alert>
        ))}
        <section className="card card--pad" aria-labelledby="props-title" data-testid="properties">
          <h2 className="panel__title" id="props-title" style={{ marginBottom: "var(--space-3)" }}>
            Document properties
          </h2>
          <dl className="props">
            <Prop label="File size" value={formatBytes(meta.fileSize)} />
            <Prop label="Pages" value={String(meta.pageCount)} />
            <Prop label="PDF version" value={meta.version ?? "unknown"} />
            <Prop label="Protection" value={item.encrypted ? (item.password ? "Password-protected (opened with your password)" : "Usage restrictions") : "None"} />
            <Prop label="Page sizes" value={meta.pageSizes.map((size) => `${size.label}${meta.pageSizes.length > 1 ? ` × ${size.count}` : ""}`).join(", ")} />
            <Prop label="Tagged for accessibility" value={meta.tagged ? "Yes" : "No"} />
            <Prop label="Optimised for web view" value={meta.linearized ? "Yes" : "No"} />
            <Prop label="Bookmarks" value={meta.hasOutline ? "Yes" : "No"} />
            <Prop label="Form fields" value={String(meta.formFieldCount)} />
            <Prop label="Attachments" value={String(meta.attachmentCount)} />
            <Prop label="Images" value={String(meta.imageCount)} />
            <Prop
              label="Fonts"
              value={meta.fonts.length === 0 ? "None" : `${plural(meta.fonts.length, "font")}: ${meta.fonts.slice(0, 8).map((font) => `${font.name}${font.embedded ? "" : " (not embedded)"}`).join(", ")}${meta.fonts.length > 8 ? "…" : ""}`}
            />
          </dl>
        </section>
      </div>

      <aside className="tool-layout__side">
        <Panel title="Edit details">
          {TEXT_FIELDS.map(({ key, label, hint }) => (
            <Field key={key} label={label} hint={hint}>
              {({ id, describedBy }) => <input id={id} className="input" value={values[key]} aria-describedby={describedBy} onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))} />}
            </Field>
          ))}
          <Field label="Created">{({ id }) => <input id={id} className="input" type="datetime-local" value={created} onChange={(event) => setCreated(event.target.value)} />}</Field>
          <Field label="Modified">{({ id }) => <input id={id} className="input" type="datetime-local" value={modified} onChange={(event) => setModified(event.target.value)} />}</Field>
          <p className="panel__note">Empty a field to remove it from the file.</p>

          <div className="action-bar">
            <button type="button" className="btn btn--primary btn--lg" disabled={!changed} onClick={save} data-testid="run-button">
              <Icon name="info" size={22} />
              Save changes
            </button>
            {!confirmClear ? (
              <button type="button" className="btn btn--secondary" onClick={() => setConfirmClear(true)} data-testid="clear-all">
                Remove all metadata…
              </button>
            ) : (
              <div className="alert alert--warning" role="alert">
                <div className="alert__body">
                  <div className="alert__title">Remove every property and the hidden XMP data?</div>
                  <div className="alert__actions">
                    <button type="button" className="btn btn--danger btn--sm" onClick={clearAll} data-testid="confirm-clear">
                      Yes, remove all
                    </button>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmClear(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </Panel>
      </aside>
    </div>
  );
}

function Prop({ label, value }: { label: string; value: string }) {
  return (
    <div className="props__row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
