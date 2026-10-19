import { extensionOf, formatBytes } from "./format";

/** What a file's first bytes say it is, regardless of what its name claims. */
export type SniffedType = "pdf" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "avif" | "zip" | "ole" | "rtf" | "text" | "unknown";

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((byte, i) => bytes[offset + i] === byte);

const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));

export function sniffType(bytes: Uint8Array): SniffedType {
  // PDF readers tolerate up to 1024 bytes of junk before the header.
  const limit = Math.min(bytes.length - 5, 1024);
  const pdf = ascii("%PDF-");
  for (let i = 0; i <= limit; i += 1) if (startsWith(bytes, pdf, i)) return "pdf";

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "webp";
  if (startsWith(bytes, ascii("BM"))) return "bmp";
  if (startsWith(bytes, ascii("ftyp"), 4) && (startsWith(bytes, ascii("avif"), 8) || startsWith(bytes, ascii("avis"), 8))) return "avif";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) return "zip";
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole";
  if (startsWith(bytes, ascii("{\\rtf"))) return "rtf";

  // Plain text (CSV and the like): no NUL bytes in the first few hundred bytes.
  const sample = bytes.subarray(0, 512);
  if (sample.length > 0 && !sample.includes(0)) return "text";
  return "unknown";
}

/** Types that a file with the given extension may legitimately contain. */
const EXPECTED: Record<string, readonly SniffedType[]> = {
  pdf: ["pdf"],
  jpg: ["jpeg"],
  jpeg: ["jpeg"],
  png: ["png"],
  gif: ["gif"],
  webp: ["webp"],
  bmp: ["bmp"],
  avif: ["avif"],
  docx: ["zip"],
  xlsx: ["zip"],
  pptx: ["zip"],
  odt: ["zip"],
  ods: ["zip"],
  odp: ["zip"],
  doc: ["ole"],
  xls: ["ole"],
  ppt: ["ole"],
  rtf: ["rtf"],
  csv: ["text"],
  txt: ["text"],
};

const FRIENDLY: Record<SniffedType, string> = {
  pdf: "a PDF document",
  jpeg: "a JPEG image",
  png: "a PNG image",
  gif: "a GIF image",
  webp: "a WebP image",
  bmp: "a BMP image",
  avif: "an AVIF image",
  zip: "a ZIP-based document",
  ole: "an older Office document",
  rtf: "an RTF document",
  text: "a text file",
  unknown: "an unrecognised file type",
};

/**
 * Checks that the content matches the file extension. Returns a user-facing reason when it does not,
 * or `null` when the file is acceptable. The extension alone is never trusted.
 */
export function contentProblem(name: string, bytes: Uint8Array): string | null {
  if (bytes.length === 0) return `“${name}” is empty.`;
  const extension = extensionOf(name);
  const expected = EXPECTED[extension];
  if (!expected) return null; // not a type we can verify; the tool will fail clearly if it cannot read it
  const actual = sniffType(bytes);
  if (expected.includes(actual)) return null;
  return `“${name}” is not really ${FRIENDLY[expected[0] as SniffedType]}: its content looks like ${FRIENDLY[actual]}.`;
}

export interface Rejection {
  name: string;
  reason: string;
}

export interface FileRule {
  /** Lower-case extensions with the dot, e.g. [".pdf"]. */
  extensions: readonly string[];
  maxBytes: number;
  maxFiles: number;
  /** How many files are already in the list. */
  existing: number;
  /** "PDF files" for messages. */
  label: string;
}

/** First-pass checks that need no file contents: extension, size, count. */
export function checkFiles(files: readonly File[], rule: FileRule): { accepted: File[]; rejected: Rejection[] } {
  const accepted: File[] = [];
  const rejected: Rejection[] = [];
  const allowed = rule.extensions.map((e) => e.toLowerCase());
  for (const file of files) {
    const extension = `.${extensionOf(file.name)}`;
    if (!allowed.includes(extension)) {
      rejected.push({ name: file.name, reason: `“${file.name}” is not a supported file. Choose ${rule.label} (${allowed.join(", ")}).` });
    } else if (file.size === 0) {
      rejected.push({ name: file.name, reason: `“${file.name}” is empty.` });
    } else if (file.size > rule.maxBytes) {
      rejected.push({
        name: file.name,
        reason: `“${file.name}” is ${formatBytes(file.size)}, which is over the ${formatBytes(rule.maxBytes)} limit.`,
      });
    } else if (rule.existing + accepted.length >= rule.maxFiles) {
      rejected.push({ name: file.name, reason: `“${file.name}” was not added: at most ${rule.maxFiles} files at a time.` });
    } else {
      accepted.push(file);
    }
  }
  return { accepted, rejected };
}
