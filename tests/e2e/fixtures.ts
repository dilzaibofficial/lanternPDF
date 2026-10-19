import { createRequire } from "node:module";
import { type Page, expect, test as base } from "@playwright/test";
import { setQpdfWasmLocator } from "../../src/lib/pdf/qpdf";

// The Node side of the tests uses the same engine to build fixtures (encrypted files, damaged files).
const require = createRequire(import.meta.url);
setQpdfWasmLocator(() => require.resolve("@neslinesli93/qpdf-wasm/dist/qpdf.wasm"));

/** Messages that are expected and harmless. Everything else fails the test. */
const IGNORED_CONSOLE = [/ECONNREFUSED/i, /Download the React DevTools/i];

/**
 * The browser logs every failed request as "Failed to load resource" without saying which one in the text
 * (the address is in the message's location). Failures of the optional API are expected in tests that
 * simulate a missing or failing server; failures of anything else are bugs.
 */
const isApiFailure = (text: string, url: string) => /Failed to load resource/i.test(text) && /\/api\//.test(url);

export const test = base.extend<{ problems: string[] }>({
  problems: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const text = message.text();
        if (IGNORED_CONSOLE.some((pattern) => pattern.test(text)) || isApiFailure(text, message.location().url)) return;
        problems.push(`console.error: ${text}`);
      });
      await use(problems);
      expect(problems, "the page reported errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Adds files through the tool's hidden file input, exactly as a user's file picker would. */
export async function addFiles(page: Page, files: { name: string; bytes: Uint8Array; mimeType?: string }[]): Promise<void> {
  await page.getByTestId("file-input").first().setInputFiles(
    files.map((file) => ({ name: file.name, mimeType: file.mimeType ?? "application/pdf", buffer: Buffer.from(file.bytes) })),
  );
}
