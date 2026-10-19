import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 4173);
const API_PORT = Number(process.env.E2E_API_PORT ?? 8787);

/**
 * End-to-end tests run against the production build served by `vite preview`, in the system's Microsoft
 * Edge (`channel: "msedge"`), so no browser download is needed. Set E2E_CHANNEL=chrome to use Chrome,
 * or E2E_CHANNEL= (empty) to use Playwright's bundled Chromium after `npx playwright install chromium`.
 *
 * The optional server runs too, with test doubles standing in for LibreOffice and Ghostscript (neither is
 * needed to run the tests; see tests/fixtures). `vite preview` proxies /api to it, as it would in development.
 */
const channel = process.env.E2E_CHANNEL === undefined ? "msedge" : process.env.E2E_CHANNEL || undefined;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel,
    acceptDownloads: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel, viewport: { width: 1280, height: 900 } } },
    { name: "mobile", testMatch: /responsive\.spec\.ts/, use: { ...devices["Pixel 7"], channel } },
  ],
  webServer: [
    {
      command: `npm run build:web && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
      url: `http://127.0.0.1:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
      env: { VITE_API_TARGET: `http://127.0.0.1:${API_PORT}` },
    },
    {
      command: "npx tsx server/index.ts",
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        PORT: String(API_PORT),
        HOST: "127.0.0.1",
        SOFFICE_PATH: resolve("tests/fixtures/fake-soffice.mjs"),
        GHOSTSCRIPT_PATH: resolve("tests/fixtures/fake-gs.mjs"),
        MAX_UPLOAD_MB: "2",
        RATE_LIMIT_PER_MINUTE: "5000",
        TEMP_DIR: resolve("tests/.tmp/jobs"),
        CONVERSION_TIMEOUT_SECONDS: "30",
      },
    },
  ],
});
