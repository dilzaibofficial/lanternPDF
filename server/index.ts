import type { Server } from "node:http";
import { createApp, consoleLogger } from "./app.js";
import { ConfigError, type ServerConfig, loadConfig } from "./config.js";
import { EngineRegistry, detectGhostscript, detectLibreOffice } from "./engines.js";

export interface RunningServer {
  server: Server;
  url: string;
  engines: EngineRegistry;
  stop(): Promise<void>;
}

/** Starts the server: the web app, the API, and the housekeeping that keeps uploaded documents from lingering. */
export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const engines = new EngineRegistry({ libreoffice: () => detectLibreOffice(config), ghostscript: () => detectGhostscript(config) });
  const { app, jobs, close } = createApp({ config, engines, logger: consoleLogger });

  // Anything left behind by an earlier crash goes first, then a periodic sweep.
  const removed = await jobs.sweep(Number.POSITIVE_INFINITY);
  if (removed > 0) consoleLogger.info("removed leftover job folders", { count: removed });
  jobs.start();

  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(config.port, config.host, () => resolve(listening));
    listening.once("error", reject);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  const url = `http://${config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host}:${port}`;

  return {
    server,
    url,
    engines,
    stop: () =>
      new Promise<void>((resolve) => {
        close();
        server.close(() => resolve());
        server.closeIdleConnections();
      }),
  };
}

async function main(): Promise<void> {
  let config: ServerConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const running = await startServer(config);
  const capabilities = await running.engines.capabilities(config);
  console.log(`LanternPDF ${config.version} is running at ${running.url}`);
  console.log(`  Upload limit: ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB, ${config.maxConcurrentJobs} concurrent conversion(s)`);
  for (const [name, status] of Object.entries(capabilities.engines)) {
    console.log(`  ${name}: ${status.available ? `available${status.version ? ` (${status.version})` : ""}` : `not available. ${status.reason ?? ""}`}`);
  }
  console.log("  All other tools run in the browser and need none of this.");

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down.`);
    void running.stop().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

// Run only when started directly (`node dist-server/server/index.js`, `tsx server/index.ts`), not when imported by tests.
const entry = process.argv[1] ?? "";
if (/[\\/]server[\\/]index\.(?:ts|js)$/.test(entry)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
