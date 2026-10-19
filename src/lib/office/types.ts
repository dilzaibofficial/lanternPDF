export interface ConvertOptions {
  /** The original file name, used for the PDF's title when the document has none. */
  name?: string;
  onProgress?: (fraction: number, message?: string) => void;
}

export interface ConversionResult {
  bytes: Uint8Array;
  pageCount: number;
  /** Things the converter could not reproduce, in plain sentences. Empty when nothing was left out. */
  warnings: string[];
}

export type OfficeFileKind = "docx" | "xlsx" | "pptx";
