import { useCallback, useEffect, useRef, useState } from "react";
import { LIMITS } from "../config/limits";
import { AppError, toAppError } from "../lib/errors";
import { type Rejection, checkFiles, contentProblem } from "../lib/files";

export type DocItemStatus = "reading" | "ready" | "invalid";

export interface DocItem {
  id: string;
  name: string;
  size: number;
  bytes: Uint8Array | null;
  status: DocItemStatus;
  message?: string;
}

interface Options {
  extensions: readonly string[];
  /** Label for messages, e.g. "Word documents". */
  label: string;
  /** Largest file accepted, in bytes. Defaults to the browser limit; pass the server's when it is smaller. */
  maxBytes?: number;
}

/**
 * The list of non-PDF documents a tool is working with (Word, Excel, PowerPoint files): validated by
 * extension, size and content, in the order they were added.
 */
export function useDocFiles({ extensions, label, maxBytes = LIMITS.maxFileBytes }: Options) {
  const [items, setItems] = useState<DocItem[]>([]);
  const [rejections, setRejections] = useState<Rejection[]>([]);
  const itemsRef = useRef<DocItem[]>([]);
  const counter = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const commit = useCallback((next: DocItem[]) => {
    itemsRef.current = next;
    if (alive.current) setItems(next);
  }, []);

  const patch = useCallback((id: string, changes: Partial<DocItem>) => commit(itemsRef.current.map((item) => (item.id === id ? { ...item, ...changes } : item))), [commit]);

  const addFiles = useCallback(
    (files: readonly File[]) => {
      const { accepted, rejected } = checkFiles(files, { extensions, maxBytes, maxFiles: LIMITS.maxFiles, existing: itemsRef.current.length, label });
      setRejections(rejected);
      if (accepted.length === 0) return;
      const created: DocItem[] = accepted.map((file) => {
        counter.current += 1;
        return { id: `doc-${counter.current}`, name: file.name, size: file.size, bytes: null, status: "reading" };
      });
      commit([...itemsRef.current, ...created]);
      accepted.forEach((file, index) => {
        const id = (created[index] as DocItem).id;
        void (async () => {
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const problem = contentProblem(file.name, bytes);
            patch(id, problem ? { status: "invalid", message: problem } : { bytes, status: "ready" });
          } catch (error) {
            patch(id, { status: "invalid", message: error instanceof AppError ? error.message : toAppError(error).message });
          }
        })();
      });
    },
    [commit, extensions, label, maxBytes, patch],
  );

  const remove = useCallback((id: string) => commit(itemsRef.current.filter((item) => item.id !== id)), [commit]);

  const move = useCallback(
    (from: number, to: number) => {
      const list = [...itemsRef.current];
      if (from < 0 || from >= list.length) return;
      const [moved] = list.splice(from, 1);
      list.splice(Math.max(0, Math.min(list.length, to)), 0, moved as DocItem);
      commit(list);
    },
    [commit],
  );

  const clear = useCallback(() => {
    commit([]);
    setRejections([]);
  }, [commit]);

  return {
    items,
    ready: items.filter((item) => item.status === "ready" && item.bytes !== null),
    busy: items.some((item) => item.status === "reading"),
    rejections,
    clearRejections: () => setRejections([]),
    addFiles,
    remove,
    move,
    clear,
  };
}
