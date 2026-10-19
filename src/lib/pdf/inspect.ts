import { AppError } from "../errors";
import { type QpdfSession, classifyQpdfFailure, passwordArg, withQpdf } from "./qpdf";

export type PdfProbeState = "ok" | "needs-password" | "wrong-password" | "damaged";

export interface PdfProbe {
  state: PdfProbeState;
  /** Number of pages (only when `state` is "ok"). */
  pageCount?: number;
  /**
   * True when the file is encrypted. With state "ok" this means it opened either with the supplied
   * password or without one (owner-password restrictions only).
   */
  encrypted?: boolean;
  /** Human-readable explanation for non-"ok" states. */
  message?: string;
}

/** PDF readers accept up to 1024 bytes of junk before the header, so we do too. */
export function hasPdfHeader(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length - 4, 1024);
  for (let i = 0; i <= limit; i += 1) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) {
      return true;
    }
  }
  return false;
}

/** Page count of a file already written to the session, or throws a classified error. */
export function countPagesIn(qpdf: QpdfSession, path: string, password?: string, fileName?: string): number {
  const result = qpdf.run([...passwordArg(password), "--show-npages", path]);
  if (result.code !== 0 && result.code !== 3) {
    throw classifyQpdfFailure(result.output, { fileName, passwordSupplied: Boolean(password) });
  }
  const count = Number.parseInt(result.output.find((line) => /^\d+$/.test(line.trim())) ?? "", 10);
  if (!Number.isInteger(count) || count < 0) {
    throw new AppError("DAMAGED_PDF", "The page count of this PDF could not be determined.", {
      details: result.output.join("\n"),
      fileName,
    });
  }
  return count;
}

/**
 * Opens a PDF and reports what it needs. Never throws for "normal" problems (not a PDF, needs a
 * password): those are states, because the UI reacts to them (by asking for a password, say).
 */
export async function probePdf(bytes: Uint8Array, password?: string): Promise<PdfProbe> {
  if (bytes.length === 0) return { state: "damaged", message: "This file is empty." };
  if (!hasPdfHeader(bytes)) return { state: "damaged", message: "This file is not a PDF document." };

  return withQpdf((qpdf) => {
    const path = qpdf.put(bytes);
    const opened = qpdf.run([...passwordArg(password), "--show-npages", path]);

    if (opened.code === 0 || opened.code === 3) {
      const count = Number.parseInt(opened.output.find((line) => /^\d+$/.test(line.trim())) ?? "", 10);
      if (Number.isInteger(count) && count > 0) {
        // `--is-encrypted` exits 0 when the (opened) file is encrypted, 2 when it is not.
        const encrypted = qpdf.run([...passwordArg(password), "--is-encrypted", path]).code === 0;
        return { state: "ok", pageCount: count, encrypted } satisfies PdfProbe;
      }
      return { state: "damaged", message: "This PDF has no pages." } satisfies PdfProbe;
    }

    const failure = classifyQpdfFailure(opened.output, { passwordSupplied: Boolean(password) });
    if (failure.code === "PASSWORD_REQUIRED") {
      return { state: "needs-password", message: "This PDF is password-protected." } satisfies PdfProbe;
    }
    if (failure.code === "WRONG_PASSWORD") {
      return { state: "wrong-password", message: "That password is incorrect." } satisfies PdfProbe;
    }
    return {
      state: "damaged",
      message: "This PDF could not be read. It may be damaged or use an unsupported feature.",
    } satisfies PdfProbe;
  });
}
