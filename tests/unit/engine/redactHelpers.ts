import type { PDFDocument } from "@cantoo/pdf-lib";
import { pruneUnreachable } from "../../../src/lib/pdf/engine/prune";

/** Drops what nothing references any more (the old content streams), as saving a real export does. */
export const prune = (doc: PDFDocument): number => pruneUnreachable(doc);
