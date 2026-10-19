/** Draws laid-out pages into the PDF. */
import type { PageBuilder, PdfBuilder } from "../pdfBuilder";
import { type DrawContext, type TextShaper, drawLine, drawPicture } from "../textflow";
import { type DisplayItem, type DisplayPage, type LaidBlock, type LayoutContext, type Pagination, blockHeight, layoutBlocks, placeBlocks } from "./layout";
import type { Block, Border, DocxModel, SectionProps } from "./types";

function drawEdge(page: PageBuilder, edge: Extract<DisplayItem, { kind: "edge" }>): void {
  const { border } = edge;
  if (border.style === "none") return;
  const width = Math.max(0.25, border.width);
  const base = { color: border.color, width };
  if (border.style === "double") {
    const horizontal = Math.abs(edge.y2 - edge.y1) < 0.01;
    const offset = width * 1.1;
    const line = (dx: number, dy: number) => page.line(edge.x1 + dx, edge.y1 + dy, edge.x2 + dx, edge.y2 + dy, { color: border.color, width: width * 0.8 });
    if (horizontal) {
      line(0, -offset);
      line(0, offset);
    } else {
      line(-offset, 0);
      line(offset, 0);
    }
    return;
  }
  const style = border.style === "dotted" ? { ...base, dash: [width, width * 1.5] } : border.style === "dashed" ? { ...base, dash: [width * 3, width * 2] } : border.style === "thick" ? { ...base, width: width * 2 } : base;
  page.line(edge.x1, edge.y1, edge.x2, edge.y2, style);
}

function drawItems(page: PageBuilder, items: readonly DisplayItem[], ctx: DrawContext): void {
  for (const item of items) {
    if (item.kind === "rect") {
      page.fillRect(item.x, item.y, item.width, item.height, item.fill);
    } else if (item.kind === "lines") {
      let y = item.y;
      for (const line of item.lines) {
        drawLine(ctx, line, item.x, y);
        y += line.height;
      }
    } else if (item.kind === "edge") {
      drawEdge(page, item);
    } else {
      drawPicture(page, item.image, item.x, item.y, item.width, item.height, item.crop);
    }
  }
}

/** The header or footer part that applies to a page, looking back through earlier sections the way Word does. */
export function partFor(model: DocxModel, sectionIndex: number, which: "headers" | "footers", kind: DisplayPage["kind"]): Block[] | undefined {
  for (let index = sectionIndex; index >= 0; index -= 1) {
    const props = (model.sections[index] as { props: SectionProps }).props;
    const path = props[which][kind];
    if (path) return model.parts.get(path);
    // A first-page or even-page part that is missing means "none", not "use the default".
    if (kind !== "default" && index === sectionIndex && (kind === "first" ? props.titlePage : model.evenAndOddHeaders)) return undefined;
  }
  return undefined;
}

export interface RenderInput {
  builder: PdfBuilder;
  model: DocxModel;
  pagination: Pagination;
  layoutContext: LayoutContext;
  shaper: TextShaper;
}

/** Header and footer placed for one page: the same blocks every time, with this page's number in the fields. */
function furnitureItems(blocks: Block[], section: SectionProps, which: "header" | "footer", input: RenderInput): { items: DisplayItem[]; height: number } {
  const width = section.pageWidth - section.margins.left - section.margins.right;
  const laid: LaidBlock[] = layoutBlocks(blocks, width, input.layoutContext);
  const height = laid.reduce((sum, block) => sum + blockHeight(block), 0);
  const holder: { items: DisplayItem[] } = { items: [] };
  const top = which === "header" ? section.margins.header : section.pageHeight - section.margins.footer - height;
  placeBlocks(laid, section.margins.left, top, width, holder);
  return { items: holder.items, height };
}

export function renderPages(input: RenderInput): void {
  const { builder, model, pagination, shaper } = input;
  const total = pagination.pages.length;
  pagination.pages.forEach((displayPage) => {
    const section = (model.sections[displayPage.sectionIndex] as { props: SectionProps }).props;
    const page = builder.addPage(displayPage.width, displayPage.height);
    const ctx: DrawContext = { page, shaper, pageNumber: displayPage.number, pageCount: total, resolveAnchor: (name) => pagination.bookmarks.get(name) };
    drawItems(page, displayPage.behind, ctx);
    shaper.fieldValues = { page: displayPage.number, pages: total };
    const header = partFor(model, displayPage.sectionIndex, "headers", displayPage.kind);
    if (header) drawItems(page, furnitureItems(header, section, "header", input).items, ctx);
    const footer = partFor(model, displayPage.sectionIndex, "footers", displayPage.kind);
    if (footer) drawItems(page, furnitureItems(footer, section, "footer", input).items, ctx);
    shaper.fieldValues = undefined;
    drawItems(page, displayPage.items, ctx);
    drawItems(page, displayPage.front, ctx);
  });
}

/** Heights of headers and footers, so the body keeps clear of them. */
export function furnitureHeights(model: DocxModel, input: Omit<RenderInput, "builder" | "pagination">): { headerHeight: (section: SectionProps, kind: DisplayPage["kind"]) => number; footerHeight: (section: SectionProps, kind: DisplayPage["kind"]) => number } {
  const measure = (which: "headers" | "footers") => (section: SectionProps, kind: DisplayPage["kind"]): number => {
    const index = model.sections.findIndex((s) => s.props === section);
    const blocks = partFor(model, Math.max(index, 0), which, kind);
    if (!blocks || blocks.length === 0) return 0;
    const width = section.pageWidth - section.margins.left - section.margins.right;
    return layoutBlocks(blocks, width, input.layoutContext).reduce((sum, block) => sum + blockHeight(block), 0);
  };
  return { headerHeight: measure("headers"), footerHeight: measure("footers") };
}

export type { Border };
