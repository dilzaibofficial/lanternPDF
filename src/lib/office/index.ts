/** The Office converters behind one door: pick the right one from the file's extension. */
import { AppError } from "../errors";
import type { ConversionResult, ConvertOptions } from "./types";
import type { XlsxOptions } from "./xlsx/layout";

export type OfficeKind = "docx" | "xlsx" | "csv" | "pptx";

export type OfficeConvertOptions = ConvertOptions & Partial<XlsxOptions>;

/** Which converter a file name belongs to, or null when none of them can read it. */
export function officeKindOf(name: string): OfficeKind | null {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  if (extension === "docx" || extension === "docm" || extension === "dotx" || extension === "dotm") return "docx";
  if (extension === "xlsx" || extension === "xlsm" || extension === "xltx" || extension === "xltm") return "xlsx";
  if (extension === "csv") return "csv";
  if (extension === "pptx" || extension === "pptm" || extension === "potx" || extension === "ppsx") return "pptx";
  return null;
}

export async function convertOfficeFile(name: string, bytes: Uint8Array, options: OfficeConvertOptions = {}): Promise<ConversionResult> {
  const kind = officeKindOf(name);
  const withName = { ...options, name: options.name ?? name };
  switch (kind) {
    case "docx":
      return (await import("./docx/convert")).convertDocx(bytes, withName);
    case "xlsx":
      return (await import("./xlsx/convert")).convertXlsx(bytes, withName);
    case "csv":
      return (await import("./xlsx/convert")).convertCsv(bytes, withName);
    case "pptx":
      return (await import("./pptx/convert")).convertPptx(bytes, withName);
    default:
      throw new AppError("UNSUPPORTED", `“${name}” is an older or different kind of file that this device cannot convert. Save it as .docx, .xlsx or .pptx first, or use the LibreOffice mode on a server you run.`);
  }
}
