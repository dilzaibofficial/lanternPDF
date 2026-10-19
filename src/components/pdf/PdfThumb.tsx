import { useEffect, useRef, useState } from "react";
import { type PdfSource, acquireDocument, renderPage } from "../../lib/pdf/pdfjs";
import { Icon } from "../ui/Icon";

interface PdfThumbProps {
  source: PdfSource;
  /** 1-based page number. */
  pageNumber: number;
  /** Rendered width in CSS pixels. */
  width: number;
  /** Extra clockwise rotation in degrees (for previewing a pending rotation). */
  rotation?: number;
  /** Accessible description. Thumbnails are decorative when omitted. */
  label?: string;
}

/**
 * One page of a PDF drawn into a canvas. It renders lazily, only once scrolled near the viewport, and
 * shares the opened document with every other thumbnail of the same file.
 */
export function PdfThumb({ source, pageNumber, width, rotation = 0, label }: PdfThumbProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  // Parents often build `source` inline; only its `key` says whether the content changed.
  const sourceRef = useRef(source);
  sourceRef.current = source;

  // Watch the canvas itself: an element with `display: contents` has no box and is never "visible".
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const lease = acquireDocument(sourceRef.current);
    setFailed(false);
    void (async () => {
      try {
        const doc = await lease.promise;
        const page = await doc.getPage(pageNumber);
        if (controller.signal.aborted || !canvas.current) return;
        await renderPage(page, canvas.current, { width, rotation, signal: controller.signal });
        page.cleanup();
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();
    return () => {
      controller.abort();
      lease.release();
    };
  }, [visible, source.key, pageNumber, width, rotation]);

  if (failed) {
    return <Icon name="file" size={Math.max(20, width / 2)} label={label ? `${label} (preview unavailable)` : undefined} />;
  }
  return <canvas ref={canvas} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}
