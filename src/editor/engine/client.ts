import { AppError, deserializeError } from "../../lib/errors";
import type { PageAnalysis } from "../../lib/pdf/engine/analyze";
import type { ObjectEdit } from "../../lib/pdf/engine/objects";
import type { SessionInfo } from "../../lib/pdf/engine/session";
import type { EditReport, LineEditRequest } from "../../lib/pdf/engine/textEdit";
import type { EngineMessage, EngineRequest, EngineResponse, EngineResults } from "./protocol";

/**
 * The editor's side of the engine worker: promise-based requests, and a way to let go of answers that are no longer
 * wanted (a page scrolled away, an edit superseded by a newer one). A running request cannot be interrupted, but its
 * result is dropped, and the worker is released entirely when the editor closes.
 */
export class EngineClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<EngineResponse>) => {
      const response = event.data;
      const entry = this.pending.get(response.id);
      if (!entry) return;
      this.pending.delete(response.id);
      if (response.ok) entry.resolve(response.result as never);
      else entry.reject(deserializeError(response.error));
    };
    worker.onerror = (event) => {
      const error = new AppError("ENGINE_FAILED", "The editor's background processor stopped. Reload the page and try again.", { details: event.message });
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  private request<K extends EngineRequest["type"]>(request: Extract<EngineRequest, { type: K }>, signal?: AbortSignal, transfer: Transferable[] = []): Promise<EngineResults[K]> {
    if (signal?.aborted) return Promise.reject(new AppError("CANCELLED", "The request was cancelled."));
    const worker = this.ensure();
    const id = this.nextId++;
    return new Promise<EngineResults[K]>((resolve, reject) => {
      const done = (action: () => void) => {
        signal?.removeEventListener("abort", onAbort);
        action();
      };
      const onAbort = () => {
        // Nothing is going to read the answer: forget it, and tell the caller.
        this.pending.delete(id);
        reject(new AppError("CANCELLED", "The request was cancelled."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve: ((value: EngineResults[K]) => done(() => resolve(value))) as never, reject: (error) => done(() => reject(error)) });
      worker.postMessage({ id, ...request } as EngineMessage, transfer);
    });
  }

  /** Opens a document in the worker. The bytes are copied, so the caller keeps its own. */
  open(source: string, name: string, bytes: Uint8Array, password?: string): Promise<SessionInfo> {
    const copy = bytes.slice();
    return this.request({ type: "open", source, name, bytes: copy, password }, undefined, [copy.buffer as ArrayBuffer]);
  }

  analyze(source: string, page: number, signal?: AbortSignal): Promise<PageAnalysis> {
    return this.request({ type: "analyze", source, page }, signal);
  }

  derive(source: string, page: number, edits: LineEditRequest[], objects: ObjectEdit[], signal?: AbortSignal): Promise<{ bytes: Uint8Array; report: EditReport | null }> {
    return this.request({ type: "derive", source, page, edits, objects }, signal);
  }

  close(source: string): Promise<null> {
    return this.worker ? this.request({ type: "close", source }) : Promise.resolve(null);
  }

  /** Stops the worker and frees everything it holds. */
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    const error = new AppError("CANCELLED", "The editor was closed.");
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }
}
