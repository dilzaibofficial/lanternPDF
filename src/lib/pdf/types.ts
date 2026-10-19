/** Shared types for the PDF engine. Nothing in here depends on the DOM or on Node. */

export interface JobContext {
  /** Called with a 0..1 fraction and an optional human-readable step. Must be cheap. */
  onProgress?: (fraction: number, message?: string) => void;
}

/** A PDF handed to an operation. `password` is only needed for encrypted files. */
export interface PdfInput {
  name: string;
  bytes: Uint8Array;
  password?: string;
}

/** A file produced by an operation. */
export interface OutputFile {
  name: string;
  bytes: Uint8Array;
  mime: string;
  /** Present for PDF outputs. Verified against the file itself, not assumed. */
  pageCount?: number;
}

export const MIME = {
  pdf: "application/pdf",
  jpeg: "image/jpeg",
  png: "image/png",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
} as const;

export type Rotation = 0 | 90 | 180 | 270;

export function reportProgress(ctx: JobContext | undefined, fraction: number, message?: string): void {
  ctx?.onProgress?.(Math.min(1, Math.max(0, fraction)), message);
}
