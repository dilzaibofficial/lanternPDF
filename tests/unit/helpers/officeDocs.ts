import { createCanvas } from "@napi-rs/canvas";
import ExcelJS from "exceljs";
import { AlignmentType, Document, ExternalHyperlink, Footer, Header, HeadingLevel, ImageRun, LevelFormat, Packer, PageNumber, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";

export function pngBytes(width = 120, height = 60): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#3a3ad1";
  ctx.fillRect(0, 0, width, height);
  return canvas.toBuffer("image/png");
}

const lorem = "The quick brown fox jumps over the lazy dog. ".repeat(40);

/** A Word document with a heading, formatted text, a list, a table, a link, a picture, and a header and footer with page numbers. */
export async function makeWordDocument(options: { paragraphs?: number } = {}): Promise<Uint8Array> {
  const body: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Annual summary")] }),
    new Paragraph({ children: [new TextRun("Plain, "), new TextRun({ text: "bold", bold: true }), new TextRun(" and "), new TextRun({ text: "italic", italics: true }), new TextRun(" text.")] }),
    new Paragraph({ numbering: { reference: "list", level: 0 }, children: [new TextRun("First point")] }),
    new Paragraph({ numbering: { reference: "list", level: 0 }, children: [new TextRun("Second point")] }),
    new Table({
      width: { size: 6000, type: WidthType.DXA },
      columnWidths: [3000, 3000],
      rows: [
        new TableRow({ children: [new TableCell({ width: { size: 3000, type: WidthType.DXA }, children: [new Paragraph("Region")] }), new TableCell({ width: { size: 3000, type: WidthType.DXA }, children: [new Paragraph("Total")] })] }),
        new TableRow({ children: [new TableCell({ width: { size: 3000, type: WidthType.DXA }, children: [new Paragraph("North")] }), new TableCell({ width: { size: 3000, type: WidthType.DXA }, children: [new Paragraph("1,200")] })] }),
      ],
    }),
    new Paragraph({ children: [new TextRun("See "), new ExternalHyperlink({ link: "https://lanternpdf.com", children: [new TextRun("our site")] }), new TextRun(".")] }),
    new Paragraph({ children: [new ImageRun({ type: "png", data: pngBytes(), transformation: { width: 120, height: 60 } })] }),
  ];
  for (let i = 0; i < (options.paragraphs ?? 0); i += 1) body.push(new Paragraph({ alignment: AlignmentType.JUSTIFIED, children: [new TextRun({ text: `Paragraph ${i + 1}. `, bold: true }), new TextRun(lorem)] }));
  const doc = new Document({
    title: "Annual summary",
    creator: "LanternPDF tests",
    numbering: { config: [{ reference: "list", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT }] }] },
    sections: [
      {
        headers: { default: new Header({ children: [new Paragraph("Confidential header")] }) },
        footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun({ children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES] })] })] }) },
        children: body,
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

/** A workbook with a title, numbers in several formats, a date, a merged cell, wrapped text, a formula result and a second sheet. */
export async function makeWorkbook(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Sales");
  sheet.columns = [{ width: 18 }, { width: 14 }, { width: 14 }, { width: 30 }];
  sheet.mergeCells("A1:D1");
  sheet.getCell("A1").value = "Regional sales";
  sheet.getCell("A1").font = { bold: true, size: 16 };
  sheet.addRow(["Region", "Amount", "Share", "Notes"]);
  sheet.addRow(["North", 1234.5, 0.256, "A long note that must wrap inside its narrow column"]).getCell(4).alignment = { wrapText: true };
  sheet.addRow(["Date", new Date(Date.UTC(2026, 9, 19)), { formula: "B3*2", result: 2469 }]);
  sheet.getCell("B3").numFmt = "$#,##0.00";
  sheet.getCell("C3").numFmt = "0.0%";
  sheet.getCell("B4").numFmt = "dd mmm yyyy";
  const second = wb.addWorksheet("Second");
  second.addRow(["Second sheet text"]);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
