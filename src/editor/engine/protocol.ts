import type { SerializedError } from "../../lib/errors";
import type { PageAnalysis } from "../../lib/pdf/engine/analyze";
import type { ObjectEdit } from "../../lib/pdf/engine/objects";
import type { EditReport, LineEditRequest } from "../../lib/pdf/engine/textEdit";
import type { SessionInfo } from "../../lib/pdf/engine/session";

/** Messages between the editor and its engine worker (the worker holds each open document and reads pages on request). */

export type EngineRequest =
  | { type: "open"; source: string; name: string; bytes: Uint8Array; password?: string }
  | { type: "analyze"; source: string; page: number }
  | { type: "derive"; source: string; page: number; edits: LineEditRequest[]; objects?: ObjectEdit[]; allowRepeatedForms?: boolean }
  | { type: "close"; source: string };

export interface EngineResults {
  open: SessionInfo;
  analyze: PageAnalysis;
  derive: { bytes: Uint8Array; report: EditReport | null };
  close: null;
}

export type EngineMessage = { id: number } & EngineRequest;

export type EngineResponse = { id: number; ok: true; result: EngineResults[keyof EngineResults] } | { id: number; ok: false; error: SerializedError };
