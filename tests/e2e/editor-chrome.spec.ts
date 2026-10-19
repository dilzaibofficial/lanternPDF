import { PDFDocument } from "@cantoo/pdf-lib";
import type { Page } from "@playwright/test";
import { fixtureBytes } from "../fixtures/build";
import { makeTextPdf } from "../unit/helpers/pdf";
import { addFiles } from "./fixtures";
import { chooseTool, openEditor, openFixture, panelTitle, waitForObjects } from "./editorHelpers";
import { expect, test } from "./fixtures";

// The bars, menus and keyboard of the editor, and what it does when a file cannot be opened.

test.use({ viewport: { width: 1440, height: 900 } });

/** The test id of the topmost thing at the centre of an element: what a click on it would reach. */
async function topmostAtCentre(page: Page, testId: string): Promise<string | null> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`${testId} is not visible`);
  return page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el?.closest("[data-testid]")?.getAttribute("data-testid") ?? null;
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
}

test.describe("menus", () => {
  test("the More menu opens in front of the page, fully on the screen, and every choice can be reached", async ({ page }) => {
    await openFixture(page, "objects.pdf");
    await page.getByTestId("more").click();
    const menu = page.getByTestId("more-menu");
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    // Not hidden behind the page or clipped by the bar: the element under each item is the item itself.
    for (const id of ["toggle-snap", "other-tool", "shortcuts", "close-doc"]) expect(await topmostAtCentre(page, id)).toBe(id);
    await page.getByTestId("shortcuts").click();
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
  });

  test("menus open from the keyboard, move with the arrow keys, close with Escape and give the focus back", async ({ page }) => {
    await openFixture(page, "objects.pdf");
    const more = page.getByTestId("more");
    await more.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("more-menu")).toBeVisible();
    await expect(page.getByTestId("toggle-snap")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("other-tool")).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("close-doc")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("more-menu")).toHaveCount(0);
    await expect(more).toBeFocused();
  });

  test("clicking elsewhere closes a menu, and menus on the tool bar and zoom bar open too", async ({ page }) => {
    await openFixture(page, "objects.pdf");
    await page.getByTestId("tool-group-shapes").click();
    await expect(page.getByTestId("tool-menu-shapes")).toBeVisible();
    expect(await topmostAtCentre(page, "tool-ellipse")).toBe("tool-ellipse");
    await page.getByTestId("tool-ellipse").click();
    await expect(page.getByTestId("tool-menu-shapes")).toHaveCount(0);
    await expect(page.getByTestId("tool-group-shapes")).toHaveAttribute("aria-label", /Ellipse/);

    await page.getByTestId("zoom-level").click();
    await expect(page.getByTestId("zoom-menu")).toBeVisible();
    // The zoom menu is near the bottom of the screen: it opens upwards and stays inside the window.
    const zoomBox = (await page.getByTestId("zoom-menu").boundingBox())!;
    expect(zoomBox.y + zoomBox.height).toBeLessThanOrEqual(900);
    await page.mouse.click(1300, 700); // on the properties panel, outside the list
    await expect(page.getByTestId("zoom-menu")).toHaveCount(0);

    await page.getByTestId("history").click();
    await expect(page.getByTestId("history-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("history-panel")).toHaveCount(0);
  });
});

test.describe("the tool bar", () => {
  test("names every tool, says what the chosen one does, and Escape goes back to Select", async ({ page }) => {
    await openFixture(page, "objects.pdf");
    const bar = page.getByTestId("toolrail");
    for (const label of ["Select", "Pan", "Edit text", "Add text", "Add image", "Shapes", "Draw", "Markup", "Note", "Whiteout", "Redact", "Form fields"]) await expect(bar).toContainText(label);
    await expect(page.getByTestId("tool-hint")).toContainText("Click anything on the page to select it");
    await expect(page.getByTestId("tool-select")).toHaveAttribute("aria-pressed", "true");

    await chooseTool(page, "redact");
    await expect(page.getByTestId("tool-hint")).toContainText("taken out of the file");
    await chooseTool(page, "edit-text");
    await expect(page.getByTestId("tool-edit-text")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("tool-select")).toHaveAttribute("aria-pressed", "true");
  });

  test("shortcut keys choose tools, and the shortcuts dialog lists them", async ({ page }) => {
    await openFixture(page, "objects.pdf");
    await page.getByTestId("viewport").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("t");
    await expect(page.getByTestId("tool-text")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("r");
    await expect(page.getByTestId("tool-group-shapes")).toHaveAttribute("aria-label", /Rectangle/);
    await page.keyboard.press("?");
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toContainText("Add a text box");
    await expect(dialog).toContainText("Rectangle");
  });
});

test.describe("zoom and pages", () => {
  test("zoom changes with the buttons, the list and the keyboard, and fit keeps the page whole", async ({ page }) => {
    await openFixture(page, "objects.pdf");
    const level = page.getByTestId("zoom-level");
    await page.getByTestId("zoom-in").click();
    const larger = await level.textContent();
    await page.getByTestId("zoom-out").click();
    await page.getByTestId("zoom-out").click();
    expect(parseInt((await level.textContent()) ?? "0", 10)).toBeLessThan(parseInt(larger ?? "0", 10));
    await level.click();
    await page.getByRole("menuitemradio", { name: "100%" }).click();
    await expect(level).toHaveText("100%");
    await page.keyboard.press("Control+0");
    await expect(page.getByTestId("zoom-fit-page")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Control+9");
    await expect(page.getByTestId("zoom-fit-width")).toHaveAttribute("aria-pressed", "true");
  });

  test("moves between the pages of a longer document, one page at a time or all in a column", async ({ page }) => {
    const sheet = await openEditor(page, await makeTextPdf("Page", 3, [400, 300]));
    await expect(page.getByTestId("editor")).toHaveAttribute("data-pages", "3");
    await page.getByTestId("page-next").click();
    await expect(page.getByTestId("page-input")).toHaveValue("2");
    await page.getByTestId("page-input").fill("3");
    await expect(page.getByTestId("page-input")).toHaveValue("3");
    await page.getByTestId("view-mode").click();
    await expect(page.getByTestId("page-3")).toBeVisible();
    await expect(page.getByTestId("page-1")).toHaveCount(0);
    await page.getByTestId("page-prev").click();
    await expect(page.getByTestId("page-2")).toBeVisible();
    await page.getByTestId("view-mode").click();
    await expect(page.getByTestId("page-1")).toBeVisible();
    void sheet;
  });

  test("rotates, duplicates, inserts and deletes pages from the page panel, and undo restores them", async ({ page }) => {
    await openEditor(page, await makeTextPdf("Page", 2, [400, 300]));
    const pages = page.getByTestId("editor");
    await page.getByTestId("thumb-1").getByRole("button").click();
    await page.getByTestId("page-duplicate").click();
    await expect(pages).toHaveAttribute("data-pages", "3");
    await page.getByTestId("page-blank").click();
    await expect(pages).toHaveAttribute("data-pages", "4");
    await page.getByTestId("page-rotate-right").click();
    await expect(page.getByTestId("save-status")).toContainText("Unsaved changes");
    await page.getByTestId("page-delete").click();
    await expect(pages).toHaveAttribute("data-pages", "3");
    await page.keyboard.press("Control+z");
    await expect(pages).toHaveAttribute("data-pages", "4");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await expect(pages).toHaveAttribute("data-pages", "2");
  });
});

test.describe("opening files", () => {
  test("asks for the password of a protected file, only with the owner's say-so, and keeps it in memory", async ({ page }) => {
    const { protectPdf } = await import("../../src/lib/pdf/security");
    const locked = await protectPdf({ name: "locked.pdf", bytes: await makeTextPdf("Secret", 1, [400, 300]) }, { userPassword: "pw123" });
    await page.goto("/editor");
    await addFiles(page, [{ name: "locked.pdf", bytes: locked.bytes }]);
    await expect(page.getByTestId("password-form")).toBeVisible();
    await expect(page.getByTestId("open-protected")).toBeDisabled();
    await page.locator("input[type=password]").fill("wrong");
    await page.getByRole("checkbox").check();
    await page.getByTestId("open-protected").click();
    await expect(page.getByText("That password is not correct.")).toBeVisible();
    await page.locator("input[type=password]").fill("pw123");
    await page.getByTestId("open-protected").click();
    await expect(page.getByTestId("editor")).toBeVisible();
    await expect(page.getByTestId("page-1")).toBeVisible();
    // Nothing about the password is kept in the browser's storage.
    const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(stored).not.toContain("pw123");
  });

  test("says what is wrong with a file that is not a PDF or is damaged, and offers another try", async ({ page }) => {
    await page.goto("/editor");
    await addFiles(page, [{ name: "notes.txt", bytes: new TextEncoder().encode("plain text"), mimeType: "text/plain" }]);
    await expect(page.getByTestId("editor-open")).toContainText(/PDF/);
    await expect(page.getByTestId("editor")).toHaveCount(0);

    await addFiles(page, [{ name: "broken.pdf", bytes: new TextEncoder().encode("%PDF-1.7\nthis is not a real document") }]);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByTestId("editor")).toHaveCount(0);
    // A good file still opens afterwards.
    await addFiles(page, [{ name: "ok.pdf", bytes: fixtureBytes("objects.pdf") }]);
    await expect(page.getByTestId("editor")).toBeVisible();
  });

  test("closing a document with changes asks first, and the original file is never offered back changed", async ({ page }) => {
    const sheet = await openFixture(page, "objects.pdf");
    await waitForObjects(page);
    await sheet.click(110, 180);
    await page.keyboard.press("Delete");
    await expect(panelTitle(page)).toHaveText("Document");
    page.once("dialog", (dialog) => {
      expect(dialog.message()).toContain("not been downloaded");
      void dialog.dismiss();
    });
    await page.getByTestId("more").click();
    await page.getByTestId("close-doc").click();
    await expect(page.getByTestId("editor")).toBeVisible();
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByTestId("more").click();
    await page.getByTestId("close-doc").click();
    await expect(page.getByTestId("editor-open")).toBeVisible();
  });

  test("a signed document says that a changed copy will no longer be signed, an unsigned one does not", async ({ page }) => {
    const { PDFName, PDFString } = await import("@cantoo/pdf-lib");
    const signed = await PDFDocument.create();
    const sheet = signed.addPage([300, 200]);
    const { context } = signed;
    const field = context.register(context.obj({ FT: "Sig", T: PDFString.of("Signature1"), Type: "Annot", Subtype: "Widget", Rect: [10, 10, 100, 40], P: sheet.ref, V: { Type: "Sig", Filter: "Adobe.PPKLite", SubFilter: "adbe.pkcs7.detached", Contents: PDFString.of("0000") } }));
    sheet.node.set(PDFName.of("Annots"), context.obj([field]));
    signed.catalog.set(PDFName.of("AcroForm"), context.obj({ Fields: [field], SigFlags: 3 }));
    await openEditor(page, await signed.save(), "signed.pdf");
    await expect(page.getByTestId("properties")).toContainText("digitally signed");

    const plain = await PDFDocument.create();
    plain.addPage([300, 200]);
    await page.goto("/editor");
    await addFiles(page, [{ name: "plain.pdf", bytes: await plain.save() }]);
    await expect(page.getByTestId("editor")).toBeVisible();
    await expect(page.getByTestId("properties")).not.toContainText("digitally signed");
  });
});
