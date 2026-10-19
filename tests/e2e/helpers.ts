import { readFileSync } from "node:fs";
import type { Download, Locator, Page } from "@playwright/test";
import { unzipSync } from "fflate";

export interface Downloaded {
  name: string;
  bytes: Uint8Array;
}

/** Clicks `trigger` and returns what the browser downloaded. */
export async function downloadFrom(page: Page, trigger: () => Promise<void>): Promise<Downloaded> {
  const [download] = await Promise.all([page.waitForEvent("download"), trigger()]);
  return readDownload(download);
}

export async function readDownload(download: Download): Promise<Downloaded> {
  return { name: download.suggestedFilename(), bytes: new Uint8Array(readFileSync(await download.path())) };
}

/** Files inside a downloaded ZIP, by name. */
export function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

/**
 * Asserts that page thumbnails are really drawn, not just present: every canvas must have been resized
 * by the renderer (an untouched canvas stays at the browser default of 300x150) and contain visible
 * pixels. Returns how many canvases were checked.
 */
export async function expectThumbnailsDrawn(page: Page, selector: string, expected: number): Promise<void> {
  await page.waitForFunction(
    ({ selector: css, expected: count }) => {
      const canvases = [...document.querySelectorAll<HTMLCanvasElement>(css)];
      if (canvases.length !== count) return false;
      return canvases.every((canvas) => {
        if (canvas.width === 300 && canvas.height === 150) return false; // never rendered
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return false;
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 3; i < data.length; i += 4 * 97) if (data[i] !== 0) return true; // any non-transparent pixel
        return false;
      });
    },
    { selector, expected },
    { timeout: 20_000 },
  );
}

/**
 * Moves a range slider to `value`. React tracks an input's value itself, so assigning `.value` directly would not
 * reach its onChange handler; the native setter followed by an input event does, as a real drag would.
 */
export async function setRange(slider: Locator, value: number): Promise<void> {
  await slider.evaluate((input: HTMLInputElement, next: number) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, String(next));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

/** Downloads the main result button's file. */
export function downloadResult(page: Page): Promise<Downloaded> {
  return downloadFrom(page, () => page.getByTestId("download-all").click());
}
