import { useEffect, useRef, useState } from "react";
import { toAppError } from "../../lib/errors";
import { type PdfSource, acquireDocument, renderPage } from "../../lib/pdf/pdfjs";
import { Icon } from "../ui/Icon";

interface PdfViewerProps {
  source: PdfSource;
  /** Accessible name for the preview region. */
  label?: string;
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3;

/** A compact page-by-page PDF preview: previous/next, jump to page, zoom, fit to width. */
export function PdfViewer({ source, label = "PDF preview" }: PdfViewerProps) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [stageWidth, setStageWidth] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pageInput, setPageInput] = useState("1");
  const sourceRef = useRef(source);
  sourceRef.current = source;

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setStageWidth(element.clientWidth));
    observer.observe(element);
    setStageWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  // Open the document and learn the page count.
  useEffect(() => {
    const lease = acquireDocument(sourceRef.current);
    let cancelled = false;
    setError(null);
    lease.promise
      .then((doc) => {
        if (cancelled) return;
        setPageCount(doc.numPages);
        setPage(1);
        setPageInput("1");
      })
      .catch((e) => !cancelled && setError(toAppError(e).message));
    return () => {
      cancelled = true;
      lease.release();
    };
  }, [source.key]);

  // Draw the current page.
  useEffect(() => {
    if (pageCount === 0 || stageWidth === 0) return;
    const controller = new AbortController();
    const lease = acquireDocument(sourceRef.current);
    void (async () => {
      try {
        const doc = await lease.promise;
        const pdfPage = await doc.getPage(page);
        if (controller.signal.aborted || !canvas.current) return;
        const fitWidth = Math.max(200, stageWidth - 32);
        await renderPage(pdfPage, canvas.current, { width: fitWidth * zoom, signal: controller.signal });
        pdfPage.cleanup();
      } catch (e) {
        if (!controller.signal.aborted) setError(toAppError(e).message);
      }
    })();
    return () => {
      controller.abort();
      lease.release();
    };
  }, [source.key, page, zoom, pageCount, stageWidth]);

  const go = (next: number) => {
    const clamped = Math.min(pageCount, Math.max(1, next));
    setPage(clamped);
    setPageInput(String(clamped));
  };

  return (
    <section className="viewer" aria-label={label} data-testid="pdf-viewer">
      <div className="viewer__bar">
        <div className="viewer__nav">
          <button type="button" className="btn btn--secondary btn--icon btn--sm" aria-label="Previous page" disabled={page <= 1} onClick={() => go(page - 1)}>
            <Icon name="chevron-left" size={18} />
          </button>
          <label className="sr-only" htmlFor="viewer-page">
            Page number
          </label>
          <input
            id="viewer-page"
            className="input"
            style={{ width: "4rem", minHeight: "2.25rem", textAlign: "center" }}
            inputMode="numeric"
            value={pageInput}
            onChange={(event) => setPageInput(event.target.value.replace(/\D/g, ""))}
            onBlur={() => go(Number.parseInt(pageInput, 10) || page)}
            onKeyDown={(event) => event.key === "Enter" && go(Number.parseInt(pageInput, 10) || page)}
          />
          <span aria-live="polite">of {pageCount || "…"}</span>
          <button type="button" className="btn btn--secondary btn--icon btn--sm" aria-label="Next page" disabled={page >= pageCount} onClick={() => go(page + 1)}>
            <Icon name="chevron-right" size={18} />
          </button>
        </div>
        <div className="viewer__nav">
          <button type="button" className="btn btn--secondary btn--icon btn--sm" aria-label="Zoom out" disabled={zoom <= MIN_ZOOM} onClick={() => setZoom((z) => Math.max(MIN_ZOOM, +(z - 0.25).toFixed(2)))}>
            <Icon name="zoom-out" size={18} />
          </button>
          <span style={{ minWidth: "3.2rem", textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
          <button type="button" className="btn btn--secondary btn--icon btn--sm" aria-label="Zoom in" disabled={zoom >= MAX_ZOOM} onClick={() => setZoom((z) => Math.min(MAX_ZOOM, +(z + 0.25).toFixed(2)))}>
            <Icon name="zoom-in" size={18} />
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setZoom(1)}>
            Fit width
          </button>
        </div>
      </div>
      <div className="viewer__stage" ref={stage}>
        {error ? (
          <p role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : pageCount === 0 ? (
          <div className="viewer__loading">
            <span className="spinner" aria-hidden="true" /> Loading preview…
          </div>
        ) : (
          <canvas ref={canvas} data-testid="viewer-canvas" />
        )}
      </div>
    </section>
  );
}
