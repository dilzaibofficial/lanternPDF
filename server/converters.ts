import { mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { OfficeTarget } from "../shared/api.js";
import { HttpError } from "./errors.js";
import { type Command, type RunOptions, type RunResult, converterEnv, runCommand } from "./process.js";
import { sniff } from "./validate.js";

export type CompressLevel = "screen" | "ebook" | "printer";

/** What a conversion needs: the job folder it works in and the (already validated) input file inside it. */
export interface ConversionInput {
  /** Private folder of this job. */
  jobDir: string;
  /** Absolute path of the uploaded file, named `upload.<ext>` by the server (never by the client). */
  inputPath: string;
  /** Its extension, with the dot. */
  extension: string;
}

export interface Converters {
  /** Word / Excel / PowerPoint (and OpenDocument) to PDF. Resolves with the output path. */
  officeToPdf(input: ConversionInput): Promise<string>;
  /** PDF to editable Word or PowerPoint. */
  pdfToOffice(input: ConversionInput, target: OfficeTarget): Promise<string>;
  /** Stronger PDF compression. */
  compress(input: ConversionInput, level: CompressLevel): Promise<string>;
}

export interface ConverterDeps {
  libreoffice: Command | null;
  ghostscript: Command | null;
  timeoutMs: number;
  /** Replaceable in tests. */
  run?: (command: Command, args: string[], options: RunOptions) => Promise<RunResult>;
  /** Called with technical detail that must not reach the person who uploaded the file. */
  log?: (message: string, detail?: unknown) => void;
}

const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;

const missing = (name: string) => new HttpError(503, "ENGINE_UNAVAILABLE", `${name} is not installed on this server, so this conversion is not available.`);

/**
 * Checks what an engine produced instead of trusting its exit code: the file must exist, be non-empty and
 * look like what was asked for. Anything else is a failed conversion, never a "successful" empty download.
 */
async function verifyOutput(path: string, kind: "pdf" | "zip"): Promise<void> {
  const size = await stat(path).then(
    (info) => info.size,
    () => {
      throw new HttpError(500, "CONVERSION_FAILED", "The conversion did not produce a file. The document may be damaged, password-protected or use features the converter cannot read.");
    },
  );
  if (size === 0 || size > MAX_OUTPUT_BYTES) throw new HttpError(500, "CONVERSION_FAILED", "The conversion produced an empty or unusable file, so nothing was returned.");
  if ((await sniff(path)) !== kind) throw new HttpError(500, "CONVERSION_FAILED", "The converter produced a file in an unexpected format, so it was discarded.");
}

export function createConverters(deps: ConverterDeps): Converters {
  const run = deps.run ?? runCommand;
  const log = deps.log ?? (() => undefined);

  async function execute(name: string, command: Command, jobDir: string, args: string[]): Promise<void> {
    let result: RunResult;
    try {
      result = await run(command, args, { cwd: jobDir, timeoutMs: deps.timeoutMs, env: converterEnv(jobDir) });
    } catch (error) {
      log(`${name} could not be started`, error);
      throw new HttpError(500, "CONVERSION_FAILED", `${name} could not be started on this server.`);
    }
    if (result.timedOut) {
      log(`${name} timed out`, { seconds: deps.timeoutMs / 1000 });
      throw new HttpError(504, "TIMEOUT", `The conversion took longer than ${Math.round(deps.timeoutMs / 1000)} seconds and was stopped. Try a smaller or simpler file.`);
    }
    if (result.code !== 0) {
      log(`${name} exited with an error`, { code: result.code, signal: result.signal, stderr: result.stderr.slice(0, 2000) });
      throw new HttpError(500, "CONVERSION_FAILED", "The converter could not process this file. It may be damaged, password-protected, or contain something it does not support.");
    }
  }

  /** LibreOffice with its own throw-away profile (no shared state, no stored history, macros off) inside the job. */
  async function libreOffice(input: ConversionInput, outputName: string, convertTo: string, inFilter?: string): Promise<string> {
    if (!deps.libreoffice) throw missing("LibreOffice");
    const profile = join(input.jobDir, "profile");
    const outDir = join(input.jobDir, "out");
    await mkdir(profile, { recursive: true });
    await mkdir(outDir, { recursive: true });
    await execute("LibreOffice", deps.libreoffice, input.jobDir, [
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      "--headless",
      "--invisible",
      "--norestore",
      "--nolockcheck",
      "--nodefault",
      "--nologo",
      "--nofirststartwizard",
      ...(inFilter ? [`--infilter=${inFilter}`] : []),
      "--convert-to",
      convertTo,
      "--outdir",
      outDir,
      input.inputPath,
    ]);
    return join(outDir, outputName);
  }

  return {
    async officeToPdf(input) {
      const output = await libreOffice(input, "upload.pdf", "pdf");
      await verifyOutput(output, "pdf");
      return output;
    },

    async pdfToOffice(input, target) {
      const output =
        target === "docx"
          ? await libreOffice(input, "upload.docx", "docx:MS Word 2007 XML", "writer_pdf_import")
          : await libreOffice(input, "upload.pptx", "pptx:Impress MS PowerPoint 2007 XML", "impress_pdf_import");
      await verifyOutput(output, "zip");
      return output;
    },

    async compress(input, level) {
      if (!deps.ghostscript) throw missing("Ghostscript");
      // Relative names, with the job folder as the working directory: nothing in a path can be mistaken for Ghostscript syntax.
      await execute("Ghostscript", deps.ghostscript, input.jobDir, [
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.6",
        `-dPDFSETTINGS=/${level}`,
        "-dNOPAUSE",
        "-dBATCH",
        "-dQUIET",
        "-dSAFER",
        "-sOutputFile=compressed.pdf",
        basename(input.inputPath),
      ]);
      const output = join(input.jobDir, "compressed.pdf");
      await verifyOutput(output, "pdf");
      return output;
    },
  };
}
