import { PDFDocument } from "@cantoo/pdf-lib";
import { AppError } from "../../errors";
import { loadForEdit } from "../document";
import { frameOf } from "../draw";
import type { PdfInput } from "../types";
import { type PageAnalysis, analyzePage } from "./analyze";
import { engineContext, ensureScanned, usedBySignature } from "./context";
import { pruneUnreachable } from "./prune";
import { type EditOptions, type EditReport, type LineEditRequest, applyTextEdits } from "./textEdit";

/**
 * A document held open for editing. The source is never changed: pages are analysed from it, and edits are
 * applied to *copies* of a page, so the original bytes can always be exported again untouched.
 */

export interface PageSize {
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
}

export interface SessionInfo {
  name: string;
  pageCount: number;
  signed: boolean;
  sizes: PageSize[];
}

export class EngineSession {
  private readonly analyses = new Map<number, PageAnalysis>();

  private constructor(
    readonly doc: PDFDocument,
    readonly name: string,
  ) {}

  /** Opens a PDF for editing. An encrypted file needs its password; it is decrypted in memory only. */
  static async open(input: PdfInput): Promise<EngineSession> {
    const doc = await loadForEdit(input);
    return new EngineSession(doc, input.name);
  }

  get pageCount(): number {
    return this.doc.getPageCount();
  }

  get signed(): boolean {
    return engineContext(this.doc).signed;
  }

  info(): SessionInfo {
    return {
      name: this.name,
      pageCount: this.pageCount,
      signed: this.signed,
      sizes: this.doc.getPages().map((page) => {
        const frame = frameOf(page);
        return { width: frame.displayWidth, height: frame.displayHeight, rotation: frame.rotation };
      }),
    };
  }

  /** The lines, images, links and shapes of one page (cached). */
  analyze(pageIndex: number): PageAnalysis {
    this.assertPage(pageIndex);
    let analysis = this.analyses.get(pageIndex);
    if (!analysis) {
      analysis = analyzePage(this.doc, pageIndex).analysis;
      this.analyses.set(pageIndex, analysis);
    }
    return analysis;
  }

  /**
   * A one-page PDF of `pageIndex` with the text edits applied, for showing the real result. The source document is
   * left as it was. Line ids come from `analyze` of the same page.
   */
  async derivePage(pageIndex: number, edits: readonly LineEditRequest[], options: EditOptions = {}): Promise<{ bytes: Uint8Array; report: EditReport | null }> {
    this.assertPage(pageIndex);
    const source = engineContext(this.doc);
    ensureScanned(source);
    const out = await PDFDocument.create();
    const [copy] = await out.copyPages(this.doc, [pageIndex]);
    if (!copy) throw new AppError("ENGINE_FAILED", "The page could not be copied for editing.");
    out.addPage(copy);
    const target = engineContext(out);
    for (const [signature, codes] of usedBySignature(source)) target.seedUsed.set(signature, codes);
    const report = edits.length > 0 || (options.objects?.length ?? 0) > 0 ? await applyTextEdits(out, 0, edits, options) : null;
    pruneUnreachable(out);
    return { bytes: await out.save({ useObjectStreams: false }), report };
  }

  private assertPage(pageIndex: number): void {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= this.pageCount) {
      throw new AppError("INVALID_INPUT", `Page ${pageIndex + 1} does not exist in this document.`);
    }
  }
}
