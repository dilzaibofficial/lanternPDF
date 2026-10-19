import { useCallback, useEffect, useRef, useState } from "react";
import { LIMITS } from "../config/limits";
import { type Rejection, checkFiles, contentProblem } from "../lib/files";
import { toAppError } from "../lib/errors";
import type { PdfProbe } from "../lib/pdf/inspect";
import type { PdfSource } from "../lib/pdf/pdfjs";
import type { PdfInput } from "../lib/pdf/types";
import { runOperation } from "../lib/worker/client";

export type PdfItemStatus = "reading" | "ready" | "needs-password" | "wrong-password" | "damaged";

export interface PdfItem {
  id: string;
  name: string;
  size: number;
  bytes: Uint8Array | null;
  status: PdfItemStatus;
  pageCount?: number;
  /** Encrypted, whether or not a password was needed to open it. */
  encrypted: boolean;
  /** The password the user supplied for this file (kept in memory only). */
  password?: string;
  /** Why the file cannot be used, in plain language. */
  message?: string;
  /** Changes whenever the bytes or password change; safe to use in cache keys. */
  revision: number;
}

export const toPdfInput = (item: PdfItem): PdfInput => ({
  name: item.name,
  bytes: item.bytes as Uint8Array,
  password: item.password,
});

/** What the viewers need to show this file. `key` changes whenever the bytes or password do. */
export const toPdfSource = (item: PdfItem): PdfSource => ({
  key: `${item.id}:${item.revision}`,
  bytes: item.bytes as Uint8Array,
  password: item.password,
  name: item.name,
});

/** Runs at most `limit` probes at a time: each one starts a worker. */
function limiter(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}
const probeLimit = limiter(2);

interface Options {
  multiple: boolean;
  maxFiles?: number;
  maxBytes?: number;
}

/**
 * The list of PDFs a tool is working with: reading, validating and probing each file (page count,
 * password state), plus ordering, removal and unlocking.
 */
export function usePdfFiles({ multiple, maxFiles = LIMITS.maxFiles, maxBytes = LIMITS.maxFileBytes }: Options) {
  const [items, setItems] = useState<PdfItem[]>([]);
  const [rejections, setRejections] = useState<Rejection[]>([]);
  const itemsRef = useRef<PdfItem[]>([]);
  const counter = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const commit = useCallback((next: PdfItem[]) => {
    itemsRef.current = next;
    if (alive.current) setItems(next);
  }, []);

  const patch = useCallback(
    (id: string, changes: Partial<PdfItem>) => {
      commit(itemsRef.current.map((item) => (item.id === id ? { ...item, ...changes } : item)));
    },
    [commit],
  );

  const applyProbe = useCallback(
    (id: string, probe: PdfProbe, password?: string) => {
      const base = { revision: (itemsRef.current.find((i) => i.id === id)?.revision ?? 0) + 1 };
      if (probe.state === "ok") {
        patch(id, { ...base, status: "ready", pageCount: probe.pageCount, encrypted: Boolean(probe.encrypted), password, message: undefined });
      } else if (probe.state === "needs-password") {
        patch(id, { ...base, status: "needs-password", encrypted: true, message: probe.message });
      } else if (probe.state === "wrong-password") {
        patch(id, { ...base, status: "wrong-password", encrypted: true, message: probe.message });
      } else {
        patch(id, { ...base, status: "damaged", message: probe.message });
      }
    },
    [patch],
  );

  const ingest = useCallback(
    async (id: string, file: File) => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const problem = contentProblem(file.name, bytes);
        if (problem) {
          patch(id, { bytes, status: "damaged", message: problem });
          return;
        }
        patch(id, { bytes });
        const probe = await probeLimit(() => runOperation("probe", { bytes }));
        applyProbe(id, probe);
      } catch (error) {
        patch(id, { status: "damaged", message: toAppError(error).message });
      }
    },
    [applyProbe, patch],
  );

  const addFiles = useCallback(
    (files: readonly File[]) => {
      const existing = multiple ? itemsRef.current.length : 0;
      const { accepted, rejected } = checkFiles(files, {
        extensions: [".pdf"],
        maxBytes,
        maxFiles,
        existing,
        label: "PDF files",
      });
      setRejections(rejected);
      const chosen = multiple ? accepted : accepted.slice(0, 1);
      if (!multiple && accepted.length > 1) {
        setRejections([...rejected, { name: "", reason: "This tool works on one PDF at a time, so only the first file was used." }]);
      }
      if (chosen.length === 0) return;

      const created: PdfItem[] = chosen.map((file) => {
        counter.current += 1;
        return {
          id: `pdf-${counter.current}`,
          name: file.name,
          size: file.size,
          bytes: null,
          status: "reading",
          encrypted: false,
          revision: 0,
        };
      });
      commit(multiple ? [...itemsRef.current, ...created] : created);
      chosen.forEach((file, index) => void ingest((created[index] as PdfItem).id, file));
    },
    [commit, ingest, maxBytes, maxFiles, multiple],
  );

  /** Adds already-loaded bytes (for example, a file handed over from another tool). */
  const addBytes = useCallback(
    (name: string, bytes: Uint8Array) => {
      counter.current += 1;
      const id = `pdf-${counter.current}`;
      const item: PdfItem = { id, name, size: bytes.length, bytes, status: "reading", encrypted: false, revision: 0 };
      commit(multiple ? [...itemsRef.current, item] : [item]);
      void probeLimit(() => runOperation("probe", { bytes }))
        .then((probe) => applyProbe(id, probe))
        .catch((error) => patch(id, { status: "damaged", message: toAppError(error).message }));
    },
    [applyProbe, commit, multiple, patch],
  );

  const remove = useCallback((id: string) => commit(itemsRef.current.filter((item) => item.id !== id)), [commit]);

  const move = useCallback(
    (from: number, to: number) => {
      const list = [...itemsRef.current];
      if (from < 0 || from >= list.length) return;
      const target = Math.max(0, Math.min(list.length - 1, to));
      const [moved] = list.splice(from, 1);
      list.splice(target, 0, moved as PdfItem);
      commit(list);
    },
    [commit],
  );

  const clear = useCallback(() => {
    commit([]);
    setRejections([]);
  }, [commit]);

  const unlock = useCallback(
    async (id: string, password: string) => {
      const item = itemsRef.current.find((i) => i.id === id);
      if (!item?.bytes) return;
      patch(id, { status: "reading" });
      try {
        const probe = await probeLimit(() => runOperation("probe", { bytes: item.bytes as Uint8Array, password }));
        applyProbe(id, probe, probe.state === "ok" ? password : undefined);
      } catch (error) {
        patch(id, { status: "damaged", message: toAppError(error).message });
      }
    },
    [applyProbe, patch],
  );

  /** Swaps in new bytes (for instance the output of Repair PDF) and re-checks them. */
  const replace = useCallback(
    async (id: string, bytes: Uint8Array, name?: string) => {
      patch(id, { bytes, size: bytes.length, name: name ?? itemsRef.current.find((i) => i.id === id)?.name ?? "document.pdf", status: "reading", password: undefined });
      try {
        applyProbe(id, await probeLimit(() => runOperation("probe", { bytes })));
      } catch (error) {
        patch(id, { status: "damaged", message: toAppError(error).message });
      }
    },
    [applyProbe, patch],
  );

  const ready = items.filter((item) => item.status === "ready" && item.bytes !== null);
  const busy = items.some((item) => item.status === "reading");

  return {
    items,
    ready,
    busy,
    rejections,
    clearRejections: () => setRejections([]),
    addFiles,
    addBytes,
    remove,
    move,
    clear,
    unlock,
    replace,
  };
}
