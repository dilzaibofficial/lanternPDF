import { useEffect, useRef } from "react";
import { Icon } from "../../components/ui/Icon";
import { TOOLS } from "./ToolBar";

const GENERAL: [string, string][] = [
  ["Ctrl+Z", "Undo"],
  ["Ctrl+Shift+Z or Ctrl+Y", "Redo"],
  ["Ctrl+S", "Download as…"],
  ["Ctrl+F", "Find and replace text"],
  ["Ctrl+C, Ctrl+X, Ctrl+V", "Copy, cut and paste objects"],
  ["Ctrl+D", "Duplicate the selection"],
  ["Ctrl+A", "Select every object on the page"],
  ["Delete", "Delete the selection"],
  ["Arrow keys (Shift for 10 pt)", "Nudge the selection"],
  ["Enter", "Edit the selected text box"],
  ["Escape", "Clear the selection, or go back to Select"],
  ["Ctrl+0 / Ctrl+9 / Ctrl+1", "Fit the page / fit the width / 100%"],
  ["Ctrl+ + / Ctrl+ −", "Zoom in / out (Ctrl and the mouse wheel work too)"],
  ["Space (held) and drag", "Pan the page"],
  ["Shift while drawing", "Straight or 45° lines; keep proportions"],
  ["Shift while rotating", "Turn in steps of 15°"],
  ["Alt while dragging", "Move without snapping"],
  ["?", "This list"],
];

/** Every shortcut in one place. It is generated from the tool list, so it cannot disagree with the buttons. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="ed-modal" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="ed-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" data-testid="shortcuts-dialog">
        <header className="ed-dialog__head">
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          <button ref={close} type="button" className="ed-iconbtn" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="ed-dialog__body ed-shortcuts">
          <section>
            <h3>Tools</h3>
            <dl>
              {TOOLS.filter((t) => t.key).map((tool) => (
                <div key={tool.id}>
                  <dt>
                    <kbd>{tool.key.toUpperCase()}</kbd>
                  </dt>
                  <dd>{tool.label}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section>
            <h3>Editing and view</h3>
            <dl>
              {GENERAL.map(([keys, what]) => (
                <div key={keys}>
                  <dt>
                    <kbd>{keys}</kbd>
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
