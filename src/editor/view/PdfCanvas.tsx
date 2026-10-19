import { type RefObject, useEffect, useRef, useState } from "react";
import { toAppError } from "../../lib/errors";
import { type PdfSource, acquireDocument, renderPage } from "../../lib/pdf/pdfjs";
import { useDebounced } from "../../hooks/useDebounced";

/** Largest canvas we will draw, in pixels. Beyond it the page is drawn at a lower resolution and scaled up. */
export const MAX_CANVAS_PIXELS = 30_000_000;

/** Device pixels per CSS pixel to render at: the screen's (up to 2), lowered so the canvas stays within the memory budget. */
// eslint-disable-next-line react-refresh/only-export-components -- shared helper kept next to the code that uses it
export function pixelRatioFor(cssWidth: number, cssHeight: number): number {
  const dpr = Math.min(typeof window === "undefined" ? 1 : window.devicePixelRatio || 1, 2);
  const budget = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, cssWidth * cssHeight));
  return Math.max(0.2, Math.min(dpr, budget));
}

interface PdfCanvasProps {
  /** What to draw, or null for a blank white page. */
  source: PdfSource | null;
  /** 1-based page of `source`. */
  pageNumber: number;
  /** The page's size in points (as shown, before the editor's own rotation). */
  width: number;
  height: number;
  zoom: number;
  /** Only pages near the screen are drawn; the canvas memory of the others is released. */
  active: boolean;
  label: string;
  /** Called after each successful draw, with the key of what was drawn (null for a blank page). */
  onDrawn?: (key: string | null) => void;
  /** Gives the caller the canvas, to copy pixels out of it. */
  canvasRef?: RefObject<HTMLCanvasElement | null>;
}

/**
 * One page drawn by pdf.js. While the zoom is changing the old bitmap is simply scaled by the browser; a sharp
 * redraw follows when it settles, drawn off-screen and swapped in at once so the page never flashes blank.
 */
export function PdfCanvas({ source, pageNumber, width, height, zoom, active, label, onDrawn, canvasRef }: PdfCanvasProps) {
  const own = useRef<HTMLCanvasElement>(null);
  const canvas = canvasRef ?? own;
  const [state, setState] = useState<"idle" | "drawing" | "ready" | "failed">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const renderZoom = useDebounced(zoom, 160);
  const drawn = useRef(onDrawn);
  drawn.current = onDrawn;
  const sourceRef = useRef(source);
  sourceRef.current = source;

  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    if (!active || !sourceRef.current) {
      // Give the pixels back while off screen.
      if (!active) {
        target.width = 0;
        target.height = 0;
        setState("idle");
      }
      return;
    }
    const controller = new AbortController();
    const drawKey = sourceRef.current.key;
    const lease = acquireDocument(sourceRef.current);
    setState((s) => (s === "ready" ? s : "drawing"));
    void (async () => {
      try {
        const doc = await lease.promise;
        const page = await doc.getPage(pageNumber);
        if (controller.signal.aborted) return;
        const ratio = pixelRatioFor(width * renderZoom, height * renderZoom);
        const scratch = document.createElement("canvas");
        await renderPage(page, scratch, { scale: renderZoom, pixelRatio: ratio, keepStyle: true, transparent: true, signal: controller.signal });
        page.cleanup();
        const visible = canvas.current;
        if (controller.signal.aborted || !visible) {
          scratch.width = 0;
          return;
        }
        visible.width = scratch.width;
        visible.height = scratch.height;
        visible.getContext("2d")?.drawImage(scratch, 0, 0);
        scratch.width = 0;
        scratch.height = 0;
        setState("ready");
        setMessage(null);
        drawn.current?.(drawKey);
      } catch (error) {
        if (controller.signal.aborted) return;
        const app = toAppError(error);
        if (app.code === "CANCELLED") return;
        setState("failed");
        setMessage(app.message);
      }
    })();
    return () => {
      controller.abort();
      lease.release();
    };
    // `source` is read through a ref; its key says whether the content changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, source?.key, pageNumber, renderZoom, width, height]);

  return (
    <>
      {source === null && <div className="ed-blank" aria-hidden="true" />}
      <canvas ref={canvas} className="ed-canvas" role="img" aria-label={label} hidden={source === null} />
      {state === "drawing" && source !== null && (
        <span className="ed-canvas__status" role="status">
          <span className="spinner" aria-hidden="true" /> <span className="sr-only">Drawing {label}</span>
        </span>
      )}
      {state === "failed" && (
        <span className="ed-canvas__status ed-canvas__status--error" role="alert">
          {message ?? "This page could not be drawn."}
        </span>
      )}
    </>
  );
}
