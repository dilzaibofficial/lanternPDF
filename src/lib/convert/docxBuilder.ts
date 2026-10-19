import { AlignmentType, BorderStyle, Document, HeadingLevel, Packer, Paragraph, Tab, TabStopType, Table, TableCell, TableLayoutType, TableRow, TextRun, WidthType } from "docx";
import type { FontKind, Paragraph as Para, Run, TableBlock } from "./layout";
import { sanitize } from "./layout";

const FONT_NAME: Record<FontKind, string> = { sans: "Arial", serif: "Times New Roman", mono: "Courier New" };
const HEADING = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 } as const;
const ALIGNMENT = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT } as const;
const twips = (points: number) => Math.round(points * 20);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** What goes into the document for one PDF page, in reading order. */
export interface DocxPage {
  width: number;
  height: number;
  textLeft: number;
  textRight: number;
  content: (Para | TableBlock)[];
}

export const isTable = (block: Para | TableBlock): block is TableBlock => "type" in block && block.type === "table";

function runsOf(runs: readonly Run[], size: number, font: string, bold = false): TextRun[] {
  const out: TextRun[] = [];
  for (const run of runs) {
    sanitize(run.text)
      .split("\t")
      .forEach((part, index) => {
        if (index > 0) out.push(new TextRun({ children: [new Tab()] }));
        if (part !== "") out.push(new TextRun({ text: part, bold: run.bold || bold, italics: run.italic, size, font }));
      });
  }
  return out;
}

function paragraphOf(p: Para, pageBreak: boolean): Paragraph {
  const size = Math.max(2, Math.round(p.fontSize * 2)); // half-points
  const font = FONT_NAME[p.font];
  return new Paragraph({
    children: runsOf(p.runs, size, font),
    heading: p.kind === "heading" && p.level ? HEADING[p.level] : undefined,
    bullet: p.kind === "bullet" ? { level: 0 } : undefined,
    alignment: ALIGNMENT[p.align],
    pageBreakBefore: pageBreak,
    indent: p.indent > 12 && p.kind !== "bullet" ? { left: twips(p.indent) } : undefined,
    tabStops: p.tabs.map((position) => ({ type: TabStopType.LEFT, position: twips(position) })),
    spacing: { after: p.kind === "tabular" ? 0 : 120, line: 264 },
  });
}

function tableOf(block: TableBlock): Table {
  const edges = [block.left, ...block.boundaries, block.right];
  const widths = edges.slice(1).map((edge, index) => Math.max(twips(24), twips(edge - (edges[index] as number))));
  const size = Math.max(2, Math.round(block.fontSize * 2));
  const hairline = { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" } as const;
  return new Table({
    layout: TableLayoutType.FIXED,
    width: { size: widths.reduce((sum, width) => sum + width, 0), type: WidthType.DXA },
    columnWidths: widths,
    rows: block.rows.map(
      (cells, rowIndex) =>
        new TableRow({
          children: cells.map(
            (text, column) =>
              new TableCell({
                width: { size: widths[column] as number, type: WidthType.DXA },
                borders: { top: hairline, bottom: hairline, left: hairline, right: hairline },
                children: [new Paragraph({ children: runsOf([{ text, bold: rowIndex === 0 && block.headerBold, italic: false }], size, FONT_NAME.sans), spacing: { after: 0 } })],
              }),
          ),
        }),
    ),
  });
}

/** Builds the .docx: one section whose page size and margins follow the first PDF page, a page break where each PDF page ends. */
export async function buildDocx(pages: readonly DocxPage[], meta: { title: string; creator: string }): Promise<Uint8Array> {
  const first = pages[0];
  const children: (Paragraph | Table)[] = [];
  pages.forEach((page, index) => {
    let pendingBreak = index > 0;
    if (page.content.length === 0 && pendingBreak) {
      children.push(new Paragraph({ children: [], pageBreakBefore: true })); // a page with no text still gets its own page
      return;
    }
    for (const block of page.content) {
      if (isTable(block)) {
        if (pendingBreak) {
          children.push(new Paragraph({ children: [], pageBreakBefore: true, spacing: { after: 0 } }));
          pendingBreak = false;
        }
        children.push(tableOf(block));
        children.push(new Paragraph({ children: [], spacing: { after: 120 } })); // Word needs a paragraph after a table
      } else {
        children.push(paragraphOf(block, pendingBreak));
        pendingBreak = false;
      }
    }
  });
  if (children.length === 0) children.push(new Paragraph({ children: [] }));

  const document = new Document({
    title: sanitize(meta.title),
    creator: meta.creator,
    sections: [
      {
        properties: {
          page: {
            size: { width: twips(first?.width ?? 612), height: twips(first?.height ?? 792) },
            margin: {
              left: twips(clamp(first?.textLeft ?? 72, 28, 150)),
              right: twips(clamp((first?.width ?? 612) - (first?.textRight ?? 540), 28, 150)),
              top: twips(54),
              bottom: twips(54),
            },
          },
        },
        children,
      },
    ],
  });
  return Packer.pack(document, "uint8array");
}
