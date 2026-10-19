import createModule from "@neslinesli93/qpdf-wasm";
import { AppError, toAppError } from "../errors";

/**
 * Thin wrapper around qpdf compiled to WebAssembly (qpdf is Apache-2.0).
 *
 * Why a wrapper:
 *  - The published typings omit parts of the Emscripten FS API we need.
 *  - The build binds `console.log` / `console.error` when the module is created and ignores the
 *    `print` / `printErr` options, so we install forwarding functions *before* creation to capture
 *    qpdf's messages. We use them to classify failures, but never to decide success: the exit code
 *    and our own post-checks do that.
 *  - The location of `qpdf.wasm` differs between the browser (a bundler URL) and Node (a file path),
 *    so the host injects it with `setQpdfWasmLocator`.
 */

interface QpdfFs {
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  unlink(path: string): void;
  readdir(path: string): string[];
}

interface QpdfRuntime {
  callMain(args: string[]): number;
  FS: QpdfFs;
}

type ModuleFactory = (options: Record<string, unknown>) => Promise<QpdfRuntime>;

export interface QpdfRunResult {
  /** qpdf exit status: 0 ok, 3 ok with warnings, 2 error. */
  code: number;
  /** Everything qpdf printed (stdout and stderr), one entry per line. */
  output: string[];
}

let locateWasm: (() => string) | null = null;
let activeSink: string[] | null = null;

/** The host (worker entry or test setup) tells us where qpdf.wasm lives. */
export function setQpdfWasmLocator(locator: () => string): void {
  locateWasm = locator;
}

async function instantiate(): Promise<QpdfRuntime> {
  if (!locateWasm) {
    throw new AppError("ENGINE_FAILED", "The PDF engine is not configured.", {
      details: "setQpdfWasmLocator() was not called before using qpdf.",
    });
  }
  const locate = locateWasm;
  /* eslint-disable no-console -- the engine prints through console.log/error, so they are replaced for a moment to capture its messages */
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    if (activeSink) activeSink.push(args.join(" "));
    else originalLog(...args);
  };
  console.error = (...args: unknown[]) => {
    if (activeSink) activeSink.push(args.join(" "));
    else originalError(...args);
  };
  try {
    const factory = createModule as unknown as ModuleFactory;
    return await factory({ locateFile: () => locate(), noInitialRun: true });
  } catch (error) {
    throw toAppError(error, "The PDF engine could not be started.");
  } finally {
    // The module keeps the bound forwarders; restore the real console for everyone else.
    console.log = originalLog;
    console.error = originalError;
  }
  /* eslint-enable no-console */
}

/** Exit status carried by Emscripten's ExitStatus exception, if any. */
function statusOf(error: unknown): number | null {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === "number") return status;
  }
  return null;
}

export class QpdfSession {
  private counter = 0;
  private constructor(private readonly runtime: QpdfRuntime) {}

  static async open(): Promise<QpdfSession> {
    return new QpdfSession(await instantiate());
  }

  /** A fresh path in the in-memory file system, e.g. `/f3.pdf`. */
  path(extension = "pdf"): string {
    this.counter += 1;
    return `/f${this.counter}.${extension}`;
  }

  write(path: string, bytes: Uint8Array): void {
    this.runtime.FS.writeFile(path, bytes);
  }

  /** Writes bytes to a fresh path and returns it. */
  put(bytes: Uint8Array, extension = "pdf"): string {
    const path = this.path(extension);
    this.write(path, bytes);
    return path;
  }

  read(path: string): Uint8Array {
    return this.runtime.FS.readFile(path);
  }

  exists(path: string): boolean {
    try {
      this.runtime.FS.readFile(path);
      return true;
    } catch {
      return false;
    }
  }

  remove(path: string): void {
    try {
      this.runtime.FS.unlink(path);
    } catch {
      // already gone
    }
  }

  list(directory = "/"): string[] {
    return this.runtime.FS.readdir(directory).filter((name) => name !== "." && name !== "..");
  }

  run(args: string[]): QpdfRunResult {
    const output: string[] = [];
    activeSink = output;
    try {
      return { code: this.runtime.callMain(args), output };
    } catch (error) {
      // ExitStatus is thrown by Emscripten when the program calls exit(); anything else is a crash.
      const status = statusOf(error);
      if (status !== null) return { code: status, output };
      throw toAppError(error, "The PDF engine stopped unexpectedly.");
    } finally {
      activeSink = null;
    }
  }

  /** Releases all in-memory files. The session must not be used afterwards. */
  dispose(): void {
    // Directories (tmp, dev, ...) refuse to unlink and are skipped by `remove`.
    for (const name of this.list()) this.remove(`/${name}`);
  }
}

/** Opens a session, runs `work`, and always frees the in-memory files afterwards. */
export async function withQpdf<T>(work: (qpdf: QpdfSession) => Promise<T> | T): Promise<T> {
  const session = await QpdfSession.open();
  try {
    return await work(session);
  } finally {
    session.dispose();
  }
}

export interface FailureContext {
  fileName?: string;
  /** True when a password was supplied, so "invalid password" means *wrong* rather than *missing*. */
  passwordSupplied?: boolean;
}

/** Turns qpdf's messages into an AppError with a clear user-facing message. */
export function classifyQpdfFailure(lines: readonly string[], context: FailureContext = {}): AppError {
  const text = lines.join("\n");
  const subject = context.fileName ? `"${context.fileName}"` : "This PDF";

  if (/invalid password/i.test(text)) {
    return context.passwordSupplied
      ? new AppError("WRONG_PASSWORD", `That password is incorrect for ${subject}.`, {
          details: text,
          fileName: context.fileName,
        })
      : new AppError("PASSWORD_REQUIRED", `${subject} is password-protected.`, {
          details: text,
          fileName: context.fileName,
        });
  }
  if (/unsupported (encryption|security handler)|unknown encryption/i.test(text)) {
    return new AppError("UNSUPPORTED", `${subject} uses an encryption method this tool cannot open.`, {
      details: text,
      fileName: context.fileName,
    });
  }
  if (
    /can't find startxref|unable to find trailer|not a PDF|can't find PDF header|file is damaged|unexpected EOF|xref|recovery|no objects|damaged/i.test(
      text,
    )
  ) {
    return new AppError("DAMAGED_PDF", `${subject} could not be read. It may be damaged or not a valid PDF.`, {
      details: text,
      fileName: context.fileName,
    });
  }
  return new AppError("ENGINE_FAILED", `The PDF engine could not process ${subject}.`, {
    details: text || "qpdf exited with an error and printed no message.",
    fileName: context.fileName,
  });
}

/** Runs qpdf and throws a classified AppError unless it succeeded (exit 0, or 3 = warnings only). */
export function runChecked(qpdf: QpdfSession, args: string[], context: FailureContext = {}): QpdfRunResult {
  const result = qpdf.run(args);
  if (result.code !== 0 && result.code !== 3) throw classifyQpdfFailure(result.output, context);
  return result;
}

/** `--password=` arguments are only emitted when a password exists. */
export function passwordArg(password: string | undefined): string[] {
  return password ? [`--password=${password}`] : [];
}
