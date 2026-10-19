import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Capabilities, EngineStatus } from "../shared/api.js";
import type { ServerConfig } from "./config.js";
import { type Command, findOnPath, isExecutable, runCommand, toCommand } from "./process.js";

export interface Engine {
  /** Present when the engine can be run. */
  command: Command | null;
  status: EngineStatus;
}

const PROBE_TIMEOUT_MS = 20_000;

function defaultLibreOfficePaths(): string[] {
  switch (process.platform) {
    case "win32":
      return [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432].filter((base): base is string => Boolean(base)).map((base) => join(base, "LibreOffice", "program", "soffice.exe"));
    case "darwin":
      return ["/Applications/LibreOffice.app/Contents/MacOS/soffice"];
    default:
      return ["/usr/bin/soffice", "/usr/bin/libreoffice", "/usr/lib/libreoffice/program/soffice", "/opt/libreoffice/program/soffice", "/snap/bin/libreoffice"];
  }
}

function defaultGhostscriptPaths(): string[] {
  if (process.platform !== "win32") return ["/usr/bin/gs", "/usr/local/bin/gs", "/opt/homebrew/bin/gs"];
  // Windows installs into a versioned folder: C:\Program Files\gs\gs10.04.0\bin\gswin64c.exe
  const found: string[] = [];
  for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432]) {
    if (!base) continue;
    try {
      for (const folder of readdirSync(join(base, "gs"))) found.push(join(base, "gs", folder, "bin", "gswin64c.exe"), join(base, "gs", folder, "bin", "gswin32c.exe"));
    } catch {
      // no Ghostscript folder here
    }
  }
  return found;
}

/** First line of `--version` output, which is all the setup hint needs. */
async function probe(command: Command, label: string): Promise<EngineStatus> {
  try {
    const result = await runCommand(command, ["--version"], { timeoutMs: PROBE_TIMEOUT_MS, cwd: process.cwd(), env: { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot } });
    if (result.timedOut) return { available: false, reason: `${label} did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds.` };
    if (result.code !== 0) return { available: false, reason: `${label} was found but reported an error when asked for its version.` };
    const line = (result.stdout || result.stderr).split(/\r?\n/).find((text) => text.trim() !== "");
    return { available: true, version: line?.trim().slice(0, 120) };
  } catch (error) {
    return { available: false, reason: `${label} was found but could not be started (${error instanceof Error ? error.message : "unknown error"}).` };
  }
}

/** A .js/.mjs wrapper is run with Node, so it only has to exist; a real program must be executable. */
const canRun = (path: string): boolean => (/\.[cm]?js$/i.test(path) ? existsSync(path) : isExecutable(path));

async function detect(label: string, configured: string, names: readonly string[], fallbacks: readonly string[], setting: string): Promise<Engine> {
  if (configured && !canRun(configured)) {
    return { command: null, status: { available: false, reason: `${setting} points to “${configured}”, which does not exist or cannot be run.` } };
  }
  const path = configured || (findOnPath(names) ?? fallbacks.find((candidate) => isExecutable(candidate)) ?? null);
  if (!path) return { command: null, status: { available: false, reason: `${label} is not installed (or not on the server's PATH). Install it, or set ${setting}.` } };
  const command = toCommand(path);
  const status = await probe(command, label);
  return { command: status.available ? command : null, status };
}

export const detectLibreOffice = (config: Pick<ServerConfig, "sofficePath">): Promise<Engine> =>
  detect("LibreOffice", config.sofficePath, process.platform === "win32" ? ["soffice", "libreoffice"] : ["soffice", "libreoffice"], defaultLibreOfficePaths(), "SOFFICE_PATH");

export const detectGhostscript = (config: Pick<ServerConfig, "ghostscriptPath">): Promise<Engine> =>
  detect("Ghostscript", config.ghostscriptPath, process.platform === "win32" ? ["gswin64c", "gswin32c", "gs"] : ["gs"], defaultGhostscriptPaths(), "GHOSTSCRIPT_PATH");

export interface Engines {
  libreoffice: Engine;
  ghostscript: Engine;
}

/** Remembers what the engines can do for a short time, so /api/capabilities does not start programs on every request. */
export class EngineRegistry {
  private cached: { at: number; engines: Engines } | null = null;
  private pending: Promise<Engines> | null = null;

  constructor(
    private readonly detectors: { libreoffice: () => Promise<Engine>; ghostscript: () => Promise<Engine> },
    private readonly ttlMs = 60_000,
  ) {}

  async get(): Promise<Engines> {
    if (this.cached && Date.now() - this.cached.at < this.ttlMs) return this.cached.engines;
    this.pending ??= Promise.all([this.detectors.libreoffice(), this.detectors.ghostscript()])
      .then(([libreoffice, ghostscript]) => {
        const engines = { libreoffice, ghostscript };
        this.cached = { at: Date.now(), engines };
        return engines;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  async capabilities(config: Pick<ServerConfig, "version" | "maxUploadBytes">): Promise<Capabilities> {
    const engines = await this.get();
    return { version: config.version, limits: { maxUploadBytes: config.maxUploadBytes }, engines: { libreoffice: engines.libreoffice.status, ghostscript: engines.ghostscript.status } };
  }
}
