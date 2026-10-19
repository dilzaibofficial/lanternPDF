import { type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { PdfFileList } from "../../components/files/PdfFileList";
import { PageCard } from "../../components/pdf/PageCard";
import { Alert } from "../../components/ui/Alerts";
import { Icon } from "../../components/ui/Icon";
import { JobView } from "../../components/tool/JobView";
import { Panel } from "../../components/tool/Panel";
import { ResultPanel } from "../../components/tool/ResultPanel";
import { useAcceptHandoff } from "../../hooks/useHandoff";
import { useJob } from "../../hooks/useJob";
import { type PdfItem, toPdfInput, toPdfSource, usePdfFiles } from "../../hooks/usePdfFiles";
import { useUndoable } from "../../hooks/useUndoable";
import { baseName, formatBytes, plural } from "../../lib/format";
import type { PageItem } from "../../lib/pdf/pages";
import { type OutputFile, type Rotation } from "../../lib/pdf/types";
import { runOperation } from "../../lib/worker/client";
import { Dropzone } from "../../components/files/Dropzone";
import { SinglePdfGate } from "../../components/tool/SinglePdfGate";
import { LocalNote } from "../../components/tool/Panel";
import type { ToolProps } from "../types";

type Mode = "organize" | "rotate";

type Entry =
  | { uid: string; kind: "page"; sourceKey: string; page: number; rotate: Rotation }
  | { uid: string; kind: "blank"; rotate: Rotation };

/** A4 portrait in PDF points. */
const BLANK = { width: 595.28, height: 841.89 } as const;

const turn = (value: Rotation, by: 90 | 270): Rotation => (((value + by) % 360) as Rotation);

let counter = 0;
const uid = () => `e${(counter += 1)}`;

const keyOf = (item: PdfItem) => `${item.id}:${item.revision}`;

interface Result {
  file: OutputFile;
  pagesBefore: number;
  sources: number;
}

/**
 * "Organize pages" and "Rotate PDF": a grid of page thumbnails you can reorder, rotate, duplicate,
 * delete and (for Organize) add blank pages or whole other PDFs to. Everything is undoable.
 */
export function PageWorkspaceTool({ tool, mode }: ToolProps & { mode: Mode }) {
  const files = usePdfFiles({ multiple: mode === "organize" });
  useAcceptHandoff(files.addBytes);
  const job = useJob<Result>();

  const reset = () => {
    job.reset();
    files.clear();
  };

  return (
    <JobView
      job={job}
      title={mode === "organize" ? "Building your PDF…" : "Rotating pages…"}
      renderResult={(result) => (
        <ResultPanel
          title={mode === "organize" ? "Your organized PDF is ready" : "Your rotated PDF is ready"}
          subtitle={result.sources > 1 ? `Pages from ${plural(result.sources, "file")} arranged into one document.` : undefined}
          files={[result.file]}
          stats={[
            { label: "Pages", value: String(result.file.pageCount ?? "—") },
            { label: "Before", value: `${result.pagesBefore} pages` },
            { label: "Size", value: formatBytes(result.file.bytes.length) },
          ]}
          onReset={reset}
          onBack={job.reset}
          nextTools={["compress", "page-numbers", "watermark", "protect"]}
        />
      )}
    >
      {mode === "organize" ? (
        <OrganizeShell tool={tool} files={files} run={job.run} />
      ) : (
        <SinglePdfGate tool={tool} files={files}>
          {(item) => <Workspace mode="rotate" items={[item]} files={files} run={job.run} />}
        </SinglePdfGate>
      )}
    </JobView>
  );
}

type Files = ReturnType<typeof usePdfFiles>;
type Run = (work: (context: { signal: AbortSignal; onProgress: (f: number, m?: string) => void }) => Promise<Result>) => void;

/** Organize accepts several PDFs, so it needs a multi-file frame instead of the single-file gate. */
function OrganizeShell({ tool, files, run }: { tool: ToolProps["tool"]; files: Files; run: Run }) {
  if (files.items.length === 0) {
    return (
      <Dropzone extensions={tool.accept} multiple pickLabel={tool.pickLabel} onFiles={files.addFiles} rejections={files.rejections} onDismissRejections={files.clearRejections} note={<LocalNote />} />
    );
  }
  const problems = files.items.filter((item) => item.status !== "ready");
  return (
    <div className="stack">
      {problems.length > 0 && (
        <PdfFileList items={problems} onMove={files.move} onRemove={files.remove} onUnlock={files.unlock} onReplace={files.replace} sortable={false} label="Files that need attention" />
      )}
      {files.ready.length > 0 && <Workspace mode="organize" items={files.ready} files={files} run={run} />}
      {files.ready.length === 0 && (
        <Dropzone compact extensions={tool.accept} multiple pickLabel={tool.pickLabel} onFiles={files.addFiles} rejections={files.rejections} onDismissRejections={files.clearRejections} />
      )}
    </div>
  );
}

interface WorkspaceProps {
  mode: Mode;
  /** Files that are open and readable, in the order they were added. */
  items: PdfItem[];
  files: Files;
  run: Run;
}

function Workspace({ mode, items, files, run }: WorkspaceProps) {
  const organize = mode === "organize";
  const history = useUndoable<Entry[]>([]);
  const entries = history.value;
  const known = useRef(new Set<string>());
  const picker = useRef<HTMLInputElement>(null);
  const [dragUid, setDragUid] = useState<string | null>(null);
  const [overUid, setOverUid] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  // Callers may pass a fresh array every render; only the identity of the files (id:revision) matters.
  const itemsKey = items.map(keyOf).join("|");
  /* eslint-disable react-hooks/exhaustive-deps */
  const sources = useMemo(() => new Map(items.map((item) => [keyOf(item), item])), [itemsKey]);
  const colorOf = useMemo(() => new Map(items.map((item, index) => [keyOf(item), index])), [itemsKey]);
  /* eslint-enable react-hooks/exhaustive-deps */

  // Keep the grid in step with the loaded files: append pages of new files, drop pages of removed ones.
  useEffect(() => {
    const currentKeys = new Set(sources.keys());
    const added = [...currentKeys].filter((key) => !known.current.has(key));
    const removed = [...known.current].filter((key) => !currentKeys.has(key));
    if (added.length === 0 && removed.length === 0) return;
    for (const key of removed) known.current.delete(key);
    for (const key of added) known.current.add(key);
    const fresh: Entry[] = added.flatMap((key) =>
      Array.from({ length: sources.get(key)?.pageCount ?? 0 }, (_, index): Entry => ({ uid: uid(), kind: "page", sourceKey: key, page: index + 1, rotate: 0 })),
    );
    const apply = (current: Entry[]) => [...current.filter((entry) => entry.kind === "blank" || !removed.includes(entry.sourceKey)), ...fresh];
    if (history.value.length === 0 && removed.length === 0) history.reset(apply([]));
    else history.set(apply);
    // `history` methods are stable; only the file set matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  const totalSourcePages = items.reduce((sum, item) => sum + (item.pageCount ?? 0), 0);
  const index = (entryUid: string) => entries.findIndex((entry) => entry.uid === entryUid);

  const update = (entryUid: string, change: (entry: Entry) => Entry) => history.set((current) => current.map((entry) => (entry.uid === entryUid ? change(entry) : entry)));
  const rotate = (entryUid: string, by: 90 | 270) => update(entryUid, (entry) => ({ ...entry, rotate: turn(entry.rotate, by) }));
  const remove = (entryUid: string) => history.set((current) => current.filter((entry) => entry.uid !== entryUid));
  const duplicate = (entryUid: string) =>
    history.set((current) => {
      const at = current.findIndex((entry) => entry.uid === entryUid);
      if (at < 0) return current;
      const next = [...current];
      next.splice(at + 1, 0, { ...(current[at] as Entry), uid: uid() });
      return next;
    });
  const insertBlank = (afterUid: string | null) =>
    history.set((current) => {
      const at = afterUid === null ? current.length - 1 : current.findIndex((entry) => entry.uid === afterUid);
      const next = [...current];
      next.splice(at + 1, 0, { uid: uid(), kind: "blank", rotate: 0 });
      return next;
    });
  const move = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || to >= entries.length) return;
    history.set((current) => {
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved as Entry);
      return next;
    });
    setAnnouncement(`Moved page to position ${to + 1} of ${entries.length}.`);
  };
  const rotateAll = (by: 90 | 270) => history.set((current) => current.map((entry) => ({ ...entry, rotate: turn(entry.rotate, by) })));
  const reverse = () => history.set((current) => [...current].reverse());
  const restore = () => {
    // Back to the untouched documents: every page of every loaded file, in order, no history.
    known.current = new Set(sources.keys());
    const fresh = [...sources.entries()].flatMap(([key, item]) =>
      Array.from({ length: item.pageCount ?? 0 }, (_, i): Entry => ({ uid: uid(), kind: "page", sourceKey: key, page: i + 1, rotate: 0 })),
    );
    history.reset(fresh);
  };

  const onDragStart = (event: DragEvent, entryUid: string) => {
    setDragUid(entryUid);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", entryUid);
  };
  const onDrop = (event: DragEvent, targetUid: string) => {
    event.preventDefault();
    if (dragUid && dragUid !== targetUid) move(index(dragUid), index(targetUid));
    setDragUid(null);
    setOverUid(null);
  };

  const changed = useMemo(() => {
    if (entries.length !== totalSourcePages) return true;
    return entries.some((entry, position) => entry.kind === "blank" || entry.rotate !== 0 || position !== sequenceIndex(entry, items));
  }, [entries, items, totalSourcePages]);

  const save = () =>
    run(async ({ signal, onProgress }) => {
      const inputs = items.map(toPdfInput);
      const pageItems: PageItem[] = entries.map((entry) =>
        entry.kind === "blank"
          ? { kind: "blank", width: BLANK.width, height: BLANK.height, rotate: entry.rotate }
          : { kind: "page", source: items.findIndex((item) => keyOf(item) === entry.sourceKey), page: entry.page, rotate: entry.rotate },
      );
      const stem = baseName(items[0]?.name ?? "document");
      const outputName = organizeName(mode, stem, items.length);
      const file = await runOperation("arrange", { sources: inputs, items: pageItems, outputName }, { signal, onProgress });
      return { file, pagesBefore: totalSourcePages, sources: items.length };
    });

  const rotatedCount = entries.filter((entry) => entry.rotate !== 0).length;

  return (
    <div className="tool-layout tool-layout--side">
      <div className="tool-layout__main">
        <div className="selection-bar" role="toolbar" aria-label="Page actions">
          <span className="selection-bar__count" role="status" aria-live="polite" data-testid="page-count">
            {plural(entries.length, "page")}
          </span>
          <button type="button" className="btn btn--secondary btn--sm" onClick={history.undo} disabled={!history.canUndo} aria-label="Undo">
            <Icon name="undo" size={16} />
            Undo
          </button>
          <button type="button" className="btn btn--secondary btn--sm" onClick={history.redo} disabled={!history.canRedo} aria-label="Redo">
            <Icon name="redo" size={16} />
            Redo
          </button>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => rotateAll(270)} aria-label="Rotate all pages left">
            <Icon name="rotate-left" size={16} />
            All left
          </button>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => rotateAll(90)} aria-label="Rotate all pages right">
            <Icon name="rotate" size={16} />
            All right
          </button>
          {organize && (
            <>
              <button type="button" className="btn btn--secondary btn--sm" onClick={reverse}>
                Reverse order
              </button>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => insertBlank(null)}>
                <Icon name="file-plus" size={16} />
                Blank page
              </button>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => picker.current?.click()}>
                <Icon name="plus" size={16} />
                Add PDF
              </button>
              <input
                ref={picker}
                type="file"
                hidden
                multiple
                accept=".pdf"
                data-testid="file-input-add"
                onChange={(event) => {
                  if (event.target.files?.length) files.addFiles(Array.from(event.target.files));
                  event.target.value = "";
                }}
              />
            </>
          )}
          <button type="button" className="btn btn--ghost btn--sm" onClick={restore} disabled={!changed}>
            Reset
          </button>
        </div>

        {items.length > 1 && (
          <ul className="chips" aria-label="Files in this document" style={{ listStyle: "none", padding: 0 }}>
            {items.map((item, position) => (
              <li key={item.id} className={`page-card page-card--source-${position % 6}`} style={{ padding: "2px 10px", display: "inline-flex", alignItems: "center", gap: "var(--space-2)", borderRadius: "var(--radius-pill)", fontSize: "var(--text-sm)" }}>
                <span>
                  {item.name} · {plural(item.pageCount ?? 0, "page")}
                </span>
                <button type="button" className="btn btn--ghost btn--icon btn--sm" style={{ minHeight: "1.75rem", width: "1.75rem" }} aria-label={`Remove ${item.name}`} onClick={() => files.remove(item.id)}>
                  <Icon name="close" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {entries.length === 0 ? (
          <Alert tone="warning">Every page has been removed. Use Undo or Reset to bring pages back.</Alert>
        ) : (
          <ul className="page-grid page-grid--tools" aria-label="Pages, in the order they will be saved" data-testid="page-grid">
            {entries.map((entry, position) => {
              const source = entry.kind === "page" ? sources.get(entry.sourceKey) : undefined;
              const label = entry.kind === "page" ? `Page ${position + 1}` : `Page ${position + 1} (blank)`;
              const tools = (
                <>
                  {organize && (
                    <>
                      <button type="button" className="page-card__tool" aria-label={`Move ${label} earlier`} disabled={position === 0} onClick={() => move(position, position - 1)}>
                        <Icon name="chevron-left" size={16} />
                      </button>
                      <button type="button" className="page-card__tool" aria-label={`Move ${label} later`} disabled={position === entries.length - 1} onClick={() => move(position, position + 1)}>
                        <Icon name="chevron-right" size={16} />
                      </button>
                    </>
                  )}
                  <button type="button" className="page-card__tool" aria-label={`Rotate ${label} left`} onClick={() => rotate(entry.uid, 270)}>
                    <Icon name="rotate-left" size={16} />
                  </button>
                  <button type="button" className="page-card__tool" aria-label={`Rotate ${label} right`} onClick={() => rotate(entry.uid, 90)}>
                    <Icon name="rotate" size={16} />
                  </button>
                  {organize && (
                    <>
                      <button type="button" className="page-card__tool" aria-label={`Duplicate ${label}`} onClick={() => duplicate(entry.uid)}>
                        <Icon name="copy" size={16} />
                      </button>
                      <button type="button" className="page-card__tool" aria-label={`Insert a blank page after ${label}`} onClick={() => insertBlank(entry.uid)}>
                        <Icon name="file-plus" size={16} />
                      </button>
                      <button type="button" className="page-card__tool page-card__tool--danger" aria-label={`Delete ${label}`} onClick={() => remove(entry.uid)}>
                        <Icon name="trash" size={16} />
                      </button>
                    </>
                  )}
                </>
              );

              if (entry.kind === "blank" || !source) {
                return (
                  <BlankCard
                    key={entry.uid}
                    label={label}
                    tools={tools}
                    dragging={dragUid === entry.uid}
                    dropTarget={overUid === entry.uid && dragUid !== entry.uid}
                    draggable={organize}
                    onDragStart={(event) => onDragStart(event, entry.uid)}
                    onDragOver={(event) => {
                      if (!dragUid) return;
                      event.preventDefault();
                      setOverUid(entry.uid);
                    }}
                    onDrop={(event) => onDrop(event, entry.uid)}
                    onDragEnd={() => {
                      setDragUid(null);
                      setOverUid(null);
                    }}
                  />
                );
              }
              return (
                <PageCard
                  key={entry.uid}
                  source={toPdfSource(source)}
                  pageNumber={entry.page}
                  label={label}
                  rotation={entry.rotate}
                  sourceIndex={items.length > 1 ? colorOf.get(entry.sourceKey) : undefined}
                  badge={rotatedBadge(entry.rotate)}
                  tools={tools}
                  dragging={dragUid === entry.uid}
                  dropTarget={overUid === entry.uid && dragUid !== entry.uid}
                  draggable={organize}
                  onDragStart={(event) => onDragStart(event, entry.uid)}
                  onDragOver={(event) => {
                    if (!dragUid) return;
                    event.preventDefault();
                    setOverUid(entry.uid);
                  }}
                  onDrop={(event) => onDrop(event, entry.uid)}
                  onDragEnd={() => {
                    setDragUid(null);
                    setOverUid(null);
                  }}
                />
              );
            })}
          </ul>
        )}
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
      </div>

      <aside className="tool-layout__side">
        <Panel title={organize ? "Organize" : "Rotate"}>
          <p className="panel__note" data-testid="organize-summary">
            {plural(entries.length, "page")} will be saved
            {items.length > 1 ? ` from ${plural(items.length, "file")}` : ""}.
            {rotatedCount > 0 && ` ${plural(rotatedCount, "page")} rotated.`}
          </p>
          <p className="panel__note">
            {organize
              ? "Drag pages to reorder them, or use the arrow buttons. Pages from different PDFs are framed in different colours."
              : "Turn single pages with their buttons, or all of them with the “All” buttons above."}
          </p>
          {entries.length === 0 && <Alert tone="warning">There are no pages to save.</Alert>}
          <div className="action-bar">
            <button type="button" className="btn btn--primary btn--lg" disabled={entries.length === 0 || !changed} onClick={save} data-testid="run-button">
              <Icon name={organize ? "layout" : "rotate"} size={22} />
              {organize ? "Save PDF" : "Rotate PDF"}
            </button>
            {!changed && entries.length > 0 && <p className="panel__note">Make a change first: the file would be identical.</p>}
          </div>
        </Panel>
      </aside>
    </div>
  );
}

function organizeName(mode: Mode, stem: string, sourceCount: number): string {
  if (mode === "rotate") return `${stem}_rotated.pdf`;
  return sourceCount > 1 ? "organized.pdf" : `${stem}_organized.pdf`;
}

function rotatedBadge(rotate: Rotation): string | undefined {
  return rotate === 0 ? undefined : `${rotate}°`;
}

/** Position of a page in the untouched document: sources in order, pages ascending. */
function sequenceIndex(entry: Entry, items: PdfItem[]): number {
  if (entry.kind === "blank") return -1;
  let offset = 0;
  for (const item of items) {
    if (keyOf(item) === entry.sourceKey) return offset + entry.page - 1;
    offset += item.pageCount ?? 0;
  }
  return -1;
}

interface BlankCardProps {
  label: string;
  tools: React.ReactNode;
  dragging: boolean;
  dropTarget: boolean;
  draggable: boolean;
  onDragStart: (event: DragEvent) => void;
  onDragOver: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
  onDragEnd: (event: DragEvent) => void;
}

function BlankCard({ label, tools, dragging, dropTarget, draggable, onDragStart, onDragOver, onDrop, onDragEnd }: BlankCardProps) {
  return (
    <li className={`page-card${dragging ? " is-dragging" : ""}${dropTarget ? " is-drop-target" : ""}`} data-testid="page-card" data-blank="true" draggable={draggable} onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} onDragEnd={onDragEnd}>
      <span className="page-card__thumb" style={{ background: "#fff" }}>
        <span style={{ color: "#8a8fa0", fontSize: "var(--text-xs)" }}>Blank page</span>
      </span>
      <span className="page-card__label">{label}</span>
      <div className="page-card__tools">{tools}</div>
    </li>
  );
}

