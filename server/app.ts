import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import cors from "cors";
import express, { type ErrorRequestHandler, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";
import type { OfficeTarget } from "../shared/api.js";
import type { ServerConfig } from "./config.js";
import { type CompressLevel, type ConversionInput, type Converters, createConverters } from "./converters.js";
import { type Engines, EngineRegistry } from "./engines.js";
import { HttpError, errorBody } from "./errors.js";
import { type Job, JobDirs, Semaphore } from "./jobs.js";
import { OFFICE_EXTENSIONS, extensionOf, officeProblem, pdfProblem, safeName } from "./validate.js";

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: unknown): void;
}

export const consoleLogger: Logger = {
  info: (message, meta) => console.log(JSON.stringify({ time: new Date().toISOString(), level: "info", message, ...meta })),
  error: (message, meta) => console.error(JSON.stringify({ time: new Date().toISOString(), level: "error", message, detail: meta instanceof Error ? meta.message : meta })),
};

export const silentLogger: Logger = { info: () => undefined, error: () => undefined };

export interface AppDeps {
  config: ServerConfig;
  engines: EngineRegistry;
  logger?: Logger;
  /** Replaceable in tests; by default conversions run the detected LibreOffice and Ghostscript. */
  converters?: (engines: Engines) => Converters;
}

export interface App {
  app: express.Express;
  jobs: JobDirs;
  semaphore: Semaphore;
  /** Stops the background sweeper. */
  close(): void;
}

const CSP = {
  "default-src": ["'self'"],
  // WebAssembly (the PDF engine) needs 'wasm-unsafe-eval'; no script may be inline or from elsewhere.
  "script-src": ["'self'", "'wasm-unsafe-eval'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "blob:"],
  "font-src": ["'self'"],
  "connect-src": ["'self'"],
  "worker-src": ["'self'", "blob:"],
  "manifest-src": ["'self'"],
  "object-src": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'none'"],
};

const MB = 1024 * 1024;
const COMPRESS_LEVELS: readonly CompressLevel[] = ["screen", "ebook", "printer"];
const OFFICE_TARGETS: readonly OfficeTarget[] = ["docx", "pptx"];

/** Express 5 forwards rejected promises itself, but this keeps handlers explicit about what they return. */
const handler = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler => (req, res, next) => {
  fn(req, res).catch(next);
};

const jobOf = (res: Response): Job => res.locals.job as Job;

export function createApp(deps: AppDeps): App {
  const { config, engines } = deps;
  const logger = deps.logger ?? silentLogger;
  const jobs = new JobDirs(config.tempDir, config.retentionMinutes * 60_000);
  const semaphore = new Semaphore(config.maxConcurrentJobs, config.maxQueuedJobs);
  const makeConverters =
    deps.converters ??
    ((found: Engines) =>
      createConverters({ libreoffice: found.libreoffice.command, ghostscript: found.ghostscript.command, timeoutMs: config.conversionTimeoutMs, log: (message, detail) => logger.error(message, detail) }));

  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);

  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: CSP },
      referrerPolicy: { policy: "no-referrer" },
      crossOriginOpenerPolicy: { policy: "same-origin" },
      crossOriginResourcePolicy: { policy: "same-origin" },
    }),
  );

  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      if (req.path.startsWith("/api/")) logger.info("request", { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started, bytes: Number(res.getHeader("content-length") ?? 0) });
    });
    next();
  });

  // ---- API --------------------------------------------------------------------------------
  if (config.allowedOrigins.length > 0) app.use("/api", cors({ origin: config.allowedOrigins, methods: ["GET", "POST"], maxAge: 600 }));
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get(
    "/api/capabilities",
    handler(async (_req, res) => {
      res.json(await engines.capabilities(config));
    }),
  );

  const limiter = rateLimit({
    windowMs: 60_000,
    limit: config.rateLimitPerMinute,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json(errorBody("RATE_LIMITED", "Too many requests. Please wait a minute and try again."));
    },
  });

  /** Gives the request a private folder that is removed when the response ends, however it ends. */
  const beginJob: RequestHandler = (_req, res, next) => {
    jobs
      .create()
      .then((job) => {
        res.locals.job = job;
        res.once("close", () => void job.cleanup().catch((error: unknown) => logger.error("could not remove a job folder", error)));
        next();
      })
      .catch(next);
  };

  const uploader = (allows: (extension: string) => boolean, accepted: string) =>
    multer({
      storage: multer.diskStorage({
        destination: (req, _file, cb) => cb(null, jobOf(req.res as Response).dir),
        // The stored name never comes from the client: only a validated extension does.
        filename: (_req, file, cb) => cb(null, `upload${extensionOf(file.originalname)}`),
      }),
      limits: { fileSize: config.maxUploadBytes, files: 1, fields: 4, fieldSize: 256, parts: 6 },
      defParamCharset: "utf8",
      fileFilter: (_req, file, cb) => {
        if (file.fieldname !== "file" || !allows(extensionOf(file.originalname))) {
          cb(new HttpError(400, "INVALID_FILE", `This type of file is not accepted here. Accepted: ${accepted}.`));
          return;
        }
        cb(null, true);
      },
    }).single("file");

  const officeUpload = uploader((extension) => OFFICE_EXTENSIONS.includes(extension), OFFICE_EXTENSIONS.join(", "));
  const pdfUpload = uploader((extension) => extension === ".pdf", ".pdf");

  /** The uploaded file, checked against its own content. */
  async function receive(req: Request, res: Response, problemWith: (path: string, extension: string) => Promise<string | null>): Promise<ConversionInput & { originalName: string }> {
    const file = req.file;
    if (!file) throw new HttpError(400, "INVALID_FILE", "No file was uploaded. Send it as the form field “file”.");
    const extension = extensionOf(file.originalname);
    const problem = await problemWith(file.path, extension);
    if (problem) throw new HttpError(400, "INVALID_FILE", problem);
    return { jobDir: jobOf(res).dir, inputPath: file.path, extension, originalName: safeName(file.originalname, "document") };
  }

  /** Waits for a free conversion slot, runs `work`, and always gives the slot back. */
  async function withSlot<T>(work: () => Promise<T>): Promise<T> {
    const release = await semaphore.acquire();
    try {
      return await work();
    } finally {
      release();
    }
  }

  async function send(res: Response, path: string, downloadName: string, mime: string): Promise<void> {
    res.type(mime);
    res.attachment(downloadName);
    await new Promise<void>((resolve, reject) => {
      res.sendFile(path, { dotfiles: "allow", acceptRanges: false, cacheControl: false }, (error) => (error ? reject(error) : resolve()));
    });
  }

  const stem = (name: string) => basename(name, extensionOf(name));

  app.post(
    "/api/convert/office-to-pdf",
    limiter,
    beginJob,
    officeUpload,
    handler(async (req, res) => {
      const input = await receive(req, res, officeProblem);
      const found = await engines.get();
      if (!found.libreoffice.command) throw new HttpError(503, "ENGINE_UNAVAILABLE", `Converting Office documents needs LibreOffice on the server. ${found.libreoffice.status.reason ?? ""}`.trim());
      const output = await withSlot(() => makeConverters(found).officeToPdf(input));
      await send(res, output, `${stem(input.originalName)}.pdf`, "application/pdf");
    }),
  );

  app.post(
    "/api/convert/pdf-to-office",
    limiter,
    beginJob,
    pdfUpload,
    handler(async (req, res) => {
      const target = String((req.body as { target?: unknown } | undefined)?.target ?? "");
      if (!OFFICE_TARGETS.includes(target as OfficeTarget)) throw new HttpError(400, "INVALID_INPUT", `Choose a target: ${OFFICE_TARGETS.join(" or ")}.`);
      const input = await receive(req, res, (path) => pdfProblem(path));
      const found = await engines.get();
      if (!found.libreoffice.command) throw new HttpError(503, "ENGINE_UNAVAILABLE", `Layout-preserving conversion needs LibreOffice on the server. ${found.libreoffice.status.reason ?? ""}`.trim());
      const output = await withSlot(() => makeConverters(found).pdfToOffice(input, target as OfficeTarget));
      const mime = target === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
      await send(res, output, `${stem(input.originalName)}.${target}`, mime);
    }),
  );

  app.post(
    "/api/compress",
    limiter,
    beginJob,
    pdfUpload,
    handler(async (req, res) => {
      const level = String((req.body as { level?: unknown } | undefined)?.level ?? "ebook");
      if (!COMPRESS_LEVELS.includes(level as CompressLevel)) throw new HttpError(400, "INVALID_INPUT", `Choose a level: ${COMPRESS_LEVELS.join(", ")}.`);
      const input = await receive(req, res, (path) => pdfProblem(path));
      const found = await engines.get();
      if (!found.ghostscript.command) throw new HttpError(503, "ENGINE_UNAVAILABLE", `Stronger compression needs Ghostscript on the server. ${found.ghostscript.status.reason ?? ""}`.trim());
      const output = await withSlot(() => makeConverters(found).compress(input, level as CompressLevel));
      await send(res, output, `${stem(input.originalName)}_compressed.pdf`, "application/pdf");
    }),
  );

  app.use("/api", (_req, res) => {
    res.status(404).json(errorBody("NOT_FOUND", "There is no such API route."));
  });

  // ---- The web app ---------------------------------------------------------------------------
  const indexFile = join(config.staticDir, "index.html");
  if (existsSync(indexFile)) {
    app.use(
      express.static(config.staticDir, {
        index: false,
        setHeaders: (res, path) => {
          // Built assets carry a content hash in their name, so they can be cached for good; the page itself must not be.
          res.setHeader("Cache-Control", /[\\/]assets[\\/]/.test(path) ? "public, max-age=31536000, immutable" : "no-cache");
        },
      }),
    );
    // Client-side routes (/tools/merge, /about ...) all get the app shell.
    app.get("/{*splat}", (_req, res) => {
      res.set("Cache-Control", "no-cache").sendFile(indexFile);
    });
  } else {
    app.get("/", (_req, res) => {
      res.type("text/plain").send("The LanternPDF API is running, but the web app has not been built. Run “npm run build”, or use “npm run dev” for development.\n");
    });
  }

  // ---- Errors --------------------------------------------------------------------------------
  const onError: ErrorRequestHandler = (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.status).json(errorBody(error.code, error.message));
      return;
    }
    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        res.status(413).json(errorBody("FILE_TOO_LARGE", `This file is larger than the server's limit of ${Math.round(config.maxUploadBytes / MB)} MB.`));
      } else {
        res.status(400).json(errorBody("INVALID_FILE", "The upload could not be read. Send exactly one file as the form field “file”."));
      }
      return;
    }
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).json(errorBody("INVALID_INPUT", "The request could not be understood."));
      return;
    }
    // Anything else is a bug or a broken server: log the detail here, tell the person only that it failed.
    logger.error("unexpected error", error);
    res.status(500).json(errorBody("INTERNAL", "Something went wrong on the server. Nothing was returned."));
  };
  app.use(onError);

  return { app, jobs, semaphore, close: () => jobs.stop() };
}

export { EngineRegistry };
