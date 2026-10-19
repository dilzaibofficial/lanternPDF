/**
 * Undo and redo over immutable states. Every step carries a label, so the list of what was done is real and can be
 * shown. Because states are immutable and share their unchanged parts, keeping many of them is cheap.
 */

export interface Entry<T> {
  state: T;
  /** What this step did, in words: "Move 2 objects". */
  label: string;
  at: number;
  /** Steps with the same key close together count as one (a drag, a burst of typing). */
  key?: string;
}

export interface History<T> {
  past: Entry<T>[];
  present: Entry<T>;
  future: Entry<T>[];
  /** The state as of the last save; `isDirty` compares by identity. */
  saved: T;
}

export interface CommitOptions {
  key?: string;
  now?: number;
  mergeWindowMs?: number;
  limit?: number;
}

const DEFAULT_LIMIT = 300;
const DEFAULT_WINDOW = 1000;

export function createHistory<T>(state: T, label = "Open document", now = Date.now()): History<T> {
  return { past: [], present: { state, label, at: now }, future: [], saved: state };
}

/** Records a new state. Setting the same state again records nothing. */
export function commit<T>(history: History<T>, state: T, label: string, options: CommitOptions = {}): History<T> {
  if (Object.is(state, history.present.state)) return history;
  const now = options.now ?? Date.now();
  const window = options.mergeWindowMs ?? DEFAULT_WINDOW;
  const entry: Entry<T> = { state, label, at: now, key: options.key };
  if (options.key !== undefined && history.present.key === options.key && now - history.present.at < window && history.past.length > 0) {
    return { ...history, present: { ...entry, at: now }, future: [] };
  }
  const past = [...history.past, history.present].slice(-(options.limit ?? DEFAULT_LIMIT));
  return { ...history, past, present: entry, future: [] };
}

export function undo<T>(history: History<T>): History<T> {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return { ...history, past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
}

export function redo<T>(history: History<T>): History<T> {
  const [next, ...rest] = history.future;
  if (!next) return history;
  return { ...history, past: [...history.past, history.present], present: next, future: rest };
}

/** Jumps to the `index`th state of the whole list (past, present, future in order). */
export function jumpTo<T>(history: History<T>, index: number): History<T> {
  const all = [...history.past, history.present, ...history.future];
  const target = all[index];
  if (!target) return history;
  return { ...history, past: all.slice(0, index), present: target, future: all.slice(index + 1) };
}

export const canUndo = <T>(history: History<T>): boolean => history.past.length > 0;
export const canRedo = <T>(history: History<T>): boolean => history.future.length > 0;
export const isDirty = <T>(history: History<T>): boolean => history.present.state !== history.saved;
export const markSaved = <T>(history: History<T>): History<T> => ({ ...history, saved: history.present.state });

/** Every step, oldest first, with where "now" is. */
export function steps<T>(history: History<T>): { label: string; at: number; current: boolean }[] {
  return [...history.past, history.present, ...history.future].map((entry, index) => ({ label: entry.label, at: entry.at, current: index === history.past.length }));
}
