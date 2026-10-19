import { unzipSync } from "fflate";
import { AppError } from "../errors";
import { type XNode, XmlError, kids, parseXml } from "./xml";

export interface Relationship {
  id: string;
  type: string;
  /** For internal targets: the full part name inside the package, without a leading slash. */
  target: string;
  external: boolean;
}

/** The unzipped size we are willing to open. A small file can expand enormously ("zip bomb"). */
const MAX_UNZIPPED_BYTES = 600 * 1024 * 1024;

export type OfficeKind = "docx" | "xlsx" | "pptx";

const KIND_LABEL: Record<OfficeKind, string> = { docx: "Word (.docx)", xlsx: "Excel (.xlsx)", pptx: "PowerPoint (.pptx)" };
const KIND_MAIN_PART: Record<OfficeKind, string> = { docx: "word/document.xml", xlsx: "xl/workbook.xml", pptx: "ppt/presentation.xml" };

/** An Office Open XML file (.docx, .xlsx, .pptx): a ZIP of XML parts and media, read once and kept in memory. */
export class OfficePackage {
  private readonly xmlCache = new Map<string, XNode | null>();

  private constructor(private readonly files: Record<string, Uint8Array>) {}

  static open(bytes: Uint8Array, kind: OfficeKind): OfficePackage {
    // The old binary formats are not ZIP files; say so plainly instead of reporting "corrupt".
    if (bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
      throw new AppError(
        "UNSUPPORTED",
        `This is an older binary Office file (.doc, .xls or .ppt). Open it in Office or LibreOffice and save it as a modern ${KIND_LABEL[kind]} file, then convert that.`,
      );
    }
    let total = 0;
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes, {
        filter: (file) => {
          total += file.originalSize;
          if (total > MAX_UNZIPPED_BYTES) throw new AppError("FILE_TOO_LARGE", "This document expands to far more data than a browser can safely handle, so it was not opened.");
          return true;
        },
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("INVALID_FILE", `This does not look like a valid ${KIND_LABEL[kind]} file. It may be damaged, or it may be a different kind of file with the wrong extension.`, {
        details: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
    const normalised: Record<string, Uint8Array> = {};
    for (const [name, data] of Object.entries(files)) normalised[name.replace(/^\/+/, "")] = data;
    const pack = new OfficePackage(normalised);
    if (!pack.has(KIND_MAIN_PART[kind])) {
      throw new AppError("INVALID_FILE", `This file is a ZIP archive, but it is not a ${KIND_LABEL[kind]} document (its main part, ${KIND_MAIN_PART[kind]}, is missing).`);
    }
    return pack;
  }

  has(path: string): boolean {
    return path in this.files;
  }

  bytes(path: string): Uint8Array | undefined {
    return this.files[path];
  }

  /** Part names that start with `prefix`, sorted. */
  list(prefix: string): string[] {
    return Object.keys(this.files)
      .filter((name) => name.startsWith(prefix))
      .sort();
  }

  text(path: string): string | undefined {
    const data = this.files[path];
    if (!data) return undefined;
    // XML parts are UTF-8; a few producers write UTF-16 with a byte order mark.
    if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data);
    if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data);
    return new TextDecoder("utf-8").decode(data);
  }

  /** The parsed XML of a part, or undefined when the part does not exist. A part that is not valid XML is an error. */
  xml(path: string): XNode | undefined {
    if (this.xmlCache.has(path)) return this.xmlCache.get(path) ?? undefined;
    const source = this.text(path);
    if (source === undefined) {
      this.xmlCache.set(path, null);
      return undefined;
    }
    try {
      const node = parseXml(source);
      this.xmlCache.set(path, node);
      return node;
    } catch (error) {
      if (error instanceof XmlError) throw new AppError("INVALID_FILE", `The document is damaged: the part ${path} is not valid XML.`, { details: error.message, cause: error });
      throw error;
    }
  }

  /** Relationships declared for a part (for "word/document.xml" these live in "word/_rels/document.xml.rels"). */
  relationships(partPath: string): Map<string, Relationship> {
    const slash = partPath.lastIndexOf("/");
    const directory = slash === -1 ? "" : partPath.slice(0, slash + 1);
    const file = slash === -1 ? partPath : partPath.slice(slash + 1);
    const root = this.xml(`${directory}_rels/${file}.rels`);
    const map = new Map<string, Relationship>();
    for (const rel of kids(root, "Relationship")) {
      const id = rel.attrs.Id;
      const target = rel.attrs.Target;
      if (!id || target === undefined) continue;
      const external = rel.attrs.TargetMode === "External";
      map.set(id, { id, type: rel.attrs.Type ?? "", target: external ? target : resolvePartPath(partPath, target), external });
    }
    return map;
  }
}

/** Turns a relationship target (relative to the part that declares it) into a full part name. */
export function resolvePartPath(fromPart: string, target: string): string {
  if (target.startsWith("/")) return normalise(target.slice(1));
  const slash = fromPart.lastIndexOf("/");
  const directory = slash === -1 ? "" : fromPart.slice(0, slash + 1);
  return normalise(directory + target);
}

function normalise(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

export type ImageFormat = "png" | "jpeg" | "gif" | "bmp" | "webp" | "tiff" | "emf" | "wmf" | "svg" | "unknown";

/** What an image part is, from its bytes (file extensions in Office files are not always right). */
export function sniffImage(bytes: Uint8Array): ImageFormat {
  const at = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (at(0x89, 0x50, 0x4e, 0x47)) return "png";
  if (at(0xff, 0xd8, 0xff)) return "jpeg";
  if (at(0x47, 0x49, 0x46, 0x38)) return "gif";
  if (at(0x42, 0x4d)) return "bmp";
  if (at(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "webp";
  if (at(0x49, 0x49, 0x2a, 0x00) || at(0x4d, 0x4d, 0x00, 0x2a)) return "tiff";
  if (at(0x01, 0x00, 0x00, 0x00) && bytes.length > 44 && bytes[40] === 0x20 && bytes[41] === 0x45 && bytes[42] === 0x4d && bytes[43] === 0x46) return "emf";
  if (at(0xd7, 0xcd, 0xc6, 0x9a)) return "wmf";
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) return "svg";
  return "unknown";
}
