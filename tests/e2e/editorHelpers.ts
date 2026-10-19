import type { Locator, Page } from "@playwright/test";
import { EngineSession } from "../../src/lib/pdf/engine/session";
import { fixtureBytes } from "../fixtures/build";
import { addFiles, expect } from "./fixtures";
import { type Downloaded, downloadFrom } from "./helpers";

/**
 * Helpers for the editor's end-to-end tests. Positions are given the way the editor's model has them: points from the
 * top-left corner of the page as first shown ("base space"), so a test can say "the triangle at (110, 180)" without caring
 * about zoom, scrolling or the editor's own rotation: the position is turned into a screen position through the page's SVG.
 */

export class Sheet {
  constructor(
    readonly page: Page,
    readonly number = 1,
  ) {}

  overlay(): Locator {
    return this.page.getByTestId(`page-${this.number}`).getByTestId("overlay");
  }

  /** Brings the page into view. */
  async reveal(): Promise<void> {
    await this.overlay().scrollIntoViewIfNeeded();
  }

  /** The screen position of a point of the page. */
  async at(x: number, y: number): Promise<{ x: number; y: number }> {
    return this.overlay().evaluate(
      (svg, [px, py]) => {
        const matrix = (svg as unknown as SVGSVGElement).getScreenCTM();
        if (!matrix) throw new Error("the page is not on the screen");
        const point = new DOMPoint(px as number, py as number).matrixTransform(matrix);
        return { x: point.x, y: point.y };
      },
      [x, y],
    );
  }

  async move(x: number, y: number): Promise<void> {
    const p = await this.at(x, y);
    await this.page.mouse.move(p.x, p.y);
  }

  async click(x: number, y: number, options: Parameters<Page["mouse"]["click"]>[2] = {}): Promise<void> {
    const p = await this.at(x, y);
    await this.page.mouse.click(p.x, p.y, options);
  }

  async doubleClick(x: number, y: number): Promise<void> {
    const p = await this.at(x, y);
    await this.page.mouse.dblclick(p.x, p.y);
  }

  async drag(from: [number, number], to: [number, number], steps = 8): Promise<void> {
    const a = await this.at(...from);
    const b = await this.at(...to);
    await this.page.mouse.move(a.x, a.y);
    await this.page.mouse.down();
    await this.page.mouse.move(b.x, b.y, { steps });
    await this.page.mouse.up();
  }

  /** Drags something by its handle (the centre of the element) to a point of the page. */
  async dragHandle(handle: Locator, to: [number, number], steps = 8): Promise<void> {
    const box = await handle.boundingBox();
    if (!box) throw new Error("the handle is not visible");
    const b = await this.at(...to);
    await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await this.page.mouse.down();
    await this.page.mouse.move(b.x, b.y, { steps });
    await this.page.mouse.up();
  }

  async stroke(points: [number, number][]): Promise<void> {
    const first = await this.at(...(points[0] as [number, number]));
    await this.page.mouse.move(first.x, first.y);
    await this.page.mouse.down();
    for (const point of points.slice(1)) {
      const p = await this.at(...point);
      await this.page.mouse.move(p.x, p.y, { steps: 4 });
    }
    await this.page.mouse.up();
  }
}

/** Opens the editor on a file and waits until its first page is on the screen. */
export async function openEditor(page: Page, bytes: Uint8Array, name = "doc.pdf"): Promise<Sheet> {
  await page.goto("/editor");
  await addFiles(page, [{ name, bytes }]);
  await expect(page.getByTestId("editor")).toBeVisible();
  const sheet = new Sheet(page);
  await expect(sheet.overlay()).toBeVisible();
  // The whole page on the screen, so every point of it can be reached with the pointer.
  await page.getByTestId("zoom-fit-page").click();
  await sheet.reveal();
  return sheet;
}

export const openFixture = (page: Page, name: string): Promise<Sheet> => openEditor(page, fixtureBytes(name), name);

/** Waits until the page has been read, so what it already draws can be picked. */
export async function waitForObjects(page: Page): Promise<void> {
  await expect(page.getByTestId("tool-hint")).toBeVisible();
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=overlay]").length > 0);
  // The analysis arrives a moment after the page is drawn; hovering something selectable shows an outline once it has.
  await page.waitForTimeout(600);
}

/** Opens a tool group's list (Shapes, Markup, Form fields) and picks a tool from it; plain tools are clicked directly. */
export async function chooseTool(page: Page, id: string): Promise<void> {
  const direct = page.getByTestId(`tool-${id}`);
  if (await direct.count()) {
    await direct.first().click();
    return;
  }
  const group = ["rect", "ellipse", "line", "arrow"].includes(id) ? "shapes" : ["highlight", "underline", "strikeout", "squiggly"].includes(id) ? "markup" : "forms";
  await page.getByTestId(`tool-group-${group}`).click();
  await page.getByTestId(`tool-${id}`).click();
}

export const panelTitle = (page: Page): Locator => page.locator(".ed-panel__head h2").first();

/** The position and size fields of the properties panel (size and turn are only there for things that have them). */
export async function geometry(page: Page): Promise<{ x: number; y: number; w: number; h: number; rot: number }> {
  const read = async (id: string, fallback = 0) => ((await page.getByTestId(id).count()) > 0 ? Number(await page.getByTestId(id).inputValue()) : fallback);
  return { x: await read("geo-x"), y: await read("geo-y"), w: await read("geo-w"), h: await read("geo-h"), rot: await read("geo-rot") };
}

/** Chooses "Download as…", gives the file a name and returns what was downloaded. */
export async function downloadAs(page: Page, name: string): Promise<Downloaded> {
  await page.getByTestId("download-as").click();
  await page.getByTestId("export-name").fill(name);
  const file = await downloadFrom(page, () => page.getByTestId("export-start").click());
  await expect(page.getByTestId("export-result")).toBeVisible();
  await page.getByTestId("export-done").click();
  return file;
}

/** What the page of a downloaded file draws, read with the same engine the editor uses. */
export async function analyze(bytes: Uint8Array, pageIndex = 0) {
  return (await EngineSession.open({ name: "result.pdf", bytes })).analyze(pageIndex);
}

/** Turns the snapping guides off (so a drag ends exactly where it was dropped). */
export async function snapOff(page: Page): Promise<void> {
  await page.getByTestId("more").click();
  await page.getByTestId("toggle-snap").click();
}
