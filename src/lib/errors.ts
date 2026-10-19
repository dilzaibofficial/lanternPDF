/**
 * One error type for the whole app. Every failure that can reach the UI is an AppError with a
 * stable `code` (so the UI and tests can branch on it) and a message written for the end user.
 */
export type ErrorCode =
  | "INVALID_INPUT" // an option or value the user typed is not valid (e.g. a page range)
  | "INVALID_FILE" // wrong type, empty, or not a PDF at all
  | "FILE_TOO_LARGE"
  | "TOO_MANY_FILES"
  | "PASSWORD_REQUIRED" // the PDF is encrypted and no password was given
  | "WRONG_PASSWORD"
  | "NOT_PROTECTED" // asked to unlock a PDF that has no password or restrictions
  | "DAMAGED_PDF" // the PDF could not be read (corrupt or unsupported structure)
  | "UNSUPPORTED" // valid input, but a feature we cannot handle
  | "ENGINE_FAILED" // the processing engine reported an error
  | "VERIFICATION_FAILED" // the result did not pass our own post-checks, so we refuse to offer it
  | "SERVER_UNAVAILABLE" // optional server feature is not available / not installed
  | "SERVER_ERROR"
  | "NETWORK"
  | "CANCELLED"
  | "OUT_OF_MEMORY";

export interface AppErrorOptions {
  /** Technical detail for the "Show details" disclosure. Never shown as the main message. */
  details?: string;
  /** The file the error is about, when there are several. */
  fileName?: string;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: string;
  readonly fileName?: string;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.details = options.details;
    this.fileName = options.fileName;
  }
}

export interface SerializedError {
  code: ErrorCode;
  message: string;
  details?: string;
  fileName?: string;
}

export const isAppError = (value: unknown): value is AppError => value instanceof AppError;

/** Plain-object form that survives `postMessage` (Error subclasses do not keep their fields). */
export function serializeError(error: unknown): SerializedError {
  const app = toAppError(error);
  return { code: app.code, message: app.message, details: app.details, fileName: app.fileName };
}

export function deserializeError(data: SerializedError): AppError {
  return new AppError(data.code, data.message, { details: data.details, fileName: data.fileName });
}

/** Normalises anything thrown into an AppError. Unknown failures become ENGINE_FAILED. */
export function toAppError(error: unknown, fallback?: string): AppError {
  if (isAppError(error)) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new AppError("CANCELLED", "The operation was cancelled.");
  }
  const text = error instanceof Error ? error.message : String(error);
  if (/out of memory|allocation failed|array buffer allocation|invalid array length|memory access out of bounds/i.test(text)) {
    return new AppError(
      "OUT_OF_MEMORY",
      "This file is too large for your browser to process. Try a smaller file or close other tabs.",
      { details: text, cause: error },
    );
  }
  return new AppError("ENGINE_FAILED", fallback ?? "Something went wrong while processing the file.", {
    details: text,
    cause: error,
  });
}

/** Short title + actionable hint for the error banner. */
export function describeError(error: AppError): { title: string; hint?: string } {
  switch (error.code) {
    case "INVALID_INPUT":
      return { title: error.message };
    case "INVALID_FILE":
      return { title: error.message, hint: "Check that you selected the right file type." };
    case "FILE_TOO_LARGE":
      return { title: error.message, hint: "Choose a smaller file, or raise the limit in the server configuration." };
    case "TOO_MANY_FILES":
      return { title: error.message };
    case "PASSWORD_REQUIRED":
      return { title: error.message, hint: "Enter the password to open this PDF." };
    case "WRONG_PASSWORD":
      return { title: error.message, hint: "Check the password and try again." };
    case "NOT_PROTECTED":
      return { title: error.message, hint: "No change was needed, so no new file was created." };
    case "DAMAGED_PDF":
      return { title: error.message, hint: "The Repair PDF tool can sometimes recover damaged files." };
    case "UNSUPPORTED":
      return { title: error.message };
    case "VERIFICATION_FAILED":
      return {
        title: error.message,
        hint: "No file was produced, so nothing was changed. Your original is untouched.",
      };
    case "SERVER_UNAVAILABLE":
      return { title: error.message, hint: "This tool needs an optional server component. See the setup guide." };
    case "SERVER_ERROR":
      return { title: error.message, hint: "Try again. If it keeps failing, the server log has the details." };
    case "NETWORK":
      return { title: error.message, hint: "Check your connection and that the server is running." };
    case "CANCELLED":
      return { title: error.message };
    case "OUT_OF_MEMORY":
      return { title: error.message };
    default:
      return { title: error.message, hint: "Try again, or try a different file." };
  }
}
