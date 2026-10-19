import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { categoryOf, searchTools } from "../../config/tools";
import { Icon } from "../ui/Icon";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Ctrl/⌘+K quick switcher: type to filter the tools, arrows to move, Enter to open. */
export function CommandPalette({ open, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const listId = useId();

  const results = searchTools(query);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setQuery("");
      setActive(0);
      dialog.showModal();
      inputRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const choose = (index: number) => {
    const tool = results[index];
    if (!tool) return;
    onClose();
    navigate(`/tools/${tool.id}`);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(results.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(active);
    }
  };

  return (
    <dialog ref={dialogRef} className="palette" aria-label="Find a tool" onClose={onClose} onClick={(event) => event.target === dialogRef.current && onClose()}>
      <div className="palette__input-row">
        <Icon name="search" />
        <input
          ref={inputRef}
          className="palette__input"
          type="search"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={results[active] ? `${listId}-${results[active].id}` : undefined}
          aria-label="Search tools"
          placeholder="Search tools, e.g. merge, compress, rotate…"
          autoComplete="off"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <kbd>Esc</kbd>
      </div>
      <div id={listId} role="listbox" aria-label="Matching tools" className="palette__list">
        {results.length === 0 ? (
          <p className="palette__empty">No tool matches “{query}”.</p>
        ) : (
          results.map((tool, index) => (
            <div
              key={tool.id}
              id={`${listId}-${tool.id}`}
              role="option"
              aria-selected={index === active}
              data-cat={tool.category}
              className="palette__item"
              onMouseMove={() => setActive(index)}
              onClick={() => choose(index)}
            >
              <Icon name={tool.icon} />
              <span>
                <strong>{tool.name}</strong>
                <small>
                  {categoryOf(tool).name} · {tool.short}
                </small>
              </span>
            </div>
          ))
        )}
      </div>
    </dialog>
  );
}
