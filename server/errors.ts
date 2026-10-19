import type { ApiError } from "../shared/api.js";

/** Codes the browser app understands (see SERVER_CODES in src/lib/api.ts). */
export type ApiErrorCode =
  | "INVALID_FILE"
  | "INVALID_INPUT"
  | "FILE_TOO_LARGE"
  | "ENGINE_UNAVAILABLE"
  | "RATE_LIMITED"
  | "BUSY"
  | "TIMEOUT"
  | "CONVERSION_FAILED"
  | "NOT_FOUND"
  | "INTERNAL";

/** A failure with an HTTP status and a message that is safe to show to the person who uploaded the file. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function errorBody(code: ApiErrorCode, message: string): ApiError {
  return { error: { code, message } };
}
