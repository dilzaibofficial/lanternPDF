const MB = 1024 * 1024;

function fromEnv(name: string, fallback: number): number {
  const raw = (import.meta.env as Record<string, string | undefined>)[name];
  const value = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Limits for tools that run in the browser. They protect the tab from running out of memory; they can
 * be raised at build time with VITE_MAX_FILE_MB and VITE_MAX_FILES. (Server conversions are limited by
 * the server itself, see MAX_UPLOAD_MB.)
 */
export const LIMITS = {
  maxFileBytes: fromEnv("VITE_MAX_FILE_MB", 250) * MB,
  maxFiles: fromEnv("VITE_MAX_FILES", 50),
  /** Largest image accepted by the image tools. */
  maxImageBytes: fromEnv("VITE_MAX_IMAGE_MB", 60) * MB,
} as const;
