import { zipSync } from "fflate";
import { uniqueName } from "./format";
import type { OutputFile } from "./pdf/types";

export function toBlob(file: Pick<OutputFile, "bytes" | "mime">): Blob {
  // `as BlobPart`: TypeScript's lib types insist on ArrayBuffer-backed views.
  return new Blob([file.bytes as BlobPart], { type: file.mime });
}

/** Saves a blob through a temporary link. The object URL is released shortly afterwards. */
export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const ALREADY_COMPRESSED = /^(application\/(pdf|zip|vnd\.openxmlformats)|image\/(jpeg|png|webp))/;

/** Bundles several outputs into a ZIP, keeping names unique. PDFs and images are stored, not re-deflated. */
export function zipOutputs(files: readonly OutputFile[]): Uint8Array {
  const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  const taken: string[] = [];
  for (const file of files) {
    const name = uniqueName(file.name, taken);
    taken.push(name);
    entries[name] = [file.bytes, { level: ALREADY_COMPRESSED.test(file.mime) ? 0 : 6 }];
  }
  return zipSync(entries);
}

export function downloadOutputs(files: readonly OutputFile[], zipName: string): void {
  const [only] = files;
  if (files.length === 1 && only) {
    downloadBlob(only.name, toBlob(only));
    return;
  }
  downloadBlob(zipName, new Blob([zipOutputs(files) as BlobPart], { type: "application/zip" }));
}
