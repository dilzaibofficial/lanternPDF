import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../components/ui/Icon";
import { stepZoom } from "../model/geometry";
import { type EditorObject, type Id, type ToolId } from "../model/types";
import { useSnapshot, useStore } from "../state/context";
import { ExportDialog } from "./ExportDialog";
import { FindBar } from "./FindBar";
import { OtherToolDialog } from "./OtherToolDialog";
import { Properties } from "./Properties";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { Sidebar } from "./Sidebar";
import { TOOLS, ToolBar } from "./ToolBar";
import { TopBar } from "./TopBar";
import { ViewBar } from "./ViewBar";
import { Viewport } from "./Viewport";

const NUDGE = 1;

/** True when the key press is going into a field the person is typing in. */
function typing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]), textarea, select, [contenteditable='true']"));
}

interface ShellProps {
  onClose: () => void;
}

/** The whole editor: bars, panels, the page area, dialogs and the keyboard. */
export function Shell({ onClose }: ShellProps) {
  const store = useStore();
  const { doc, view, dirty } = useSnapshot();
  const [dialog, setDialog] = useState<null | "export" | "shortcuts" | "tool">(null);
  const [finding, setFinding] = useState(false);
  const clipboard = useRef<EditorObject[]>([]);
  const shell = useRef<HTMLDivElement>(null);

  // On a phone the side panels cover the page, so they start closed.
  useEffect(() => {
    if (window.matchMedia("(max-width: 900px)").matches) store.setView({ sidebar: false, panel: false });
  }, [store]);

  // Leaving the page would lose the work.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const currentPageId = useCallback((): Id | null => store.state.view.currentPage ?? store.doc.pages[0]?.id ?? null, [store]);

  const selectedObjects = useCallback((): EditorObject[] => store.objects(store.state.view.selection), [store]);

  const copy = useCallback(() => {
    const all = selectedObjects();
    // Things the page already draws are not copied (they are not objects of the editor's own); say so rather than do nothing.
    const objects = all.filter((o) => o.kind !== "existing");
    if (objects.length === 0) {
      if (all.length > 0) store.notify("Things that are already part of the page cannot be copied. You can move them, resize them or delete them.", "info");
      return false;
    }
    clipboard.current = objects;
    return true;
  }, [selectedObjects, store]);

  const paste = useCallback(() => {
    if (clipboard.current.length === 0) return;
    const page = currentPageId();
    if (!page) return;
    // Pasted copies land a little off the originals so they can be told apart.
    const created = store.pasteObjects(clipboard.current, page, 14);
    if (created.length === 0) store.notify("Nothing to paste.", "info");
  }, [currentPageId, store]);

  const nudge = useCallback(
    (dx: number, dy: number) => {
      const objects = selectedObjects().filter((o) => !o.locked);
      if (objects.length === 0) return;
      store.moveObjects(objects, dx, dy);
    },
    [selectedObjects, store],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialog) return;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const inField = typing(event.target);

      if (mod && key === "f") {
        event.preventDefault();
        setFinding(true);
        return;
      }
      if (mod && key === "s") {
        event.preventDefault();
        setDialog("export");
        return;
      }
      if (inField) return;
      // Keys pressed while a menu has the focus belong to the menu (arrows, Enter, letters), not to the tools.
      if (!mod && (event.target as HTMLElement | null)?.closest?.(".ed-popover")) return;

      if (mod && key === "z") {
        event.preventDefault();
        if (event.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (mod && key === "y") {
        event.preventDefault();
        store.redo();
        return;
      }
      if (mod && key === "c") {
        if (copy()) event.preventDefault();
        return;
      }
      if (mod && key === "x") {
        if (copy()) {
          event.preventDefault();
          store.removeObjects(
            selectedObjects().filter((o) => o.kind !== "existing").map((o) => o.id),
            "Cut",
          );
        }
        return;
      }
      if (mod && key === "v") {
        if (clipboard.current.length > 0) {
          event.preventDefault();
          paste();
        }
        return;
      }
      if (mod && key === "d") {
        event.preventDefault();
        if (store.state.view.selection.length > 0) store.duplicate(store.state.view.selection);
        return;
      }
      if (mod && key === "g") {
        event.preventDefault();
        if (event.shiftKey) store.ungroup(store.state.view.selection);
        else store.group(store.state.view.selection);
        return;
      }
      if (mod && key === "a") {
        const page = currentPageId();
        if (!page) return;
        event.preventDefault();
        store.select(store.objectsOn(page).filter((o) => !o.locked).map((o) => o.id));
        store.setView({ tool: "select" });
        return;
      }
      if (mod && (key === "=" || key === "+")) {
        event.preventDefault();
        store.setZoom(stepZoom(store.state.view.zoom, 1));
        return;
      }
      if (mod && (key === "-" || key === "_")) {
        event.preventDefault();
        store.setZoom(stepZoom(store.state.view.zoom, -1));
        return;
      }
      if (mod && key === "0") {
        event.preventDefault();
        store.setZoom(store.state.view.zoom, "fit-page");
        return;
      }
      if (mod && key === "9") {
        event.preventDefault();
        store.setZoom(store.state.view.zoom, "fit-width");
        return;
      }
      if (mod && key === "1") {
        event.preventDefault();
        store.setZoom(1);
        return;
      }
      if (mod || event.altKey) return;

      if (event.key === "Escape") {
        if (finding) {
          setFinding(false);
          return;
        }
        if (store.state.view.lineEditing || store.state.view.editing) return; // those editors handle Escape themselves
        if (store.state.view.line) {
          store.selectLine(null);
          return;
        }
        if (store.state.view.selection.length > 0) store.select([]);
        else store.setTool("select");
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        const selection = store.state.view.selection;
        if (selection.length > 0) {
          event.preventDefault();
          store.removeObjects(selection);
        } else if (store.state.view.selectedPages.length > 0 && event.key === "Delete" && document.activeElement?.closest(".ed-sidebar")) {
          store.deletePages(store.state.view.selectedPages);
        }
        return;
      }
      if (event.key.startsWith("Arrow")) {
        const step = (event.shiftKey ? 10 : NUDGE) * (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1);
        if (store.state.view.selection.length > 0 && !document.activeElement?.closest("button")) {
          event.preventDefault();
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") nudge(step, 0);
          else nudge(0, step);
        }
        return;
      }
      if (event.key === "PageDown" || event.key === "PageUp") {
        const pages = store.doc.pages;
        const at = pages.findIndex((p) => p.id === store.state.view.currentPage);
        const next = pages[at + (event.key === "PageDown" ? 1 : -1)];
        if (next && store.state.view.viewMode === "single") {
          event.preventDefault();
          store.setView({ currentPage: next.id, selectedPages: [next.id] });
        }
        return;
      }
      if (event.key === "Enter") {
        const only = store.state.view.selection.length === 1 ? store.object(store.state.view.selection[0] as Id) : null;
        if (only?.kind === "text" && !document.activeElement?.closest("button")) {
          event.preventDefault();
          store.startEditing(only.id);
        } else if (only?.kind === "existing" && only.what === "text" && only.lines?.[0] && !document.activeElement?.closest("button")) {
          event.preventDefault();
          store.selectLine({ page: only.page, lineId: only.lines[0].id });
        }
        return;
      }
      if (event.key === "?") {
        setDialog("shortcuts");
        return;
      }
      const tool = TOOLS.find((t) => t.key !== "" && t.key === key);
      if (tool) {
        event.preventDefault();
        if (tool.id === "image") document.querySelector<HTMLInputElement>("[data-testid=image-input]")?.click();
        else store.setTool(tool.id as ToolId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store, dialog, finding, copy, paste, currentPageId, nudge, selectedObjects]);

  const notice = view.notice;
  const pageCount = doc.pages.length;

  return (
    <div ref={shell} className={`ed${view.sidebar ? " ed--sidebar" : ""}${view.panel ? " ed--panel" : ""}`} data-testid="editor" data-tool={view.tool} data-pages={pageCount}>
      <TopBar onExport={() => setDialog("export")} onShortcuts={() => setDialog("shortcuts")} onClose={onClose} onFind={() => setFinding(true)} onOtherTool={() => setDialog("tool")} />
      <ToolBar />
      <div className="ed-body">
        {view.sidebar && <Sidebar />}
        <main className="ed-main" id="editor-main">
          {finding && <FindBar onClose={() => setFinding(false)} />}
          <Viewport />
          <ViewBar />
          {notice && (
            <div className={`ed-toast ed-toast--${notice.tone}`} role={notice.tone === "danger" || notice.tone === "warning" ? "alert" : "status"} data-testid="notice">
              <span>{notice.text}</span>
              <button type="button" className="ed-iconbtn" aria-label="Dismiss" onClick={() => store.dismissNotice()}>
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
        </main>
        {view.panel && <Properties />}
      </div>
      {dialog === "export" && <ExportDialog onClose={() => setDialog(null)} />}
      {dialog === "shortcuts" && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog === "tool" && <OtherToolDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
