import { useCallback, useEffect, useRef, useState } from "react";
import { type AppError, toAppError } from "../lib/errors";

export type JobState<T> =
  | { phase: "idle" }
  | { phase: "running"; fraction: number; message?: string }
  | { phase: "done"; result: T }
  | { phase: "error"; error: AppError };

export interface JobContext {
  signal: AbortSignal;
  onProgress: (fraction: number, message?: string) => void;
}

/**
 * Runs one long task at a time and exposes its state. Starting a new task cancels the previous one;
 * cancelling returns to `idle`; late results from a cancelled or replaced task are ignored.
 */
export function useJob<T>() {
  const [state, setState] = useState<JobState<T>>({ phase: "idle" });
  const controller = useRef<AbortController | null>(null);
  const runId = useRef(0);

  useEffect(
    () => () => {
      runId.current += 1;
      controller.current?.abort();
    },
    [],
  );

  const run = useCallback(async (work: (context: JobContext) => Promise<T>) => {
    controller.current?.abort();
    const mine = new AbortController();
    controller.current = mine;
    const id = (runId.current += 1);
    setState({ phase: "running", fraction: 0 });
    try {
      const result = await work({
        signal: mine.signal,
        onProgress: (fraction, message) => {
          if (runId.current === id) setState({ phase: "running", fraction, message });
        },
      });
      if (runId.current === id) setState({ phase: "done", result });
    } catch (error) {
      if (runId.current !== id) return;
      const app = toAppError(error);
      setState(app.code === "CANCELLED" ? { phase: "idle" } : { phase: "error", error: app });
    }
  }, []);

  const cancel = useCallback(() => controller.current?.abort(), []);

  const reset = useCallback(() => {
    runId.current += 1;
    controller.current?.abort();
    setState({ phase: "idle" });
  }, []);

  return { state, run, cancel, reset };
}
