import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toAppError } from "../../lib/errors";
import { acquireDocument, renderPage } from "../../lib/pdf/pdfjs";

interface PagePreviewProps {
  /** A PDF whose first page is shown. `null` shows a loading state. */
  bytes: Uint8Array | null;
  busy?: boolean;
  error?: string | null;
  /** Accessible description of what the preview shows. */
  label: string;
  /** Largest width in CSS pixels; the preview also shrinks to fit its container. */
  maxWidth?: number;
  /** Reports the displayed page size in PDF points, once known. */
  onSize?: (size: { width: number; height: number }) => void;
  /** Drawn on top of the page (for example a crop box), positioned relative to the page. */
  children?: ReactNode;
}

let counter = 0;

/**
 * Shows the first page of a PDF, scaled to fit. When `bytes` change the new page is drawn off-screen and
 * swapped in at once, so a live preview updates without flashing blank.
 */
export function PagePreview({ bytes, busy, error, label, maxWidth = 720, onSize, children }: PagePreviewProps) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hostWidth, setHostWidth] = useState(0);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [drawError, setDrawError] = useState<string | null>(null);
  const onSizeRef = useRef(onSize);
  onSizeRef.current = onSize;
  const key = useMemo(() => (bytes ? `preview-${(counter += 1)}` : null), [bytes]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHostWidth(element.clientWidth));
    observer.observe(element);
    setHostWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!bytes || !key || hostWidth === 0) return;
    const controller = new AbortController();
    const lease = acquireDocument({ key, bytes });
    void (async () => {
      try {
        const doc = await lease.promise;
        const page = await doc.getPage(1);
        if (controller.signal.aborted) return;
        const view = page.getViewport({ scale: 1 });
        const width = Math.min(maxWidth, hostWidth);
        const scratch = document.createElement("canvas");
        const rendered = await renderPage(page, scratch, { width, signal: controller.signal });
        page.cleanup();
        const target = canvas.current;
        if (controller.signal.aborted || !target) return;
        // Swap in the finished picture in one go.
        target.width = scratch.width;
        target.height = scratch.height;
        target.style.width = `${rendered.width}px`;
        target.style.height = `${rendered.height}px`;
        target.getContext("2d")?.drawImage(scratch, 0, 0);
        setSize({ width: rendered.width, height: rendered.height });
        setDrawError(null);
        onSizeRef.current?.({ width: view.width, height: view.height });
      } catch (caught) {
        if (!controller.signal.aborted) setDrawError(toAppError(caught).message);
      }
    })();
    return () => {
      controller.abort();
      lease.release();
    };
  }, [bytes, key, hostWidth, maxWidth]);

  const problem = error ?? drawError;
  return (
    <div className="preview" ref={host} data-testid="page-preview" aria-busy={busy || undefined}>
      <div className="preview__stage" style={size ? { width: size.width, height: size.height } : undefined}>
        <canvas ref={canvas} role="img" aria-label={label} data-testid="preview-canvas" style={{ visibility: size ? "visible" : "hidden" }} />
        {!size && !problem && (
          <div className="viewer__loading" role="status">
            <span className="spinner" aria-hidden="true" /> Preparing preview…
          </div>
        )}
        {size && children && <div className="preview__overlay">{children}</div>}
        {busy && size && (
          <span className="preview__busy" role="status">
            <span className="spinner" aria-hidden="true" /> Updating…
          </span>
        )}
      </div>
      {problem && (
        <p className="preview__error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
