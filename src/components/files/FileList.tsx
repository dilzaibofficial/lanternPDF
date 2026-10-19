import { type DragEvent, type ReactNode, useRef, useState } from "react";
import { Icon } from "../ui/Icon";

export interface FileRowModel {
  id: string;
  name: string;
  subtitle?: ReactNode;
  thumb: ReactNode;
  status?: { tone: "error" | "muted"; text: string };
  /** Content shown below the row, e.g. a password prompt. */
  extra?: ReactNode;
}

interface FileListProps {
  rows: readonly FileRowModel[];
  onMove: (from: number, to: number) => void;
  onRemove: (id: string) => void;
  /** Show drag handles and move buttons. */
  sortable?: boolean;
  label: string;
}

/**
 * A reorderable list of files. Mouse users drag the handle; keyboard and touch users use the
 * "move up / move down" buttons. Every move is announced to screen readers.
 */
export function FileList({ rows, onMove, onRemove, sortable = true, label }: FileListProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const dragging = useRef(false);

  const move = (from: number, to: number) => {
    const row = rows[from];
    if (!row || to < 0 || to >= rows.length) return;
    onMove(from, to);
    setAnnouncement(`Moved ${row.name} to position ${to + 1} of ${rows.length}.`);
  };

  const onDragStart = (event: DragEvent, index: number) => {
    dragging.current = true;
    setDragIndex(index);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(index));
  };
  const onDragOver = (event: DragEvent, index: number) => {
    if (dragIndex === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setOverIndex(index);
  };
  const onDrop = (event: DragEvent, index: number) => {
    if (dragIndex === null) return;
    event.preventDefault();
    if (dragIndex !== index) move(dragIndex, index);
    setDragIndex(null);
    setOverIndex(null);
  };
  const onDragEnd = () => {
    dragging.current = false;
    setDragIndex(null);
    setOverIndex(null);
  };

  return (
    <>
      <ul className="file-list" aria-label={label} data-testid="file-list">
        {rows.map((row, index) => (
          <li
            key={row.id}
            className={`file-row${dragIndex === index ? " is-dragging" : ""}${overIndex === index && dragIndex !== index ? " is-drop-target" : ""}`}
            data-testid="file-row"
            draggable={sortable && rows.length > 1}
            onDragStart={(event) => onDragStart(event, index)}
            onDragOver={(event) => onDragOver(event, index)}
            onDrop={(event) => onDrop(event, index)}
            onDragEnd={onDragEnd}
          >
            {sortable && rows.length > 1 && (
              <span className="file-row__handle" aria-hidden="true" title="Drag to reorder">
                <Icon name="grip" size={18} />
              </span>
            )}
            <span className="file-row__thumb">{row.thumb}</span>
            <div className="file-row__info">
              <div className="file-row__name" title={row.name}>
                {row.name}
              </div>
              <div className="file-row__meta">
                {row.status && <span className={row.status.tone === "error" ? "file-row__status--error" : undefined}>{row.status.text}</span>}
                {row.subtitle}
              </div>
            </div>
            <div className="file-row__actions">
              {sortable && rows.length > 1 && (
                <>
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon btn--sm"
                    aria-label={`Move ${row.name} up`}
                    disabled={index === 0}
                    onClick={() => move(index, index - 1)}
                  >
                    <Icon name="arrow-up" size={18} />
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon btn--sm"
                    aria-label={`Move ${row.name} down`}
                    disabled={index === rows.length - 1}
                    onClick={() => move(index, index + 1)}
                  >
                    <Icon name="arrow-down" size={18} />
                  </button>
                </>
              )}
              <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label={`Remove ${row.name}`} onClick={() => onRemove(row.id)}>
                <Icon name="close" size={18} />
              </button>
            </div>
            {row.extra && <div className="file-row__extra">{row.extra}</div>}
          </li>
        ))}
      </ul>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </>
  );
}
