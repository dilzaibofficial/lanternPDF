import type { ApiError, Capabilities, OfficeTarget } from "../../shared/api";
import { AppError, type ErrorCode } from "./errors";

/** Base URL of the optional server. Empty means "same origin" (the default and the dev proxy). */
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export async function fetchCapabilities(signal?: AbortSignal): Promise<Capabilities | null> {
  try {
    const response = await fetch(`${API_BASE}/api/capabilities`, { signal, headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return isCapabilities(body) ? body : null;
  } catch {
    return null; // no server, offline, or blocked: the browser-only tools still work
  }
}

function isCapabilities(value: unknown): value is Capabilities {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Capabilities>;
  return typeof candidate.limits?.maxUploadBytes === "number" && typeof candidate.engines?.libreoffice?.available === "boolean";
}

interface UploadOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number, message?: string) => void;
}

const SERVER_CODES: Record<string, ErrorCode> = {
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  INVALID_FILE: "INVALID_FILE",
  ENGINE_UNAVAILABLE: "SERVER_UNAVAILABLE",
  RATE_LIMITED: "SERVER_ERROR",
  BUSY: "SERVER_ERROR",
  TIMEOUT: "SERVER_ERROR",
  CONVERSION_FAILED: "SERVER_ERROR",
};

/**
 * POSTs one file as multipart form data and returns the response body as bytes. Uses XMLHttpRequest
 * because `fetch` cannot report upload progress.
 */
function upload(path: string, file: { name: string; bytes: Uint8Array }, fields: Record<string, string>, options: UploadOptions): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const { signal, onProgress } = options;
    if (signal?.aborted) {
      reject(new AppError("CANCELLED", "The operation was cancelled."));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}${path}`);
    xhr.responseType = "arraybuffer";

    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    // Append the file last so servers can validate the fields before reading the (large) body.
    form.append("file", new Blob([file.bytes as BlobPart]), file.name);

    const onAbort = () => xhr.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => signal?.removeEventListener("abort", onAbort);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.((event.loaded / event.total) * 0.4, "Sending the file to the server");
    };
    xhr.upload.onload = () => onProgress?.(0.4, "Converting on the server");

    xhr.onload = () => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(new Uint8Array(xhr.response as ArrayBuffer));
        return;
      }
      reject(parseErrorBody(xhr));
    };
    xhr.onerror = () => {
      done();
      reject(new AppError("NETWORK", "Could not reach the server."));
    };
    xhr.onabort = () => {
      done();
      reject(new AppError("CANCELLED", "The operation was cancelled."));
    };
    xhr.send(form);
  });
}

function parseErrorBody(xhr: XMLHttpRequest): AppError {
  try {
    const text = new TextDecoder().decode(xhr.response as ArrayBuffer);
    const body = JSON.parse(text) as Partial<ApiError>;
    const code = body.error?.code ?? "";
    const message = body.error?.message ?? `The server returned an error (${xhr.status}).`;
    return new AppError(SERVER_CODES[code] ?? "SERVER_ERROR", message, { details: `HTTP ${xhr.status} ${code}`.trim() });
  } catch {
    if (xhr.status === 404 || xhr.status === 502 || xhr.status === 503) {
      return new AppError("SERVER_UNAVAILABLE", "The conversion server is not available.", { details: `HTTP ${xhr.status}` });
    }
    return new AppError("SERVER_ERROR", `The server returned an unexpected response (${xhr.status}).`);
  }
}

/** Word / Excel / PowerPoint (and OpenDocument) -> PDF, using LibreOffice on the server. */
export function convertOfficeToPdf(file: { name: string; bytes: Uint8Array }, options: UploadOptions = {}): Promise<Uint8Array> {
  return upload("/api/convert/office-to-pdf", file, {}, options);
}

/** PDF -> editable Word / PowerPoint, using LibreOffice on the server. */
export function convertPdfToOffice(file: { name: string; bytes: Uint8Array }, target: OfficeTarget, options: UploadOptions = {}): Promise<Uint8Array> {
  return upload("/api/convert/pdf-to-office", file, { target }, options);
}

/** Stronger compression with Ghostscript on the server. */
export function compressOnServer(file: { name: string; bytes: Uint8Array }, level: "screen" | "ebook" | "printer", options: UploadOptions = {}): Promise<Uint8Array> {
  return upload("/api/compress", file, { level }, options);
}
