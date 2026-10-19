import { open, readFile } from "node:fs/promises";
import { extname } from "node:path";
import { unzipSync } from "fflate";

/** What a file's first bytes say it is. */
export type FileKind = "pdf" | "ole" | "zip" | "rtf" | "text" | "unknown";

export type OfficeFamily = "word" | "excel" | "powerpoint";

interface OfficeType {
  family: OfficeFamily;
  /** The content the extension promises. */
  kind: FileKind;
  /** For ZIP-based formats: a file every genuine document of this type contains. */
  entry?: string;
}

/** Documents the converter accepts. An extension is a claim; `sniff` and `entry` check it against the bytes. */
export const OFFICE_TYPES: Record<string, OfficeType> = {
  ".doc": { family: "word", kind: "ole" },
  ".docx": { family: "word", kind: "zip", entry: "[Content_Types].xml" },
  ".odt": { family: "word", kind: "zip", entry: "mimetype" },
  ".rtf": { family: "word", kind: "rtf" },
  ".xls": { family: "excel", kind: "ole" },
  ".xlsx": { family: "excel", kind: "zip", entry: "[Content_Types].xml" },
  ".ods": { family: "excel", kind: "zip", entry: "mimetype" },
  ".csv": { family: "excel", kind: "text" },
  ".ppt": { family: "powerpoint", kind: "ole" },
  ".pptx": { family: "powerpoint", kind: "zip", entry: "[Content_Types].xml" },
  ".odp": { family: "powerpoint", kind: "zip", entry: "mimetype" },
};

export const OFFICE_EXTENSIONS = Object.keys(OFFICE_TYPES);

/** Lower-case extension including the dot ("Report.DOCX" -> ".docx"), or "". */
export const extensionOf = (fileName: string): string => extname(fileName).toLowerCase();

const SAMPLE_BYTES = 8192;

/** Classifies a file by its content, ignoring its name. */
export async function sniff(path: string): Promise<FileKind> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SAMPLE_BYTES, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.length === 0) return "unknown";
    if (bytes.subarray(0, 1024).includes("%PDF-")) return "pdf";
    if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0xd0cf11e0 && bytes.readUInt32BE(4) === 0xa1b11ae1) return "ole";
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5)) return "zip";
    if (bytes.subarray(0, 5).toString("latin1") === "{\\rtf") return "rtf";
    if (!bytes.includes(0)) return "text"; // no NUL bytes: plausibly plain text (CSV)
    return "unknown";
  } finally {
    await handle.close();
  }
}

/** True when a ZIP-based document contains the named entry. Reads only the index, not the whole content. */
export async function zipHasEntry(path: string, name: string): Promise<boolean> {
  try {
    let found = false;
    unzipSync(new Uint8Array(await readFile(path)), {
      filter: (file) => {
        if (file.name === name) found = true;
        return false; // never inflate anything: the names are all we need
      },
    });
    return found;
  } catch {
    return false;
  }
}

/** Why a file claiming to be `extension` is not one, or `null` when it checks out. */
export async function officeProblem(path: string, extension: string): Promise<string | null> {
  const expected = OFFICE_TYPES[extension];
  if (!expected) return `“${extension || "no extension"}” is not a supported document type.`;
  const kind = await sniff(path);
  if (kind !== expected.kind) return `The file is not a real ${extension} document (its content does not match its name).`;
  if (expected.entry && !(await zipHasEntry(path, expected.entry))) return `The file is not a real ${extension} document (it is missing the parts every ${extension} file has).`;
  return null;
}

export async function pdfProblem(path: string): Promise<string | null> {
  return (await sniff(path)) === "pdf" ? null : "The file is not a PDF document.";
}

/** A file name that is safe to put in a Content-Disposition header: no path, no control characters. */
export function safeName(fileName: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the whole point of this expression
  const base = fileName.replace(/^.*[\\/]/, "").replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim();
  return base === "" || base === "." || base === ".." ? fallback : base.slice(0, 180);
}
