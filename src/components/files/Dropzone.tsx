import { type DragEvent, type ReactNode, useId, useRef, useState } from "react";
import type { Rejection } from "../../lib/files";
import { Icon } from "../ui/Icon";

interface DropzoneProps {
  extensions: readonly string[];
  multiple: boolean;
  /** What to pick, e.g. "PDF files", "a PDF file", "images". */
  pickLabel: string;
  onFiles: (files: File[]) => void;
  compact?: boolean;
  disabled?: boolean;
  rejections?: readonly Rejection[];
  onDismissRejections?: () => void;
  /** A line under the button, e.g. where the file goes. */
  note?: ReactNode;
}

const hasFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes("Files");

/** Drag-and-drop target with a real button for keyboard and touch users. */
export function Dropzone({ extensions, multiple, pickLabel, onFiles, compact, disabled, rejections = [], onDismissRejections, note }: DropzoneProps) {
  const input = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const errorsId = useId();

  const choose = (list: FileList | null) => {
    if (list && list.length > 0) onFiles(Array.from(list));
    if (input.current) input.current.value = ""; // allow choosing the same file again
  };

  const onDragEnter = (event: DragEvent) => {
    if (disabled || !hasFiles(event)) return;
    event.preventDefault();
    depth.current += 1;
    setDragging(true);
  };
  const onDragOver = (event: DragEvent) => {
    if (disabled || !hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent) => {
    if (disabled || !hasFiles(event)) return;
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    choose(event.dataTransfer.files);
  };

  const buttonLabel = compact ? (multiple ? "Add more files" : "Choose a different file") : `Select ${pickLabel}`;

  return (
    <div
      className={`dropzone${compact ? " dropzone--compact" : ""}${dragging ? " is-dragging" : ""}`}
      data-testid="dropzone"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {!compact && (
        <span className="dropzone__icon">
          <Icon name="upload" size={30} />
        </span>
      )}
      <div style={{ display: "grid", gap: "var(--space-1)", justifyItems: compact ? "start" : "center" }}>
        <p className="dropzone__title">
          {dragging ? "Drop to add" : compact ? "Need another file?" : multiple ? "Drop your files here" : "Drop your file here"}
        </p>
        <p className="dropzone__hint">
          {compact ? "Drop here or use the button." : `or choose ${pickLabel} from your device. Accepts ${extensions.join(", ")}.`}
        </p>
      </div>
      <button
        type="button"
        className={`btn btn--primary${compact ? "" : " btn--lg"}`}
        disabled={disabled}
        onClick={() => input.current?.click()}
        aria-describedby={rejections.length > 0 ? errorsId : undefined}
      >
        <Icon name="plus" size={compact ? 18 : 22} />
        {buttonLabel}
      </button>
      <input
        ref={input}
        type="file"
        hidden
        data-testid="file-input"
        accept={extensions.join(",")}
        multiple={multiple}
        disabled={disabled}
        onChange={(event) => choose(event.target.files)}
      />
      {note && !compact && <p className="dropzone__privacy">{note}</p>}
      {rejections.length > 0 && (
        <ul className="dropzone__errors" id={errorsId} role="alert" data-testid="rejections">
          {rejections.map((rejection, index) => (
            <li key={`${rejection.name}-${index}`}>
              <div className="alert alert--warning" style={{ padding: "var(--space-3)" }}>
                <Icon name="alert" size={18} className="alert__icon" />
                <div className="alert__body">
                  <span style={{ color: "var(--text)" }}>{rejection.reason}</span>
                </div>
              </div>
            </li>
          ))}
          {onDismissRejections && (
            <li>
              <button type="button" className="btn btn--sm btn--ghost" onClick={onDismissRejections}>
                Dismiss
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
