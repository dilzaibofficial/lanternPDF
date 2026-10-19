import type { Page } from "@playwright/test";
import { TOOLS } from "../../src/config/tools";
import { jpegPage, photoJpeg } from "../unit/helpers/pdfImages";
import { makeTextPdf, pageTexts } from "../unit/helpers/pdf";
import { addFiles, expect, test } from "./fixtures";
import { downloadResult } from "./helpers";

/**
 * Layout checks at phone, tablet and laptop widths. They run in the desktop project at explicit sizes and in
 * the mobile project (an emulated Pixel 7 with touch), where the same pages must work with the same rules:
 * nothing may force the page to scroll sideways, and everything needs to stay reachable.
 */
const SIZES = [
  { name: "small phone", width: 360, height: 740 },
  { name: "phone", width: 412, height: 915 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1280, height: 800 },
] as const;

const PAGES = ["/", "/tools", ...TOOLS.map((tool) => `/tools/${tool.id}`), "/about", "/privacy", "/self-hosting", "/does-not-exist"];

/** Names the elements poking out of the right edge, so a failure says what to fix. */
async function overflowReport(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const limit = window.innerWidth;
    if (document.documentElement.scrollWidth <= limit + 1) return null;
    const offenders: string[] = [];
    for (const element of document.querySelectorAll("body *")) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.right <= limit + 1) continue;
      if (element.closest(".table-scroll, .editor__pages, .mobile-nav, [hidden]")) continue; // scrolls on its own
      const id = element.id ? `#${element.id}` : "";
      const classes = typeof element.className === "string" && element.className ? `.${element.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
      offenders.push(`${element.tagName.toLowerCase()}${id}${classes} (right edge ${Math.round(box.right)}px)`);
      if (offenders.length === 6) break;
    }
    return `the page is ${document.documentElement.scrollWidth}px wide in a ${limit}px window: ${offenders.join("; ")}`;
  });
}

async function expectFits(page: Page, label: string) {
  expect(await overflowReport(page), `${label} overflows sideways`).toBeNull();
}

for (const size of SIZES) {
  test.describe(`at ${size.name} width (${size.width}px)`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test("every page fits the screen without scrolling sideways", async ({ page }) => {
      for (const path of PAGES) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expectFits(page, path);
      }
    });

    test("tool pages with a document loaded still fit, and the main button can be reached", async ({ page }) => {
      const pdf = await makeTextPdf("Fit", 3, [400, 300]);
      const withButton: [string, string][] = [
        ["merge", "merge-button"],
        ["split", "split-button"],
        ["compress", "compress-button"],
        ["watermark", "run-button"],
        ["page-numbers", "run-button"],
        ["crop", "run-button"],
        ["protect", "run-button"],
      ];
      for (const [id, button] of withButton) {
        await page.goto(`/tools/${id}`);
        await addFiles(page, [{ name: "doc.pdf", bytes: pdf }]);
        const target = page.getByTestId(button);
        await expect(target, `${id}: the main button`).toBeVisible();
        await target.scrollIntoViewIfNeeded();
        const box = await target.boundingBox();
        expect(box, id).not.toBeNull();
        expect((box?.x ?? 0) + (box?.width ?? 0), `${id}: the main button is inside the screen`).toBeLessThanOrEqual(size.width + 1);
        expect(box?.x ?? -1, id).toBeGreaterThanOrEqual(-1);
        await expectFits(page, `/tools/${id} with a file`);
      }
    });

    test("the editor, the organizer and the results fit too", async ({ page }) => {
      await page.goto("/editor");
      await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("Fit", 2, [400, 300]) }]);
      await expect(page.getByTestId("page-1").getByTestId("overlay")).toBeVisible();
      await expectFits(page, "the editor");
      const layer = await page.getByTestId("page-1").getByTestId("overlay").boundingBox();
      expect((layer?.width ?? 0) + (layer?.x ?? 0), "the page in the editor is scaled to the screen").toBeLessThanOrEqual(size.width + 1);
      // The tool bar, the zoom bar and the download button are all reachable without leaving the screen.
      for (const id of ["toolbar", "viewbar", "download-as"]) {
        const box = await page.getByTestId(id).boundingBox();
        expect(box, id).not.toBeNull();
        expect((box?.x ?? 0) + (box?.width ?? 0), `${id} is inside the screen`).toBeLessThanOrEqual(size.width + 1);
      }

      await page.goto("/tools/organize");
      await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("Fit", 6, [400, 300]) }]);
      await expect(page.getByTestId("page-grid").getByRole("listitem")).toHaveCount(6);
      await expectFits(page, "the organizer");

      await page.goto("/tools/compress");
      await addFiles(page, [{ name: "scan.pdf", bytes: await jpegPage(photoJpeg(1200, 900), 400, 300, "Fit") }]);
      await page.getByTestId("compress-button").click();
      await expect(page.getByTestId("result-panel")).toBeVisible();
      await expectFits(page, "the compression result");
      const file = await downloadResult(page);
      expect(await pageTexts(file.bytes)).toEqual(["Fit"]);
    });
  });
}

test.describe("on a phone", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 1280) > 700, "phone layout only");

  test("the menu replaces the navigation bar and reaches every tool", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
    const toggle = page.getByRole("button", { name: "Open menu" });
    await expect(toggle).toBeVisible();
    await toggle.click();
    const menu = page.getByRole("navigation", { name: "All tools" });
    await expect(menu.getByRole("link")).toHaveCount(TOOLS.length);
    await menu.getByRole("link", { name: "Merge PDF" }).click();
    await expect(page).toHaveURL(/\/tools\/merge$/);
    await expect(menu).toBeHidden(); // the menu closes when you go somewhere
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Merge PDF");
  });

  test("buttons and links are big enough to tap", async ({ page }) => {
    await page.goto("/");
    const small = await page.evaluate(() => {
      const tooSmall: string[] = [];
      for (const element of document.querySelectorAll<HTMLElement>("header a, header button, main a, main button, footer a, footer button")) {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        if (element.matches("a") && element.closest("p")) continue; // a link inside a sentence is exempt (WCAG 2.5.8): its size is the text's
        if (box.height < 36 && !element.closest(".sr-only")) tooSmall.push(`${element.tagName.toLowerCase()} “${(element.textContent || element.getAttribute("aria-label") || "").trim().slice(0, 30)}” is ${Math.round(box.width)}x${Math.round(box.height)}px`);
      }
      return tooSmall;
    });
    expect(small, "controls shorter than 36px").toEqual([]);
  });

  test("text fields are large enough that phones do not zoom the page when they are focused", async ({ page }) => {
    await page.goto("/tools/watermark");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("Fit", 1, [400, 300]) }]);
    const sizes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("input:not([type=range]):not([type=color]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select")].map((field) => Number.parseFloat(getComputedStyle(field).fontSize)));
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(16);
  });

  test("merging works with the move buttons instead of dragging", async ({ page }) => {
    await page.goto("/tools/merge");
    await addFiles(page, [
      { name: "a.pdf", bytes: await makeTextPdf("A", 1) },
      { name: "b.pdf", bytes: await makeTextPdf("B", 1) },
    ]);
    await page.getByRole("button", { name: "Move b.pdf up" }).tap();
    await page.getByTestId("merge-button").tap();
    await expect(page.getByRole("heading", { name: "Your merged PDF is ready" })).toBeVisible();
    expect(await pageTexts((await downloadResult(page)).bytes)).toEqual(["B p1", "A p1"]);
  });

  test("the editor opens with the page in view and its side panels closed, and drawing works", async ({ page }) => {
    await page.goto("/editor");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("Fit", 1, [400, 300]) }]);
    const layer = page.getByTestId("page-1").getByTestId("overlay");
    await expect(layer).toBeVisible();
    await expect(page.getByTestId("sidebar")).toHaveCount(0);
    await expect(page.getByTestId("properties")).toHaveCount(0);
    // The tool bar scrolls sideways; the shapes list opens in front of the page and every item can be reached.
    await page.getByTestId("tool-group-shapes").tap();
    await expect(page.getByTestId("tool-rect")).toBeVisible();
    const item = (await page.getByTestId("tool-rect").boundingBox()) as { x: number; width: number };
    expect(item.x + item.width).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
    await page.getByTestId("tool-rect").tap();
    await layer.scrollIntoViewIfNeeded();
    const box = (await layer.boundingBox()) as { x: number; y: number; width: number; height: number };
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 6 });
    await page.mouse.up();
    await expect(page.getByTestId("save-status")).toContainText("Unsaved changes");
    // The panels open on request, over the page, and close again.
    await page.getByTestId("toggle-panel").tap();
    await expect(page.getByTestId("properties")).toBeVisible();
    await page.getByTestId("toggle-panel").tap();
    await expect(page.getByTestId("properties")).toHaveCount(0);
  });

  test("the More menu on a phone opens in front of the page and stays on the screen", async ({ page }) => {
    await page.goto("/editor");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("Fit", 1, [400, 300]) }]);
    await expect(page.getByTestId("page-1").getByTestId("overlay")).toBeVisible();
    await page.getByTestId("more").tap();
    const menu = (await page.getByTestId("more-menu").boundingBox()) as { x: number; y: number; width: number; height: number };
    const viewport = page.viewportSize() as { width: number; height: number };
    expect(menu.x).toBeGreaterThanOrEqual(0);
    expect(menu.x + menu.width).toBeLessThanOrEqual(viewport.width);
    expect(menu.y + menu.height).toBeLessThanOrEqual(viewport.height);
    await expect(page.getByTestId("shortcuts")).toBeVisible();
  });
});

test.describe("colour themes", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`pages fit and stay readable in ${scheme} mode`, async ({ browser }) => {
      const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 412, height: 915 } });
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const text = await page.evaluate(() => getComputedStyle(document.body).color);
      const luminance = (css: string) => {
        const [r = 0, g = 0, b = 0] = (css.match(/\d+/g) ?? []).map(Number);
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      };
      if (scheme === "dark") expect(luminance(background)).toBeLessThan(luminance(text));
      else expect(luminance(background)).toBeGreaterThan(luminance(text));
      await expectFits(page, `/ in ${scheme} mode`);
      await context.close();
    });
  }
});
