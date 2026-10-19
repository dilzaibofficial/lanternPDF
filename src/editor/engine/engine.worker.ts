/// <reference lib="webworker" />
import qpdfWasmUrl from "@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url";
import dejavuBoldObliqueUrl from "dejavu-fonts-ttf/ttf/DejaVuSans-BoldOblique.ttf?url";
import dejavuBoldUrl from "dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf?url";
import dejavuObliqueUrl from "dejavu-fonts-ttf/ttf/DejaVuSans-Oblique.ttf?url";
import dejavuUrl from "dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url";
import { AppError, serializeError } from "../../lib/errors";
import { type UnicodeFontFile, setUnicodeFontLoader } from "../../lib/pdf/fonts";
import { setQpdfWasmLocator } from "../../lib/pdf/qpdf";
import { EngineSession } from "../../lib/pdf/engine/session";
import type { EngineMessage, EngineResponse, EngineResults } from "./protocol";

/**
 * The editor's engine worker. It keeps each opened document parsed, so reading a page or applying an edit does not
 * start from the file every time, and it does all of that off the page's thread.
 */

setQpdfWasmLocator(() => qpdfWasmUrl);

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

const sessions = new Map<string, EngineSession>();

const scope = self as unknown as {
  postMessage(message: EngineResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<EngineMessage>) => void) | null;
};

function session(id: string): EngineSession {
  const found = sessions.get(id);
  if (!found) throw new AppError("ENGINE_FAILED", "That document is no longer open in the editor.");
  return found;
}

async function handle(message: EngineMessage): Promise<{ result: EngineResults[keyof EngineResults]; transfer?: Transferable[] }> {
  switch (message.type) {
    case "open": {
      const opened = await EngineSession.open({ name: message.name, bytes: message.bytes, password: message.password });
      sessions.set(message.source, opened);
      return { result: opened.info() };
    }
    case "analyze":
      return { result: session(message.source).analyze(message.page) };
    case "derive": {
      const derived = await session(message.source).derivePage(message.page, message.edits, { allowRepeatedForms: message.allowRepeatedForms, objects: message.objects });
      return { result: derived, transfer: [derived.bytes.buffer as ArrayBuffer] };
    }
    case "close":
      sessions.delete(message.source);
      return { result: null };
  }
}

scope.onmessage = async (event) => {
  const message = event.data;
  try {
    const { result, transfer } = await handle(message);
    scope.postMessage({ id: message.id, ok: true, result }, transfer);
  } catch (error) {
    scope.postMessage({ id: message.id, ok: false, error: serializeError(error) });
  }
};
