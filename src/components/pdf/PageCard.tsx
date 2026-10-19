import type { DragEventHandler, ReactNode } from "react";
import type { PdfSource } from "../../lib/pdf/pdfjs";
import { Icon } from "../ui/Icon";
import { PdfThumb } from "./PdfThumb";

export const PAGE_THUMB_WIDTH = 136;

interface PageCardProps {
  source: PdfSource;
  /** 1-based page number within `source`. */
  pageNumber: number;
  /** Text under the thumbnail, e.g. "Page 3". */
  label: string;
  /** Pending rotation in degrees, previewed in the thumbnail. */
  rotation?: number;
  state?: "normal" | "selected" | "removed";
  /** Makes the whole card a toggle button (selection mode). */
  onToggle?: () => void;
  /** Colour-codes pages by their source file, 0-5. */
  sourceIndex?: number;
  /** Small pill at the top-left, e.g. a position number. */
  badge?: ReactNode;
  /** Buttons shown under the thumbnail (organize mode). Not allowed together with `onToggle`. */
  tools?: ReactNode;
  dragging?: boolean;
  dropTarget?: boolean;
  draggable?: boolean;
  onDragStart?: DragEventHandler;
  onDragOver?: DragEventHandler;
  onDrop?: DragEventHandler;
  onDragEnd?: DragEventHandler;
  testId?: string;
}

/** One page as a card: thumbnail, label, and either click-to-select or a row of action buttons. */
export function PageCard({
  source,
  pageNumber,
  label,
  rotation = 0,
  state = "normal",
  onToggle,
  sourceIndex,
  badge,
  tools,
  dragging,
  dropTarget,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  testId = "page-card",
}: PageCardProps) {
  const className = [
    "page-card",
    sourceIndex !== undefined ? `page-card--source-${sourceIndex % 6}` : "",
    state === "selected" ? "is-selected" : "",
    state === "removed" ? "is-removed" : "",
    dragging ? "is-dragging" : "",
    dropTarget ? "is-drop-target" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const inner = (
    <>
      {badge && <span className="page-card__badge">{badge}</span>}
      {state === "selected" && (
        <span className="page-card__check">
          <Icon name="check" size={14} strokeWidth={3} />
        </span>
      )}
      <span className="page-card__thumb">
        <PdfThumb source={source} pageNumber={pageNumber} width={PAGE_THUMB_WIDTH} rotation={rotation} />
      </span>
      {state === "removed" && (
        <span className="page-card__cross" aria-hidden="true">
          <Icon name="close" size={56} strokeWidth={2} />
        </span>
      )}
      <span className="page-card__label">{label}</span>
    </>
  );

  if (onToggle) {
    return (
      <li style={{ display: "contents" }}>
        <button
          type="button"
          className={className}
          aria-pressed={state === "selected" || state === "removed"}
          aria-label={`${label}${state === "removed" ? ", marked for removal" : state === "selected" ? ", selected" : ""}`}
          data-testid={testId}
          data-page={pageNumber}
          onClick={onToggle}
        >
          {inner}
        </button>
      </li>
    );
  }

  return (
    <li
      className={className}
      data-testid={testId}
      data-page={pageNumber}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      {inner}
      {tools && <div className="page-card__tools">{tools}</div>}
    </li>
  );
}
