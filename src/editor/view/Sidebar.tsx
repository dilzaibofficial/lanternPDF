import { type DragEvent, useRef, useState } from "react";
import { PdfThumb } from "../../components/pdf/PdfThumb";
import { Icon } from "../../components/ui/Icon";
import { AppError, toAppError } from "../../lib/errors";
import { LIMITS } from "../../config/limits";
import { checkFiles, contentProblem } from "../../lib/files";
import { slotSize } from "../model/geometry";
import type { Id, PageEntry } from "../model/types";
import { usePageData, useSnapshot, useStore } from "../state/context";

const THUMB_WIDTH = 120;

interface ThumbProps {
  page: PageEntry;
  number: number;
  selected: boolean;
  current: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  onClick: (event: React.MouseEvent) => void;
  onDragStart: (event: DragEvent) => void;
  onDragOver: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
  onDragEnd: () => void;
}

function Thumb({ page, number, selected, current, dropBefore, dropAfter, onClick, onDragStart, onDragOver, onDrop, onDragEnd }: ThumbProps) {
  const store = useStore();
  usePageData(page.id); // a finished edit redraws the thumbnail
  const render = store.renderSource(page);
  const crop = page.crop ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const shown = slotSize(Math.max(1, page.width - crop.left - crop.right), Math.max(1, page.height - crop.top - crop.bottom), 1, page.rotation);
  const height = (shown.height / shown.width) * THUMB_WIDTH;
  return (
    <li
      className={`ed-thumb${selected ? " ed-thumb--selected" : ""}${current ? " ed-thumb--current" : ""}${dropBefore ? " ed-thumb--drop-before" : ""}${dropAfter ? " ed-thumb--drop-after" : ""}`}
      data-testid={`thumb-${number}`}
      data-page-id={page.id}
      draggable
      aria-current={current ? "page" : undefined}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <button type="button" className="ed-thumb__button" onClick={onClick} aria-label={`Page ${number}${selected ? ", selected" : ""}`} aria-pressed={selected}>
        <span className="ed-thumb__paper" style={{ width: THUMB_WIDTH, height }}>
          {render ? <PdfThumb source={render.pdf} pageNumber={render.pageNumber} width={THUMB_WIDTH} rotation={page.rotation} /> : <span className="ed-thumb__blank" />}
        </span>
        <span className="ed-thumb__label">{number}</span>
      </button>
    </li>
  );
}

/** The page panel: thumbnails to move around and reorder, and the actions that work on whole pages. */
export function Sidebar() {
  const store = useStore();
  const { doc, view } = useSnapshot();
  const [dragging, setDragging] = useState<Id[] | null>(null);
  const [over, setOver] = useState<{ id: Id; after: boolean } | null>(null);
  const insertInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const pages = doc.pages;
  const selected = view.selectedPages.length > 0 ? view.selectedPages : view.currentPage ? [view.currentPage] : [];
  const indexOfSelectionEnd = Math.max(...selected.map((id) => pages.findIndex((p) => p.id === id)), 0);

  const click = (page: PageEntry, event: React.MouseEvent) => {
    const index = pages.findIndex((p) => p.id === page.id);
    if (event.shiftKey && view.currentPage) {
      const from = pages.findIndex((p) => p.id === view.currentPage);
      const [a, b] = [Math.min(from, index), Math.max(from, index)];
      store.setView({ selectedPages: pages.slice(a, b + 1).map((p) => p.id), currentPage: page.id });
    } else if (event.ctrlKey || event.metaKey) {
      const has = view.selectedPages.includes(page.id);
      store.setView({ selectedPages: has ? view.selectedPages.filter((id) => id !== page.id) : [...view.selectedPages, page.id], currentPage: page.id });
    } else {
      store.setView({ selectedPages: [page.id], currentPage: page.id });
    }
  };

  const readFile = async (file: File): Promise<Uint8Array | null> => {
    const { accepted, rejected } = checkFiles([file], { extensions: [".pdf"], maxBytes: LIMITS.maxFileBytes, maxFiles: 1, existing: 0, label: "a PDF" });
    if (rejected.length > 0 || accepted.length === 0) {
      store.notify(rejected[0]?.reason ?? "That file cannot be used.", "warning");
      return null;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const problem = contentProblem(file.name, bytes);
    if (problem) {
      store.notify(problem, "warning");
      return null;
    }
    return bytes;
  };

  const insertFrom = async (files: FileList | null) => {
    const file = files?.[0];
    if (insertInput.current) insertInput.current.value = "";
    if (!file) return;
    const bytes = await readFile(file);
    if (!bytes) return;
    setBusy(true);
    try {
      await store.insertFromDocument(file.name, bytes, indexOfSelectionEnd);
      store.notify(`Added the pages of ${file.name}.`, "success");
    } catch (error) {
      const app = toAppError(error);
      store.notify(app.code === "PASSWORD_REQUIRED" || app.code === "WRONG_PASSWORD" ? `“${file.name}” is password-protected. Unlock it with the Unlock PDF tool first.` : app.message, "danger");
    } finally {
      setBusy(false);
    }
  };

  const replaceWith = async (files: FileList | null) => {
    const file = files?.[0];
    if (replaceInput.current) replaceInput.current.value = "";
    const target = selected[0];
    if (!file || !target) return;
    const bytes = await readFile(file);
    if (!bytes) return;
    setBusy(true);
    try {
      await store.replaceWithDocumentPage(target, file.name, bytes, 0);
      store.notify(`Replaced the page with the first page of ${file.name}.`, "success");
    } catch (error) {
      store.notify(toAppError(error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  const blankSize = () => {
    const reference = pages.find((p) => p.id === (selected[0] ?? view.currentPage)) ?? pages[0];
    return { width: reference?.width ?? 595, height: reference?.height ?? 842 };
  };

  const dropOn = (target: PageEntry, event: DragEvent) => {
    event.preventDefault();
    const moving = dragging ?? [];
    setDragging(null);
    setOver(null);
    if (moving.length === 0 || moving.includes(target.id)) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    const rest = pages.filter((p) => !moving.includes(p.id));
    const at = rest.findIndex((p) => p.id === target.id) + (after ? 1 : 0);
    store.movePages(moving, at);
  };

  const onlyOne = pages.length <= 1;
  const first = selected.length > 0 && selected.every((id) => id === pages[0]?.id);
  const last = selected.length > 0 && selected.every((id) => id === pages[pages.length - 1]?.id);

  const moveSelected = (direction: -1 | 1) => {
    const order = selected.map((id) => pages.findIndex((p) => p.id === id)).sort((a, b) => a - b);
    const rest = pages.filter((p) => !selected.includes(p.id));
    const target = direction < 0 ? Math.max(0, (order[0] as number) - 1) : Math.min(rest.length, (order[0] as number) + 1);
    store.movePages(selected, target);
  };

  const act = (label: string, icon: Parameters<typeof Icon>[0]["name"], run: () => void, disabled = false, testId?: string) => (
    <button type="button" className="ed-iconbtn" title={label} aria-label={label} disabled={disabled || busy} onClick={run} data-testid={testId}>
      <Icon name={icon} size={18} />
    </button>
  );

  return (
    <aside className="ed-sidebar" aria-label="Pages" data-testid="sidebar">
      <div className="ed-sidebar__tools" role="toolbar" aria-label="Page actions">
        {act("Rotate selected pages left", "rotate-left", () => store.rotatePages(selected, -90), selected.length === 0, "page-rotate-left")}
        {act("Rotate selected pages right", "rotate", () => store.rotatePages(selected, 90), selected.length === 0, "page-rotate-right")}
        {act("Duplicate selected pages", "copy", () => store.duplicatePages(selected), selected.length === 0, "page-duplicate")}
        {act("Delete selected pages", "trash", () => store.deletePages(selected), selected.length === 0 || selected.length >= pages.length, "page-delete")}
        {act("Insert a blank page after the selection", "plus", () => store.insertBlank(indexOfSelectionEnd, blankSize()), false, "page-blank")}
        {act("Add pages from another PDF", "file", () => insertInput.current?.click(), false, "page-add")}
        {act("Replace the selected page with a page from another PDF", "refresh", () => replaceInput.current?.click(), selected.length !== 1, "page-replace")}
        {act("Move the selected pages up", "arrow-up", () => moveSelected(-1), onlyOne || first, "page-up")}
        {act("Move the selected pages down", "arrow-down", () => moveSelected(1), onlyOne || last, "page-down")}
      </div>
      <input ref={insertInput} type="file" accept=".pdf,application/pdf" hidden data-testid="page-add-input" onChange={(event) => void insertFrom(event.target.files)} />
      <input ref={replaceInput} type="file" accept=".pdf,application/pdf" hidden data-testid="page-replace-input" onChange={(event) => void replaceWith(event.target.files)} />
      <ol className="ed-thumbs" data-testid="thumbs">
        {pages.map((page, index) => (
          <Thumb
            key={page.id}
            page={page}
            number={index + 1}
            selected={view.selectedPages.includes(page.id)}
            current={view.currentPage === page.id}
            dropBefore={over?.id === page.id && !over.after}
            dropAfter={over?.id === page.id && over.after}
            onClick={(event) => click(page, event)}
            onDragStart={(event) => {
              const ids = view.selectedPages.includes(page.id) ? view.selectedPages : [page.id];
              setDragging(ids);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", ids.join(","));
            }}
            onDragOver={(event) => {
              if (!dragging) return;
              event.preventDefault();
              const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
              setOver({ id: page.id, after: event.clientY > rect.top + rect.height / 2 });
            }}
            onDrop={(event) => dropOn(page, event)}
            onDragEnd={() => {
              setDragging(null);
              setOver(null);
            }}
          />
        ))}
      </ol>
    </aside>
  );
}

export { AppError };
