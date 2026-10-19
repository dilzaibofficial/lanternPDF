import { sanitize } from "./layout";

export interface Cell {
  value: string | number;
  /** An Excel number format such as "0.00%". */
  format?: string;
  bold?: boolean;
}

export interface Sheet {
  name: string;
  rows: Cell[][];
}

/** Sheet names: at most 31 characters, none of []:*?/\, and unique within the workbook. */
export function sheetName(wanted: string, taken: readonly string[]): string {
  const base = wanted.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Sheet";
  let name = base;
  for (let n = 2; taken.some((other) => other.toLowerCase() === name.toLowerCase()); n += 1) {
    const suffix = ` (${n})`;
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  return name;
}

/** Writes the sheets to a .xlsx. Numbers are stored as numbers, everything else as text. */
export async function buildXlsx(sheets: readonly Sheet[], meta: { creator: string }): Promise<Uint8Array> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = meta.creator;
  workbook.created = new Date();
  const taken: string[] = [];
  for (const sheet of sheets) {
    const name = sheetName(sheet.name, taken);
    taken.push(name);
    const worksheet = workbook.addWorksheet(name);
    const widths: number[] = [];
    for (const [rowIndex, row] of sheet.rows.entries()) {
      const target = worksheet.getRow(rowIndex + 1);
      row.forEach((cell, column) => {
        const excelCell = target.getCell(column + 1);
        excelCell.value = typeof cell.value === "string" ? sanitize(cell.value) : cell.value;
        if (cell.format) excelCell.numFmt = cell.format;
        if (cell.bold) excelCell.font = { bold: true };
        const length = String(cell.value).length;
        widths[column] = Math.max(widths[column] ?? 0, length);
      });
      target.commit();
    }
    widths.forEach((length, column) => {
      worksheet.getColumn(column + 1).width = Math.min(60, Math.max(8, length + 2));
    });
  }
  if (sheets.length === 0) workbook.addWorksheet("Sheet1");
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}
