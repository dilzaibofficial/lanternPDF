import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "@cantoo/pdf-lib";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError, Capabilities } from "../../shared/api";
import { type RunningServer, startServer } from "../../server/index";
import { ConfigError, type ServerConfig, loadConfig } from "../../server/config";
import { JobDirs, Semaphore } from "../../server/jobs";
import { extensionOf, safeName, sniff } from "../../server/validate";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_SOFFICE = resolve(here, "../fixtures/fake-soffice.mjs");
const FAKE_GS = resolve(here, "../fixtures/fake-gs.mjs");
const SOFFICE_LOG = resolve(here, "../fixtures/fake-soffice.log");
const GS_LOG = resolve(here, "../fixtures/fake-gs.log");

// ---- fixtures: small but genuine-looking files ----------------------------------------------------------

/** A .docx-shaped ZIP whose marker is stored uncompressed, so the test double can see it. */
const docx = (marker = "") => zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8("<w/>"), "marker.txt": strToU8(marker) }, { level: 0 });
const odt = (marker = "") => zipSync({ mimetype: strToU8("application/vnd.oasis.opendocument.text"), "marker.txt": strToU8(marker) }, { level: 0 });
const ole = (marker = "") => Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512), Buffer.from(marker)]);
const csv = (marker = "") => Buffer.from(`name,amount\nwidget,4\n${marker}\n`);
/** A real one-page PDF. A marker is appended as a comment after %%EOF, where the test doubles can see it and readers ignore it. */
async function pdf(marker = ""): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.addPage([300, 200]).drawText("hello", { x: 20, y: 100 });
  const bytes = await doc.save({ useObjectStreams: false });
  return marker ? new Uint8Array(Buffer.concat([bytes, Buffer.from(`\n%${marker}\n`)])) : bytes;
}

interface Upload {
  name: string;
  bytes: Uint8Array;
  fields?: Record<string, string>;
}

// ---- a running server per test ----------------------------------------------------------------------------

let tempDir = "";
let running: RunningServer | null = null;

async function start(overrides: Partial<ServerConfig> = {}): Promise<RunningServer> {
  const config = loadConfig({}, { tempDir, port: 0, host: "127.0.0.1", sofficePath: FAKE_SOFFICE, ghostscriptPath: FAKE_GS, conversionTimeoutMs: 30_000, staticDir: join(tempDir, "no-web-app"), ...overrides });
  running = await startServer(config);
  return running;
}

async function post(path: string, upload: Upload | null, fields: Record<string, string> = {}): Promise<Response> {
  const form = new FormData();
  for (const [key, value] of Object.entries({ ...upload?.fields, ...fields })) form.append(key, value);
  if (upload) form.append("file", new Blob([upload.bytes as BlobPart]), upload.name);
  return fetch(`${running?.url}${path}`, { method: "POST", body: form });
}

const jsonOf = async <T>(response: Response): Promise<T> => (await response.json()) as T;
/** Job folders (random UUID names) still on disk. A finished request must leave none. */
const leftovers = () => readdir(tempDir).then((names) => names.filter((name) => /^[0-9a-f]{8}-/.test(name)));
const emptyTemp = () => vi.waitFor(async () => expect(await leftovers()).toEqual([]), { timeout: 5000 });

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "lanternpdf-server-"));
  await rm(SOFFICE_LOG, { force: true });
  await rm(GS_LOG, { force: true });
});

afterEach(async () => {
  await running?.stop();
  running = null;
  await rm(tempDir, { recursive: true, force: true });
});

const log = async (path: string): Promise<{ pid: number; cwd: string; args: string[]; convertTo?: string; inFilter?: string; profile?: string; env?: Record<string, string | null> }[]> =>
  existsSync(path) ? (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

// ---- tests ---------------------------------------------------------------------------------------------------

describe("health and capabilities", () => {
  it("reports it is alive, and what it can do, with the engines it found", async () => {
    await start({ maxUploadBytes: 12 * 1024 * 1024 });
    expect(await (await fetch(`${running?.url}/api/health`)).json()).toEqual({ status: "ok" });

    const capabilities = await jsonOf<Capabilities>(await fetch(`${running?.url}/api/capabilities`));
    expect(capabilities.limits.maxUploadBytes).toBe(12 * 1024 * 1024);
    expect(capabilities.engines.libreoffice).toMatchObject({ available: true, version: expect.stringContaining("LibreOffice") });
    expect(capabilities.engines.ghostscript).toMatchObject({ available: true, version: "10.99.0" });
    expect(capabilities.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("says plainly when an engine is missing, and why", async () => {
    await start({ sofficePath: join(tempDir, "does-not-exist"), ghostscriptPath: "" });
    const { engines } = await jsonOf<Capabilities>(await fetch(`${running?.url}/api/capabilities`));
    expect(engines.libreoffice).toMatchObject({ available: false, reason: expect.stringContaining("SOFFICE_PATH") });
    expect(engines.ghostscript.available === false || engines.ghostscript.available === true).toBe(true); // depends on the machine; never throws
    if (!engines.ghostscript.available) expect(engines.ghostscript.reason).toMatch(/Ghostscript/);
  });

  it("refuses the conversion routes with 503 when the engine is missing", async () => {
    await start({ sofficePath: join(tempDir, "nope"), ghostscriptPath: join(tempDir, "nope") });
    const office = await post("/api/convert/office-to-pdf", { name: "a.docx", bytes: docx() });
    expect(office.status).toBe(503);
    expect((await jsonOf<ApiError>(office)).error).toMatchObject({ code: "ENGINE_UNAVAILABLE", message: expect.stringContaining("LibreOffice") });
    const compress = await post("/api/compress", { name: "a.pdf", bytes: await pdf() }, { level: "ebook" });
    expect(compress.status).toBe(503);
    expect((await jsonOf<ApiError>(compress)).error.code).toBe("ENGINE_UNAVAILABLE");
    await emptyTemp();
  });
});

describe("office to PDF", () => {
  it("converts a document, returns a real PDF, and leaves nothing behind", async () => {
    await start();
    const response = await post("/api/convert/office-to-pdf", { name: "Quarterly report.docx", bytes: docx() });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("Quarterly report.pdf");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    await emptyTemp();
  });

  it("accepts each supported family: OpenDocument, legacy binary and CSV", async () => {
    await start();
    for (const upload of [
      { name: "a.odt", bytes: odt() },
      { name: "b.doc", bytes: ole() },
      { name: "c.xls", bytes: ole() },
      { name: "d.csv", bytes: csv() },
    ]) {
      const response = await post("/api/convert/office-to-pdf", upload);
      expect(response.status, upload.name).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    }
  });

  it("starts LibreOffice with a private profile, no shell, the client's name never used, and no secrets from the server's environment", async () => {
    process.env.SECRET_TOKEN = "super-secret";
    try {
      await start();
      await post("/api/convert/office-to-pdf", { name: "../../etc/evil name; rm -rf.docx", bytes: docx() });
    } finally {
      delete process.env.SECRET_TOKEN;
    }
    const [call] = await log(SOFFICE_LOG);
    const calls = (await log(SOFFICE_LOG)).filter((entry) => !entry.args.includes("--version"));
    const run = calls[0] ?? call;
    expect(run?.args).toEqual(expect.arrayContaining(["--headless", "--norestore", "--nolockcheck", "--nologo", "--convert-to", "pdf", "--outdir"]));
    expect(run?.args.find((arg) => arg.startsWith("-env:UserInstallation=file:///"))).toBeTruthy();
    const input = run?.args.at(-1) as string;
    expect(input.replaceAll("\\", "/")).toMatch(/\/upload\.docx$/); // the name the server chose, not the client's
    expect(input).not.toContain("evil");
    expect(run?.env?.SECRET_TOKEN).toBeNull(); // the converter does not inherit the server's environment
    expect(run?.env?.HOME).toBe(run?.cwd); // and its home folder is the job folder
    await emptyTemp();
  });

  it("rejects what it should: no file, a wrong type, a file that is not what its name says, an empty file", async () => {
    await start();
    const failure = async (response: Response, code: string, message?: RegExp) => {
      expect(response.status).toBe(400);
      const body = await jsonOf<ApiError>(response);
      expect(body.error.code).toBe(code);
      if (message) expect(body.error.message).toMatch(message);
    };
    await failure(await post("/api/convert/office-to-pdf", null), "INVALID_FILE", /No file/);
    await failure(await post("/api/convert/office-to-pdf", { name: "run.exe", bytes: new Uint8Array([77, 90, 0, 0]) }), "INVALID_FILE", /not accepted/);
    await failure(await post("/api/convert/office-to-pdf", { name: "fake.docx", bytes: strToU8("just some text pretending") }), "INVALID_FILE", /not a real \.docx/);
    await failure(await post("/api/convert/office-to-pdf", { name: "empty.docx", bytes: new Uint8Array(0) }), "INVALID_FILE");
    await failure(await post("/api/convert/office-to-pdf", { name: "hollow.docx", bytes: zipSync({ "readme.txt": strToU8("a zip, but not a Word file") }) }), "INVALID_FILE", /missing the parts/);
    await failure(await post("/api/convert/office-to-pdf", { name: "page.pdf", bytes: await pdf() }), "INVALID_FILE", /not accepted/);
    expect(await log(SOFFICE_LOG)).toSatisfy((calls: { args: string[] }[]) => calls.every((call) => call.args.includes("--version"))); // nothing reached LibreOffice
    await emptyTemp();
  });

  it("enforces the upload limit with 413", async () => {
    await start({ maxUploadBytes: 2048 });
    const response = await post("/api/convert/office-to-pdf", { name: "big.docx", bytes: docx("x".repeat(10_000)) });
    expect(response.status).toBe(413);
    expect((await jsonOf<ApiError>(response)).error).toMatchObject({ code: "FILE_TOO_LARGE", message: expect.stringContaining("limit") });
    await emptyTemp();
  });

  it("reports a failed conversion honestly, without leaking server details", async () => {
    await start();
    const response = await post("/api/convert/office-to-pdf", { name: "broken.docx", bytes: docx("FAKE:FAIL") });
    expect(response.status).toBe(500);
    const body = await jsonOf<ApiError>(response);
    expect(body.error.code).toBe("CONVERSION_FAILED");
    expect(body.error.message).not.toMatch(/source file could not be loaded|upload\.docx|lanternpdf-server/i);
    await emptyTemp();
  });

  it("never returns an empty or wrong file as if it were a success", async () => {
    await start();
    for (const marker of ["FAKE:NOOUTPUT", "FAKE:GARBAGE"]) {
      const response = await post("/api/convert/office-to-pdf", { name: "odd.docx", bytes: docx(marker) });
      expect(response.status, marker).toBe(500);
      expect((await jsonOf<ApiError>(response)).error.code).toBe("CONVERSION_FAILED");
    }
    await emptyTemp();
  });

  it("stops a conversion that hangs, kills the process, and answers 504", async () => {
    await start({ conversionTimeoutMs: 1500 });
    const started = Date.now();
    const response = await post("/api/convert/office-to-pdf", { name: "hang.docx", bytes: docx("FAKE:HANG") });
    expect(response.status).toBe(504);
    expect((await jsonOf<ApiError>(response)).error.code).toBe("TIMEOUT");
    expect(Date.now() - started).toBeLessThan(10_000);

    const hung = (await log(SOFFICE_LOG)).find((entry) => !entry.args.includes("--version"));
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await vi.waitFor(() => expect(alive(hung?.pid as number)).toBe(false), { timeout: 5000 }); // the process really is gone
    await emptyTemp();
  });
});

describe("PDF to Word / PowerPoint (layout mode)", () => {
  it("asks LibreOffice's PDF import filter for the right format and returns an Office file", async () => {
    await start();
    for (const [target, filter, mime] of [
      ["docx", "writer_pdf_import", "wordprocessingml"],
      ["pptx", "impress_pdf_import", "presentationml"],
    ] as const) {
      const response = await post("/api/convert/pdf-to-office", { name: "Slides deck.pdf", bytes: await pdf() }, { target });
      expect(response.status, target).toBe(200);
      expect(response.headers.get("content-type")).toContain(mime);
      expect(response.headers.get("content-disposition")).toContain(`Slides deck.${target}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes[0]).toBe(0x50); // a ZIP container, as Office files are
      expect(Buffer.from(bytes).includes("converted with")).toBe(false); // (compressed inside; the content check is the log below)
      const call = (await log(SOFFICE_LOG)).filter((entry) => entry.inFilter === `--infilter=${filter}`).at(-1);
      expect(call?.convertTo).toContain(target);
    }
    await emptyTemp();
  });

  it("validates the target and that the upload really is a PDF", async () => {
    await start();
    const badTarget = await post("/api/convert/pdf-to-office", { name: "a.pdf", bytes: await pdf() }, { target: "exe" });
    expect(badTarget.status).toBe(400);
    expect((await jsonOf<ApiError>(badTarget)).error.code).toBe("INVALID_INPUT");
    const notPdf = await post("/api/convert/pdf-to-office", { name: "a.pdf", bytes: strToU8("this is not a PDF at all") }, { target: "docx" });
    expect(notPdf.status).toBe(400);
    expect((await jsonOf<ApiError>(notPdf)).error).toMatchObject({ code: "INVALID_FILE", message: expect.stringContaining("not a PDF") });
    const wrongExtension = await post("/api/convert/pdf-to-office", { name: "a.docx", bytes: docx() }, { target: "docx" });
    expect(wrongExtension.status).toBe(400);
    await emptyTemp();
  });
});

describe("compression with Ghostscript", () => {
  it("runs Ghostscript on relative names inside the job and returns the verified result", async () => {
    await start();
    const source = await pdf();
    const response = await post("/api/compress", { name: "big file.pdf", bytes: source }, { level: "screen" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("big file_compressed.pdf");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(source); // the test double copies
    const [call] = (await log(GS_LOG)).filter((entry) => !entry.args.includes("--version"));
    expect(call?.args).toEqual(expect.arrayContaining(["-dPDFSETTINGS=/screen", "-dSAFER", "-dBATCH", "-dNOPAUSE", "-sOutputFile=compressed.pdf", "upload.pdf"]));
    await emptyTemp();
  });

  it("defaults to the ebook level and rejects unknown levels", async () => {
    await start();
    expect((await post("/api/compress", { name: "a.pdf", bytes: await pdf() })).status).toBe(200);
    const [call] = (await log(GS_LOG)).filter((entry) => !entry.args.includes("--version"));
    expect(call?.args).toContain("-dPDFSETTINGS=/ebook");
    const bad = await post("/api/compress", { name: "a.pdf", bytes: await pdf() }, { level: "extreme" });
    expect(bad.status).toBe(400);
    expect((await jsonOf<ApiError>(bad)).error.code).toBe("INVALID_INPUT");
  });

  it("reports Ghostscript failures and bad output honestly", async () => {
    await start();
    const failed = await post("/api/compress", { name: "a.pdf", bytes: await pdf("FAKE:FAIL") }, { level: "ebook" });
    expect(failed.status).toBe(500);
    expect((await jsonOf<ApiError>(failed)).error.code).toBe("CONVERSION_FAILED");
    const garbage = await post("/api/compress", { name: "a.pdf", bytes: await pdf("FAKE:GARBAGE") }, { level: "ebook" });
    expect(garbage.status).toBe(500);
    await emptyTemp();
  });
});

describe("limits and protection", () => {
  it("rate-limits per client", async () => {
    await start({ rateLimitPerMinute: 3 });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await post("/api/convert/office-to-pdf", { name: "a.docx", bytes: docx() })).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    const limited = await post("/api/convert/office-to-pdf", { name: "a.docx", bytes: docx() });
    expect((await jsonOf<ApiError>(limited)).error.code).toBe("RATE_LIMITED");
    expect((await fetch(`${running?.url}/api/health`)).status).toBe(200); // health and capabilities are not limited
  });

  it("limits concurrent conversions and refuses the overflow with 503 instead of piling up", async () => {
    await start({ maxConcurrentJobs: 1, maxQueuedJobs: 0, rateLimitPerMinute: 100 });
    const slow = post("/api/convert/office-to-pdf", { name: "slow.docx", bytes: docx("FAKE:SLOW") });
    // The first one is running (starting the stand-in process can take a while on a busy machine).
    await vi.waitFor(async () => expect((await log(SOFFICE_LOG)).filter((entry) => !entry.args.includes("--version")).length).toBe(1), { timeout: 20_000, interval: 100 });
    const refused = await post("/api/convert/office-to-pdf", { name: "second.docx", bytes: docx() });
    expect(refused.status).toBe(503);
    expect((await jsonOf<ApiError>(refused)).error.code).toBe("BUSY");
    expect((await slow).status).toBe(200);
    expect((await post("/api/convert/office-to-pdf", { name: "third.docx", bytes: docx() })).status).toBe(200); // the slot is free again
    await emptyTemp();
  });

  it("queues up to the configured length and serves those jobs in turn", async () => {
    await start({ maxConcurrentJobs: 1, maxQueuedJobs: 2, rateLimitPerMinute: 100 });
    const responses = await Promise.all([1, 2, 3].map((n) => post("/api/convert/office-to-pdf", { name: `q${n}.docx`, bytes: docx("FAKE:SLOW") })));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    await emptyTemp();
  });

  it("sets strict security headers and does not advertise the framework", async () => {
    await start();
    const response = await fetch(`${running?.url}/api/health`);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("upgrade-insecure-requests");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-powered-by")).toBeNull();
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("allows cross-origin calls only from the configured origins", async () => {
    await start({ allowedOrigins: ["https://pdf.example.com"] });
    const allowed = await fetch(`${running?.url}/api/health`, { headers: { Origin: "https://pdf.example.com" } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://pdf.example.com");
    const other = await fetch(`${running?.url}/api/health`, { headers: { Origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("has no cross-origin access at all by default", async () => {
    await start();
    const response = await fetch(`${running?.url}/api/health`, { headers: { Origin: "https://pdf.example.com" } });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers unknown API routes with a JSON 404", async () => {
    await start();
    const response = await fetch(`${running?.url}/api/nope`);
    expect(response.status).toBe(404);
    expect((await jsonOf<ApiError>(response)).error.code).toBe("NOT_FOUND");
  });
});

describe("serving the web app", () => {
  it("serves the built app, falls back to it for client-side routes, and caches assets for good", async () => {
    const dist = join(tempDir, "dist");
    await mkdir(join(dist, "assets"), { recursive: true });
    await writeFile(join(dist, "index.html"), "<!doctype html><title>LanternPDF</title>");
    await writeFile(join(dist, "assets", "app-abc123.js"), "console.log(1)");
    await writeFile(join(dist, "assets", "qpdf-abc123.wasm"), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    await start({ staticDir: dist });

    const home = await fetch(`${running?.url}/`);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("<title>LanternPDF</title>");
    expect(home.headers.get("cache-control")).toBe("no-cache");

    const route = await fetch(`${running?.url}/tools/merge`);
    expect(route.status).toBe(200);
    expect(await route.text()).toContain("<title>LanternPDF</title>");

    const asset = await fetch(`${running?.url}/assets/app-abc123.js`);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await fetch(`${running?.url}/assets/qpdf-abc123.wasm`)).headers.get("content-type")).toBe("application/wasm");
  });

  it("explains itself when the web app has not been built", async () => {
    await start();
    const response = await fetch(`${running?.url}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("npm run build");
  });
});

describe("housekeeping", () => {
  it("removes job folders older than the retention time and keeps recent ones", async () => {
    const dirs = new JobDirs(join(tempDir, "jobs"), 15 * 60_000);
    const old = await dirs.create();
    const fresh = await dirs.create();
    await writeFile(join(old.dir, "upload.docx"), "x");
    expect(await dirs.sweep(Date.now())).toBe(0); // nothing is old yet
    expect(await dirs.sweep(Date.now() + 20 * 60_000)).toBe(2); // 20 minutes later both are past retention
    expect(existsSync(old.dir) || existsSync(fresh.dir)).toBe(false);
    expect(await dirs.sweep()).toBe(0);
  });

  it("cleans a job's folder exactly once, and survives an already-missing folder", async () => {
    const dirs = new JobDirs(join(tempDir, "jobs"), 60_000);
    const job = await dirs.create();
    await writeFile(join(job.dir, "a"), "x");
    await job.cleanup();
    await job.cleanup();
    expect(existsSync(job.dir)).toBe(false);
    expect(await new JobDirs(join(tempDir, "never-created"), 1).sweep()).toBe(0);
  });

  it("clears leftover job folders from a previous run at start-up, and never touches anything else in a shared folder", async () => {
    const leftover = "3f9c1e52-8a4b-4d57-9b0e-5c2a7d1f6e43"; // the shape of a job folder name
    await mkdir(join(tempDir, leftover), { recursive: true });
    await writeFile(join(tempDir, leftover, "upload.docx"), "x");
    await mkdir(join(tempDir, "someone-elses-folder"), { recursive: true });
    await writeFile(join(tempDir, "someone-elses-file.txt"), "keep me");
    await start();
    expect(existsSync(join(tempDir, leftover))).toBe(false);
    expect(existsSync(join(tempDir, "someone-elses-folder"))).toBe(true);
    expect(await readFile(join(tempDir, "someone-elses-file.txt"), "utf8")).toBe("keep me");
  });

  it("the semaphore gives slots out in order and never exceeds its limit", async () => {
    const semaphore = new Semaphore(2, 3);
    const order: number[] = [];
    let concurrent = 0;
    let peak = 0;
    const job = async (n: number) => {
      const release = await semaphore.acquire();
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      order.push(n);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent -= 1;
      release();
      release(); // releasing twice must not free a second slot
    };
    await Promise.all([1, 2, 3, 4, 5].map(job));
    expect(peak).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect(semaphore.running).toBe(0);
    expect(semaphore.queued).toBe(0);
  });
});

describe("configuration", () => {
  it("has sensible defaults", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ port: 8787, host: "127.0.0.1", maxUploadBytes: 50 * 1024 * 1024, rateLimitPerMinute: 30, maxConcurrentJobs: 2, maxQueuedJobs: 8, retentionMinutes: 15, conversionTimeoutMs: 120_000, trustProxy: false, allowedOrigins: [] });
    expect(config.tempDir).toContain("lanternpdf-jobs");
  });

  it("reads the environment", () => {
    const config = loadConfig({ PORT: "9000", HOST: "0.0.0.0", MAX_UPLOAD_MB: "10", MAX_CONCURRENT_JOBS: "4", TRUST_PROXY: "1", ALLOWED_ORIGINS: "https://a.example, http://localhost:5173", CONVERSION_TIMEOUT_SECONDS: "30", SOFFICE_PATH: "/opt/lo/soffice" });
    expect(config).toMatchObject({ port: 9000, host: "0.0.0.0", maxUploadBytes: 10 * 1024 * 1024, maxConcurrentJobs: 4, maxQueuedJobs: 16, trustProxy: true, conversionTimeoutMs: 30_000, sofficePath: "/opt/lo/soffice" });
    expect(config.allowedOrigins).toEqual(["https://a.example", "http://localhost:5173"]);
  });

  it("reports every problem at once instead of starting half-configured", () => {
    try {
      loadConfig({ PORT: "abc", MAX_UPLOAD_MB: "0", ALLOWED_ORIGINS: "not a url,https://ok.example/path", MAX_CONCURRENT_JOBS: "2.5" });
      throw new Error("expected a ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const problems = (error as ConfigError).problems;
      expect(problems).toHaveLength(5);
      expect(problems.join("\n")).toMatch(/PORT.*abc/);
      expect(problems.join("\n")).toMatch(/MAX_UPLOAD_MB/);
      expect(problems.join("\n")).toMatch(/MAX_CONCURRENT_JOBS/);
      expect(problems.join("\n")).toMatch(/not a url/);
      expect(problems.join("\n")).toMatch(/https:\/\/ok\.example\/path/);
    }
  });
});

describe("file validation helpers", () => {
  it("classifies content, not names", async () => {
    const write = async (name: string, bytes: Uint8Array | Buffer) => {
      const path = join(tempDir, name);
      await writeFile(path, bytes);
      return path;
    };
    expect(await sniff(await write("a.bin", await pdf()))).toBe("pdf");
    expect(await sniff(await write("b.bin", docx()))).toBe("zip");
    expect(await sniff(await write("c.bin", ole()))).toBe("ole");
    expect(await sniff(await write("d.bin", Buffer.from("{\\rtf1\\ansi hello}")))).toBe("rtf");
    expect(await sniff(await write("e.bin", csv()))).toBe("text");
    expect(await sniff(await write("f.bin", Buffer.from([0, 1, 2, 3, 0, 0])))).toBe("unknown");
    expect(await sniff(await write("g.bin", Buffer.alloc(0)))).toBe("unknown");
  });

  it("reads extensions and makes names safe", () => {
    expect(extensionOf("Report.FINAL.DocX")).toBe(".docx");
    expect(extensionOf("noext")).toBe("");
    expect(safeName("..\\..\\win\\evil?.docx", "x")).toBe("evil_.docx");
    expect(safeName("../../etc/passwd", "x")).toBe("passwd");
    expect(safeName("", "fallback")).toBe("fallback");
    expect(safeName("..", "fallback")).toBe("fallback");
    expect(safeName("line\nbreak\u0000.pdf", "x")).toBe("line_break_.pdf");
  });
});
