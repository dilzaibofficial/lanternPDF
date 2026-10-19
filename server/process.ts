import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** A program to run, plus arguments that always come first (for example the script a Node wrapper runs). */
export interface Command {
  command: string;
  prefixArgs: string[];
}

/**
 * Turns a configured path into something runnable. A `.js`, `.mjs` or `.cjs` file is run with the current
 * Node binary, so an unusual install (or a test double) can be a small wrapper script.
 */
export function toCommand(path: string): Command {
  return /\.[cm]?js$/i.test(path) ? { command: process.execPath, prefixArgs: [path] } : { command: path, prefixArgs: [] };
}

export interface RunOptions {
  cwd?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** Output kept per stream, in bytes. The rest is discarded. */
  maxOutputBytes?: number;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Stops a process and everything it started (LibreOffice launches helper processes of its own). */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL"); // the whole process group: the child was started detached
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * Runs a program without a shell (so file names can never be interpreted as commands), with a hard
 * time limit. On timeout the whole process tree is killed and `timedOut` is set.
 */
export function runCommand(command: Command, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const limit = options.maxOutputBytes ?? 64 * 1024;
    const child = spawn(command.command, [...command.prefixArgs, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve(result);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < limit) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < limit) stderr += chunk.toString("utf8");
    });

    let grace: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // If the pipes stay open after the kill, do not wait for them forever.
      grace = setTimeout(() => finish({ code: null, signal: "SIGKILL", stdout, stderr, timedOut }), 2000);
    }, options.timeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      reject(error);
    });
    child.on("close", (code, signal) => finish({ code, signal, stdout, stderr, timedOut }));
  });
}

/**
 * The environment given to converters: just what they need to start, never the server's own secrets.
 * Home and temp folders point inside the job, so nothing a converter writes outlives it.
 */
export function converterEnv(jobDir: string): NodeJS.ProcessEnv {
  const keep = ["PATH", "Path", "SystemRoot", "windir", "ComSpec", "PATHEXT", "LANG", "LC_ALL", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.HOME = jobDir;
  env.USERPROFILE = jobDir;
  env.APPDATA = join(jobDir, "appdata");
  env.LOCALAPPDATA = join(jobDir, "localappdata");
  env.TMPDIR = jobDir;
  env.TMP = jobDir;
  env.TEMP = jobDir;
  return env;
}

function isExecutable(path: string): boolean {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Looks for a program by name on PATH (honouring PATHEXT on Windows). */
export function findOnPath(names: readonly string[]): string | null {
  const folders = (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const folder of folders) {
    for (const name of names) {
      for (const extension of extensions) {
        const candidate = join(folder, process.platform === "win32" ? `${name}${extension.toLowerCase()}` : name);
        if (isExecutable(candidate)) return candidate;
      }
    }
  }
  return null;
}

export { isExecutable };
