import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Everything the optional server can be told. Read from the environment once, at start-up. */
export interface ServerConfig {
  port: number;
  host: string;
  /** Browser origins allowed to call /api from another origin. Empty means same-origin only. */
  allowedOrigins: string[];
  trustProxy: boolean;
  maxUploadBytes: number;
  rateLimitPerMinute: number;
  maxConcurrentJobs: number;
  /** How many more jobs may wait for a free slot before new ones are refused with 503. */
  maxQueuedJobs: number;
  /** Where uploads and conversion output live while a job runs. */
  tempDir: string;
  retentionMinutes: number;
  /** Explicit path to LibreOffice's `soffice`. Empty: look it up. A `.js`/`.mjs` path is run with Node. */
  sofficePath: string;
  /** Explicit path to Ghostscript. Empty: look it up. */
  ghostscriptPath: string;
  conversionTimeoutMs: number;
  /** The built web app (`vite build` output) the server serves. */
  staticDir: string;
  version: string;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

const MB = 1024 * 1024;

/** The folder holding this project's package.json, found by walking up from this file (works from `server/` and from `dist-server/server/`). */
export function projectRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate)) {
      try {
        if ((JSON.parse(readFileSync(candidate, "utf8")) as { name?: string }).name === "lanternpdf") return directory;
      } catch {
        // not readable as JSON: keep looking
      }
    }
    directory = dirname(directory);
  }
  return process.cwd();
}

function readVersion(root: string): string {
  try {
    return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

type Env = Record<string, string | undefined>;

/** Reads the environment into a validated config. Every problem is reported at once, so one run fixes them all. */
export function loadConfig(env: Env = process.env, overrides: Partial<ServerConfig> = {}): ServerConfig {
  const problems: string[] = [];

  const number = (name: string, fallback: number, min: number, max: number, integer = true): number => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
      problems.push(`${name} must be ${integer ? "a whole number" : "a number"} from ${min} to ${max} (got “${raw}”).`);
      return fallback;
    }
    return value;
  };
  const text = (name: string, fallback = ""): string => env[name]?.trim() || fallback;
  const flag = (name: string): boolean => ["1", "true", "yes", "on"].includes(text(name).toLowerCase());

  const origins = text("ALLOWED_ORIGINS")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  for (const origin of origins) {
    let normalized = "";
    try {
      normalized = new URL(origin).origin;
    } catch {
      // reported below
    }
    if (normalized !== origin) problems.push(`ALLOWED_ORIGINS entry “${origin}” must be an origin such as https://pdf.example.com (scheme, host and optional port, no path).`);
  }

  const maxConcurrentJobs = number("MAX_CONCURRENT_JOBS", 2, 1, 64);
  const root = projectRoot();
  const config: ServerConfig = {
    port: number("PORT", 8787, 0, 65535),
    host: text("HOST", "127.0.0.1"),
    allowedOrigins: origins,
    trustProxy: flag("TRUST_PROXY"),
    maxUploadBytes: number("MAX_UPLOAD_MB", 50, 1, 4096) * MB,
    rateLimitPerMinute: number("RATE_LIMIT_PER_MINUTE", 30, 1, 100_000),
    maxConcurrentJobs,
    maxQueuedJobs: number("MAX_QUEUED_JOBS", maxConcurrentJobs * 4, 0, 1000),
    tempDir: resolve(text("TEMP_DIR") || join(tmpdir(), "lanternpdf-jobs")),
    retentionMinutes: number("FILE_RETENTION_MINUTES", 15, 1, 1440),
    sofficePath: text("SOFFICE_PATH"),
    ghostscriptPath: text("GHOSTSCRIPT_PATH"),
    conversionTimeoutMs: number("CONVERSION_TIMEOUT_SECONDS", 120, 5, 3600) * 1000,
    staticDir: resolve(text("STATIC_DIR") || join(root, "dist")),
    version: readVersion(root),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return { ...config, ...overrides };
}
