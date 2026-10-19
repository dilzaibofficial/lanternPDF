import type { SerializedError } from "../errors";
import type { OperationName } from "../pdf/ops";

/** Messages between the page and the background worker. */
export type WorkerRequest = {
  name: OperationName;
  // Typed per operation at the call site (see runOperation); the wire format is just data.
  args: unknown;
};

export type WorkerResponse =
  | { type: "progress"; fraction: number; message?: string }
  | { type: "result"; result: unknown }
  | { type: "error"; error: SerializedError };

/**
 * Finds every standalone ArrayBuffer inside a result so it can be *transferred* to the page instead
 * of copied. Only buffers that a typed array owns completely are transferred; views into a larger
 * buffer are left to be copied by the structured clone.
 */
export function collectTransferables(value: unknown, found: Set<ArrayBuffer> = new Set(), depth = 0): ArrayBuffer[] {
  if (depth > 6 || value === null || typeof value !== "object") return [...found];
  if (value instanceof Uint8Array) {
    if (value.buffer instanceof ArrayBuffer && value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) {
      found.add(value.buffer);
    }
    return [...found];
  }
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const child of children) collectTransferables(child, found, depth + 1);
  return [...found];
}
