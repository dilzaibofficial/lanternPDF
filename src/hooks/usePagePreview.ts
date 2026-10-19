import { useEffect, useRef, useState } from "react";
import type { PdfItem } from "./usePdfFiles";
import { toPdfInput } from "./usePdfFiles";
import { toAppError } from "../lib/errors";
import { runOperation } from "../lib/worker/client";

export interface PagePreviewState {
  /** A one-page PDF with the chosen page of the source, or null while it is being prepared. */
  bytes: Uint8Array | null;
  error: string | null;
}

/** Extracts one page of the document (a cheap qpdf job) so a live preview can work on just that page. */
export function useSinglePage(item: PdfItem, page: number): PagePreviewState {
  const [state, setState] = useState<PagePreviewState>({ bytes: null, error: null });
  const cache = useRef(new Map<string, Uint8Array>());

  useEffect(() => {
    const key = `${item.id}:${item.revision}:${page}`;
    const hit = cache.current.get(key);
    if (hit) {
      setState({ bytes: hit, error: null });
      return;
    }
    let cancelled = false;
    setState((current) => ({ bytes: current.bytes, error: null }));
    runOperation("selectPages", { input: toPdfInput(item), pages: [page] })
      .then((file) => {
        if (cancelled) return;
        cache.current.set(key, file.bytes);
        setState({ bytes: file.bytes, error: null });
      })
      .catch((error) => !cancelled && setState({ bytes: null, error: toAppError(error).message }));
    return () => {
      cancelled = true;
    };
  }, [item, page]);

  return state;
}

export interface LivePreview {
  bytes: Uint8Array | null;
  busy: boolean;
  /** Why the preview could not be made (usually: the current settings are invalid). */
  error: string | null;
}

/**
 * Runs `compute` on the one-page source whenever it or `settings` change, and keeps the last good result
 * visible while the next one is being made. `settings` must be a stable (memoised/debounced) value.
 */
export function useLivePreview(source: Uint8Array | null, settings: unknown, compute: (source: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>): LivePreview {
  const [preview, setPreview] = useState<LivePreview>({ bytes: null, busy: false, error: null });
  const computeRef = useRef(compute);
  computeRef.current = compute;

  useEffect(() => {
    if (!source) return;
    const controller = new AbortController();
    setPreview((current) => ({ ...current, busy: true }));
    computeRef
      .current(source, controller.signal)
      .then((bytes) => !controller.signal.aborted && setPreview({ bytes, busy: false, error: null }))
      .catch((error) => {
        if (controller.signal.aborted) return;
        // Keep the previous picture on screen; just say what is wrong.
        setPreview((current) => ({ bytes: current.bytes, busy: false, error: toAppError(error).message }));
      });
    return () => controller.abort();
  }, [source, settings]);

  return preview;
}
