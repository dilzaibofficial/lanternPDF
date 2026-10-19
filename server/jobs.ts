import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "./errors.js";

/** The shape of the folder names `JobDirs.create` makes (random UUIDs). */
const JOB_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One request's private working folder. Everything a job writes lives here, and `cleanup` removes it all. */
export interface Job {
  id: string;
  dir: string;
  cleanup: () => Promise<void>;
}

/**
 * Creates a private folder per job under one root, deletes it when the job ends, and (as a safety net for
 * crashes) removes any folder that has been around longer than the retention time.
 */
export class JobDirs {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly root: string,
    private readonly retentionMs: number,
  ) {}

  async create(): Promise<Job> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const dir = join(this.root, id);
    await mkdir(dir, { mode: 0o700 });
    let removed = false;
    return {
      id,
      dir,
      cleanup: async () => {
        if (removed) return;
        removed = true;
        await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      },
    };
  }

  /**
   * Removes job folders older than the retention time. Returns how many were removed.
   * Only folders this class created (their names are random UUIDs) are ever touched, so pointing TEMP_DIR at a
   * shared folder such as /tmp cannot cost anyone their files.
   */
  async sweep(now = Date.now()): Promise<number> {
    let removed = 0;
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return 0; // nothing there yet
    }
    for (const name of names) {
      if (!JOB_NAME.test(name)) continue;
      const path = join(this.root, name);
      try {
        const info = await stat(path);
        if (now - info.mtimeMs > this.retentionMs) {
          await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
          removed += 1;
        }
      } catch {
        // it vanished while we looked: fine
      }
    }
    return removed;
  }

  start(intervalMs = 60_000): void {
    this.stop();
    this.timer = setInterval(() => void this.sweep(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Limits how many conversions run at once, with a bounded waiting line so overload is refused instead of piling up. */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly limit: number,
    private readonly maxQueued: number,
  ) {}

  /** Waits for a free slot. Throws 503 BUSY when too many jobs are already waiting. Call the returned function when done. */
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      if (this.waiting.length >= this.maxQueued) throw new HttpError(503, "BUSY", "The server is busy converting other files. Please try again in a minute.");
      await new Promise<void>((resolve) => this.waiting.push(resolve)); // the releasing job hands its slot over
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    };
  }

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }
}
