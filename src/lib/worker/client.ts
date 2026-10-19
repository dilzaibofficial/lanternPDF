import { AppError, deserializeError } from "../errors";
import type { OperationArgs, OperationName, OperationResult } from "../pdf/ops";
import type { WorkerRequest, WorkerResponse } from "./protocol";

export interface RunOptions {
  onProgress?: (fraction: number, message?: string) => void;
  /** Aborting terminates the worker immediately; the promise rejects with a CANCELLED error. */
  signal?: AbortSignal;
}

/**
 * Runs one PDF operation in a fresh background worker.
 *
 * A fresh worker per job is deliberate: cancelling is `terminate()` (instant, and it frees all the
 * memory the WebAssembly engine grew), and one job can never leak state into the next.
 */
export function runOperation<K extends OperationName>(
  name: K,
  args: OperationArgs<K>,
  options: RunOptions = {},
): Promise<OperationResult<K>> {
  return new Promise((resolve, reject) => {
    const { onProgress, signal } = options;
    if (signal?.aborted) {
      reject(new AppError("CANCELLED", "The operation was cancelled."));
      return;
    }

    const worker = new Worker(new URL("./pdf.worker.ts", import.meta.url), { type: "module" });
    let settled = false;

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      action();
    };
    const onAbort = () => finish(() => reject(new AppError("CANCELLED", "The operation was cancelled.")));
    signal?.addEventListener("abort", onAbort, { once: true });

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        onProgress?.(message.fraction, message.message);
      } else if (message.type === "result") {
        finish(() => resolve(message.result as OperationResult<K>));
      } else {
        finish(() => reject(deserializeError(message.error)));
      }
    };
    worker.onerror = (event) => {
      finish(() =>
        reject(
          new AppError("ENGINE_FAILED", "The background processor could not start. Reload the page and try again.", {
            details: event.message,
          }),
        ),
      );
    };

    const request: WorkerRequest = { name, args };
    worker.postMessage(request);
  });
}
