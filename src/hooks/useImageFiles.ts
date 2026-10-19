import { useCallback, useEffect, useRef, useState } from "react";
import { LIMITS } from "../config/limits";
import { AppError, toAppError } from "../lib/errors";
import { type Rejection, checkFiles, contentProblem } from "../lib/files";

export type ImageItemStatus = "reading" | "ready" | "invalid";

export interface ImageItem {
  id: string;
  name: string;
  size: number;
  bytes: Uint8Array | null;
  /** Object URL for the thumbnail; released when the item is removed. */
  previewUrl: string | null;
  status: ImageItemStatus;
  message?: string;
}

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"] as const;

/** The list of images for the image-to-PDF tool: validation, previews, ordering. */
export function useImageFiles() {
  const [items, setItems] = useState<ImageItem[]>([]);
  const [rejections, setRejections] = useState<Rejection[]>([]);
  const itemsRef = useRef<ImageItem[]>([]);
  const counter = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const item of itemsRef.current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    };
  }, []);

  const commit = useCallback((next: ImageItem[]) => {
    itemsRef.current = next;
    if (alive.current) setItems(next);
  }, []);

  const patch = useCallback(
    (id: string, changes: Partial<ImageItem>) => commit(itemsRef.current.map((item) => (item.id === id ? { ...item, ...changes } : item))),
    [commit],
  );

  const addFiles = useCallback(
    (files: readonly File[]) => {
      const { accepted, rejected } = checkFiles(files, {
        extensions: IMAGE_EXTENSIONS,
        maxBytes: LIMITS.maxImageBytes,
        maxFiles: LIMITS.maxFiles,
        existing: itemsRef.current.length,
        label: "images",
      });
      setRejections(rejected);
      if (accepted.length === 0) return;

      const created: ImageItem[] = accepted.map((file) => {
        counter.current += 1;
        return { id: `img-${counter.current}`, name: file.name, size: file.size, bytes: null, previewUrl: null, status: "reading" };
      });
      commit([...itemsRef.current, ...created]);

      accepted.forEach((file, index) => {
        const id = (created[index] as ImageItem).id;
        void (async () => {
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const problem = contentProblem(file.name, bytes);
            if (problem) {
              patch(id, { status: "invalid", message: problem });
              return;
            }
            // Revoke if the item was removed while we were reading.
            const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: file.type || undefined }));
            if (!itemsRef.current.some((item) => item.id === id)) {
              URL.revokeObjectURL(url);
              return;
            }
            patch(id, { bytes, previewUrl: url, status: "ready" });
          } catch (error) {
            patch(id, { status: "invalid", message: error instanceof AppError ? error.message : toAppError(error).message });
          }
        })();
      });
    },
    [commit, patch],
  );

  const remove = useCallback(
    (id: string) => {
      const target = itemsRef.current.find((item) => item.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      commit(itemsRef.current.filter((item) => item.id !== id));
    },
    [commit],
  );

  const move = useCallback(
    (from: number, to: number) => {
      const list = [...itemsRef.current];
      if (from < 0 || from >= list.length) return;
      const [moved] = list.splice(from, 1);
      list.splice(Math.max(0, Math.min(list.length, to)), 0, moved as ImageItem);
      commit(list);
    },
    [commit],
  );

  const clear = useCallback(() => {
    for (const item of itemsRef.current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
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
