import { AppError } from "../errors";
import { baseName } from "../format";
import { countPagesIn } from "./inspect";
import { type QpdfSession, passwordArg, runChecked, withQpdf } from "./qpdf";
import { type JobContext, MIME, type OutputFile, type PdfInput, reportProgress } from "./types";

/** Protect and unlock, both done with qpdf. */

export interface ProtectOptions {
  /** Needed to open the file. Required. */
  userPassword: string;
  /** Needed to change permissions. A random one is generated when omitted. */
  ownerPassword?: string;
  /** AES-256 (default, modern readers) or AES-128 (older readers). */
  keyLength?: 128 | 256;
  /** What a reader who only knows the user password may do. All default to allowed. */
  allowPrint?: boolean;
  allowCopy?: boolean;
  allowEdit?: boolean;
}

const MAX_PASSWORD_LENGTH = { 128: 32, 256: 127 } as const;

/** 24 random characters from an unambiguous alphabet, using the platform CSPRNG. */
export function randomPassword(length = 24): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function validatePassword(password: string, keyLength: 128 | 256, label: string): void {
  if (password.length === 0) {
    throw new AppError("INVALID_INPUT", `Enter a ${label}.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH[keyLength]) {
    throw new AppError(
      "INVALID_INPUT",
      `The ${label} is too long: ${keyLength}-bit encryption allows at most ${MAX_PASSWORD_LENGTH[keyLength]} characters.`,
    );
  }
  if (keyLength === 128 && [...password].some((ch) => (ch.codePointAt(0) ?? 0) > 255)) {
    throw new AppError(
      "INVALID_INPUT",
      `The ${label} contains characters that 128-bit encryption cannot store. Use 256-bit encryption instead.`,
    );
  }
}

function isEncrypted(qpdf: QpdfSession, path: string, password?: string): boolean {
  return qpdf.run([...passwordArg(password), "--is-encrypted", path]).code === 0;
}

export async function protectPdf(input: PdfInput, options: ProtectOptions, ctx?: JobContext): Promise<OutputFile> {
  const keyLength = options.keyLength ?? 256;
  validatePassword(options.userPassword, keyLength, "password");
  const ownerPassword = options.ownerPassword && options.ownerPassword.length > 0 ? options.ownerPassword : randomPassword();
  validatePassword(ownerPassword, keyLength, "owner password");

  return withQpdf((qpdf) => {
    reportProgress(ctx, 0.1, "Reading the PDF");
    const path = qpdf.put(input.bytes);
    const pages = countPagesIn(qpdf, path, input.password, input.name);

    reportProgress(ctx, 0.4, "Encrypting");
    const out = qpdf.path();
    // Passwords travel as JSON data, never as command-line arguments: qpdf would misread a password
    // such as "--weird" as an option, and arguments are awkward for quotes and newlines too.
    const permissions = {
      print: options.allowPrint === false ? "none" : "full",
      modify: options.allowEdit === false ? "none" : "all",
      extract: options.allowCopy === false ? "n" : "y",
      // qpdf refuses to write 128-bit RC4; AES must be requested explicitly for 128-bit keys.
      ...(keyLength === 128 ? { useAes: "y" } : {}),
    };
    const job = {
      inputFile: path,
      outputFile: out,
      ...(input.password ? { password: input.password } : {}),
      encrypt: {
        userPassword: options.userPassword,
        ownerPassword,
        [`${keyLength}bit`]: permissions,
      },
    };
    const jobPath = qpdf.put(new TextEncoder().encode(JSON.stringify(job)), "json");
    runChecked(qpdf, [`--job-json-file=${jobPath}`], {
      fileName: input.name,
      passwordSupplied: Boolean(input.password),
    });

    // Prove the protection is real: it must not open without the password, and must open with it.
    reportProgress(ctx, 0.8, "Checking the protection");
    const probe = qpdf.run(["--show-npages", out]);
    if (probe.code === 0 || probe.code === 3) {
      throw new AppError("VERIFICATION_FAILED", "The encrypted file still opens without a password, so it was discarded.");
    }
    const opened = countPagesIn(qpdf, out, options.userPassword, input.name);
    if (opened !== pages) {
      throw new AppError("VERIFICATION_FAILED", "The encrypted file did not pass the page-count check, so it was discarded.");
    }
    reportProgress(ctx, 1);
    return {
      name: `${baseName(input.name)}_protected.pdf`,
      bytes: qpdf.read(out).slice(),
      mime: MIME.pdf,
      pageCount: pages,
    };
  });
}

export interface UnlockOptions {
  /** The user's password. May be empty for files that only carry owner-password restrictions. */
  password?: string;
  /** The caller must affirm that the user is entitled to remove the protection. */
  authorized: boolean;
}

export async function unlockPdf(input: PdfInput, options: UnlockOptions, ctx?: JobContext): Promise<OutputFile> {
  if (!options.authorized) {
    throw new AppError("INVALID_INPUT", "Confirm that you are allowed to unlock this file before continuing.");
  }
  const password = options.password ?? input.password;
  return withQpdf((qpdf) => {
    reportProgress(ctx, 0.1, "Opening the PDF");
    const path = qpdf.put(input.bytes);

    let pages: number;
    try {
      pages = countPagesIn(qpdf, path, password, input.name);
    } catch (error) {
      // Re-classify so "no password given" and "wrong password" read correctly in the UI.
      if (error instanceof AppError && (error.code === "PASSWORD_REQUIRED" || error.code === "WRONG_PASSWORD")) {
        throw new AppError(
          password ? "WRONG_PASSWORD" : "PASSWORD_REQUIRED",
          password
            ? "That password is incorrect. Unlocking needs the password that opens the file."
            : "This PDF needs a password to open. Enter it to unlock the file.",
          { fileName: input.name },
        );
      }
      throw error;
    }

    if (!isEncrypted(qpdf, path, password)) {
      throw new AppError(
        "NOT_PROTECTED",
        `"${input.name}" is not password-protected and has no usage restrictions, so there is nothing to unlock.`,
        { fileName: input.name },
      );
    }

    reportProgress(ctx, 0.5, "Removing the protection");
    const out = qpdf.path();
    runChecked(qpdf, [...passwordArg(password), "--decrypt", path, out], {
      fileName: input.name,
      passwordSupplied: Boolean(password),
    });

    reportProgress(ctx, 0.85, "Checking the result");
    if (isEncrypted(qpdf, out)) {
      throw new AppError("VERIFICATION_FAILED", "The result is still protected, so it was discarded.");
    }
    const after = countPagesIn(qpdf, out, undefined, input.name);
    if (after !== pages) {
      throw new AppError("VERIFICATION_FAILED", "The unlocked file did not pass the page-count check, so it was discarded.");
    }
    reportProgress(ctx, 1);
    return {
      name: `${baseName(input.name)}_unlocked.pdf`,
      bytes: qpdf.read(out).slice(),
      mime: MIME.pdf,
      pageCount: after,
    };
  });
}

