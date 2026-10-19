import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { AppError } from "../errors";

/**
 * pdf.js is used for *showing* PDFs (thumbnails, previews, page rendering, text extraction).
 * Editing and structural changes are done by the qpdf and pdf-lib engines.
 *
 * Everything pdf.js needs at runtime (fonts, CMaps, WebAssembly decoders) is served from our own
 * origin under /pdfjs (copied from node_modules by scripts/copy-pdfjs-assets.mjs): no CDN requests.
 */
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ASSET_BASE = `${import.meta.env.BASE_URL}pdfjs/`;

export type { PDFDocumentProxy, PDFPageProxy };

function mapPdfJsError(error: unknown, fileName?: string): AppError {
  const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
  const code = error && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : undefined;
  const subject = fileName ? `"${fileName}"` : "This PDF";
  if (name === "PasswordException") {
    // pdf.js: 1 = a password is needed, 2 = the supplied password is wrong
    return code === 2
      ? new AppError("WRONG_PASSWORD", `That password is incorrect for ${subject}.`, { fileName })
      : new AppError("PASSWORD_REQUIRED", `${subject} is password-protected.`, { fileName });
  }
  if (name === "InvalidPDFException" || name === "FormatError" || name === "MissingPDFException") {
    return new AppError("DAMAGED_PDF", `${subject} could not be read. It may be damaged or not a valid PDF.`, {
      fileName,
      details: error instanceof Error ? error.message : undefined,
    });
  }
  if (name === "AbortException" || name === "RenderingCancelledException") {
    return new AppError("CANCELLED", "Rendering was cancelled.");
  }
  return new AppError("ENGINE_FAILED", `${subject} could not be displayed.`, {
    details: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

interface OpenHandle {
  doc: PDFDocumentProxy;
  destroy: () => Promise<void>;
}

export async function openPdf(bytes: Uint8Array, password?: string, fileName?: string): Promise<OpenHandle> {
  // pdf.js transfers the buffer to its worker, which would detach the caller's copy. Always pass a copy.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    password,
    cMapUrl: `${ASSET_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
    wasmUrl: `${ASSET_BASE}wasm/`,
    iccUrl: `${ASSET_BASE}iccs/`,
    enableXfa: false,
  });
  try {
    const doc = await task.promise;
    return { doc, destroy: () => task.destroy() };
  } catch (error) {
    void task.destroy();
    throw mapPdfJsError(error, fileName);
  }
}

// ---------------------------------------------------------------------------------------------
// Shared document cache: many components (file rows, page grids, previews) show the same PDF.
// ---------------------------------------------------------------------------------------------

interface CacheEntry {
  promise: Promise<OpenHandle>;
  refs: number;
  closeTimer?: ReturnType<typeof setTimeout>;
}

const cache = new Map<string, CacheEntry>();

export interface PdfSource {
  /** Identity of this exact content. Change it when the bytes change. */
  key: string;
  bytes: Uint8Array;
  password?: string;
  name?: string;
}

export interface DocLease {
  promise: Promise<PDFDocumentProxy>;
  release: () => void;
}

/** Opens (or reuses) the document for `source`. Call `release()` when the component is done. */
export function acquireDocument(source: PdfSource): DocLease {
  let entry = cache.get(source.key);
  if (!entry) {
    entry = { promise: openPdf(source.bytes, source.password, source.name), refs: 0 };
    cache.set(source.key, entry);
    // A failed open must not poison the cache.
    const created = entry;
    created.promise.catch(() => {
      if (cache.get(source.key) === created) cache.delete(source.key);
    });
  }
  if (entry.closeTimer) clearTimeout(entry.closeTimer);
  entry.refs += 1;
  const held = entry;
  let released = false;
  return {
    promise: held.promise.then((handle) => handle.doc),
    release: () => {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (held.refs <= 0) {
        // Keep it briefly: React re-mounts often during a state change.
        held.closeTimer = setTimeout(() => {
          if (held.refs <= 0 && cache.get(source.key) === held) {
            cache.delete(source.key);
            void held.promise.then((handle) => handle.destroy()).catch(() => undefined);
          }
        }, 4000);
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/** Runs at most `limit` tasks at once; the rest wait their turn. */
function createLimiter(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  const next = () => {
    active -= 1;
    waiting.shift()?.();
  };
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      next();
    }
  };
}

const renderLimit = createLimiter(3);

export interface RenderOptions {
  /** Target width in CSS pixels. Ignored when `scale` is given. */
  width?: number;
  /** Scale where 1 = 72 dpi (PDF points = CSS pixels). */
  scale?: number;
  /** Extra clockwise rotation in degrees, on top of the page's own. */
  rotation?: number;
  /** Device pixel ratio for crisp output; defaults to the screen's, capped at 2. */
  pixelRatio?: number;
  /** Leave the canvas's CSS size alone (the caller sizes it). */
  keepStyle?: boolean;
  /** Draw form fields' own appearance into the canvas (default). Turn off when the caller draws the fields itself. */
  drawForms?: boolean;
  /** Leave what the page does not paint transparent instead of white (the caller puts the paper behind it). */
  transparent?: boolean;
  signal?: AbortSignal;
}

export interface RenderedSize {
  /** Size in CSS pixels. */
  width: number;
  height: number;
}

/** Draws one page into `canvas` and returns its CSS size. */
export function renderPage(page: PDFPageProxy, canvas: HTMLCanvasElement, options: RenderOptions = {}): Promise<RenderedSize> {
  return renderLimit(async () => {
    if (options.signal?.aborted) throw new AppError("CANCELLED", "Rendering was cancelled.");
    const rotation = (page.rotate + (options.rotation ?? 0)) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    const scale = options.scale ?? (options.width ? options.width / base.width : 1);
    const ratio = options.pixelRatio ?? Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: scale * ratio, rotation });

    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const cssWidth = viewport.width / ratio;
    const cssHeight = viewport.height / ratio;
    if (!options.keepStyle) {
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    }

    // pdf.js asks the canvas for a context without an alpha channel, which turns "nothing drawn" into black; for a transparent
    // drawing we make the context ourselves.
    const context = options.transparent ? canvas.getContext("2d", { alpha: true }) : null;
    const task: RenderTask = page.render({
      canvas,
      ...(context ? { canvasContext: context } : {}),
      viewport,
      background: options.transparent ? "rgba(0,0,0,0)" : "#ffffff",
      annotationMode: options.drawForms === false ? pdfjs.AnnotationMode.ENABLE_FORMS : pdfjs.AnnotationMode.ENABLE,
    });
    const onAbort = () => task.cancel();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await task.promise;
    } catch (error) {
      throw mapPdfJsError(error);
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
    return { width: cssWidth, height: cssHeight };
  });
}

/** Renders a page to a Blob at a chosen resolution (used by PDF → image). */
export async function renderPageToBlob(
  page: PDFPageProxy,
  options: { dpi: number; format: "jpeg" | "png"; quality?: number; signal?: AbortSignal },
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  // pixelRatio 1 so the pixel size is exactly dpi/72 * page size.
  await renderPage(page, canvas, { scale: options.dpi / 72, pixelRatio: 1, signal: options.signal });
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, options.format === "jpeg" ? "image/jpeg" : "image/png", options.quality ?? 0.92),
  );
  // Release the bitmap memory promptly; large pages can be tens of megabytes.
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new AppError("OUT_OF_MEMORY", "A page was too large to render. Try a lower resolution.");
  return blob;
}
