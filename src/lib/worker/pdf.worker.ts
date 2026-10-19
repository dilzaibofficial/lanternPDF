/// <reference lib="webworker" />
import qpdfWasmUrl from "@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url";
import dejavuBoldObliqueUrl from "dejavu-fonts-ttf/ttf/DejaVuSans-BoldOblique.ttf?url";
import dejavuBoldUrl from "dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf?url";
import dejavuObliqueUrl from "dejavu-fonts-ttf/ttf/DejaVuSans-Oblique.ttf?url";
import dejavuUrl from "dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url";
import { AppError, serializeError } from "../errors";
import { type UnicodeFontFile, setUnicodeFontLoader } from "../pdf/fonts";
import { type OperationName, operations } from "../pdf/ops";
import { setQpdfWasmLocator } from "../pdf/qpdf";
import { type WorkerRequest, type WorkerResponse, collectTransferables } from "./protocol";

/** The background worker: runs one operation per request and reports progress. */

setQpdfWasmLocator(() => qpdfWasmUrl);

// The Unicode fallback font is only downloaded when text needs it.
const FONT_URLS: Record<UnicodeFontFile, string> = {
  "DejaVuSans.ttf": dejavuUrl,
  "DejaVuSans-Bold.ttf": dejavuBoldUrl,
  "DejaVuSans-Oblique.ttf": dejavuObliqueUrl,
  "DejaVuSans-BoldOblique.ttf": dejavuBoldObliqueUrl,
};
setUnicodeFontLoader(async (file) => {
  const response = await fetch(FONT_URLS[file]);
  if (!response.ok) throw new AppError("ENGINE_FAILED", "The built-in font could not be loaded.", { details: `HTTP ${response.status}` });
  return new Uint8Array(await response.arrayBuffer());
});

const scope = self as unknown as {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

scope.onmessage = async (event) => {
  const { name, args } = event.data;
  try {
    const operation = operations[name as OperationName] as (a: unknown, ctx: unknown) => Promise<unknown>;
    if (typeof operation !== "function") throw new Error(`Unknown operation "${String(name)}".`);
    const result = await operation(args, {
      onProgress: (fraction: number, message?: string) => scope.postMessage({ type: "progress", fraction, message }),
    });
    scope.postMessage({ type: "result", result }, collectTransferables(result));
  } catch (error) {
    scope.postMessage({ type: "error", error: serializeError(error) });
  }
};
