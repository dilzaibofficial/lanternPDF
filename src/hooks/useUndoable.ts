import { useCallback, useState } from "react";

interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** Which kind of change produced `present`, and when, so that a burst of similar changes is one step. */
  last: { key: string; at: number } | null;
}

const LIMIT = 100;
/** Changes with the same merge key closer together than this (in ms) count as one undo step. */
const MERGE_WINDOW = 900;

export interface SetOptions {
  /** Consecutive changes with the same key (a slider being dragged, a number being typed) share one undo step. */
  merge?: string;
}

/** State with undo/redo. Setting the same value (by identity) does not add a history step. */
export function useUndoable<T>(initial: T) {
  const [history, setHistory] = useState<History<T>>({ past: [], present: initial, future: [], last: null });

  const set = useCallback((next: T | ((current: T) => T), options: SetOptions = {}) => {
    setHistory((h) => {
      const value = typeof next === "function" ? (next as (current: T) => T)(h.present) : next;
      if (Object.is(value, h.present)) return h;
      const now = Date.now();
      const last = options.merge ? { key: options.merge, at: now } : null;
      if (options.merge && h.last?.key === options.merge && now - h.last.at < MERGE_WINDOW && h.past.length > 0) {
        return { past: h.past, present: value, future: [], last };
      }
      return { past: [...h.past, h.present].slice(-LIMIT), present: value, future: [], last };
    });
  }, []);

  const undo = useCallback(() => {
    setHistory((h) => {
      const previous = h.past[h.past.length - 1];
      if (previous === undefined && h.past.length === 0) return h;
      return { past: h.past.slice(0, -1), present: previous as T, future: [h.present, ...h.future], last: null };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((h) => {
      if (h.future.length === 0) return h;
      const [next, ...rest] = h.future;
      return { past: [...h.past, h.present], present: next as T, future: rest, last: null };
    });
  }, []);

  /** Replaces the value and forgets all history. */
  const reset = useCallback((value: T) => setHistory({ past: [], present: value, future: [], last: null }), []);

  return {
    value: history.present,
    set,
    undo,
    redo,
    reset,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}
