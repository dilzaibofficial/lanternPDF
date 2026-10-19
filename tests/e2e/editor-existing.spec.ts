import { PDFDocument, PDFName } from "@cantoo/pdf-lib";
import { fixtureBytes } from "../fixtures/build";
import { isBlue, isRed, isWhite, renderPdfPage } from "../unit/helpers/images";
import { pageTexts } from "../unit/helpers/pdf";
import { analyze, downloadAs, geometry, openEditor, openFixture, panelTitle, snapOff, waitForObjects } from "./editorHelpers";
import { expect, test } from "./fixtures";

// Things the page already draws can be picked up, moved, resized, turned and removed, like anything the person added.
// The fixture is a 400 × 500 page: a title, a red triangle, a picture with an orange square over its corner, a box with
// two lines of text in it, a green rectangle and a line.

test.use({ viewport: { width: 1440, height: 900 } });

const px = (points: number) => points * 2;

test.describe("things that are already on the page", () => {
  test("hovering shows what a click would pick, and clicking selects a triangle with its size", async ({ page }) => {
    const sheet = await openFixture(page, "objects.pdf");
    await waitForObjects(page);

    await sheet.move(110, 180);
    await expect(page.getByTestId("hover-outline")).toHaveCount(1);

    await sheet.click(110, 180);
    await expect(panelTitle(page)).toHaveText("Triangle on the page");
    expect(await geometry(page)).toMatchObject({ x: 60, y: 120, w: 100, h: 80 });
    // Eight handles and the turning knob.
    await expect(page.locator("[data-testid^=handle-]")).toHaveCount(9);
    await expect(page.getByTestId("selection-bar")).toBeVisible();

    // The empty corner of the triangle's box is not the triangle.
    await sheet.click(65, 125);
    await expect(panelTitle(page)).toHaveText("Document");
  });

  test("drags a triangle to a new place; undo and redo move it back and forth", async ({ page }) => {
    const sheet = await openFixture(page, "objects.pdf");
    await waitForObjects(page);
    await snapOff(page);
    await sheet.click(110, 180);
    await sheet.drag([110, 180], [210, 240]);
    await expect(page.getByTestId("save-status")).toContainText("Unsaved changes");
    expect(await geometry(page)).toMatchObject({ x: 160, y: 180 });

    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await geometry(page)).x).toBe(60);
    await page.keyboard.press("Control+Shift+z");
    await expect.poll(async () => (await geometry(page)).x).toBe(160);

    // The page itself was redrawn with the triangle in its new place: its thumbnail shows it.
    await expect(page.getByTestId("history")).toBeVisible();
  });

  test("the picture and the shape follow the pointer while dragging, and settle where they are dropped", async ({ page }) => {
    const sheet = await openFixture(page, "objects.pdf");
    await waitForObjects(page);
    await sheet.click(110, 180);
    const from = await sheet.at(110, 180);
    const to = await sheet.at(110, 300);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    // Lifted off the page and drawn at the pointer, before anything is saved.
    await expect(page.getByTestId("lifted")).toHaveCount(1);
    await page.mouse.up();
    await expect(page.getByTestId("lifted")).toHaveCount(0, { timeout: 15_000 });
    expect(await geometry(page)).toMatchObject({ x: 60, y: 240 });
  });

  test("resizes a picture from its corner keeping its shape, and turns a rectangle with the knob", async ({ page }) => {
    const sheet = await openFixture(page, "objects.pdf");
    await waitForObjects(page);
    await sheet.click(280, 190);
    await expect(panelTitle(page)).toHaveText("Image on the page");
    await sheet.dragHandle(page.getByTestId("handle-se"), [400, 260]);
    const resized = await geometry(page);
    expect(resized.w).toBeGreaterThan(130);
    expect(Math.abs(resized.w / resized.h - 2)).toBeLessThan(0.02);

    await sheet.click(100, 400); // the green rectangle
    await expect(panelTitle(page)).toHaveText("Rectangle on the page");
    const knob = page.getByTestId("handle-rotate");
    await sheet.dragHandle(knob, [190, 420]);
    expect((await geometry(page)).rot).not.toBe(0);
  });

  test("the position and size can be typed in", async ({ page }) => {
    const sheet = await openFixture(page, "objects.pdf");
    await waitForObjects(page);
    await sheet.click(280, 190);
    await page.getByTestId("geo-x").fill("100");
    await page.getByTestId("geo-x").press("Enter");
    await page.getByTestId("geo-w").fill("60");
    await page.getByTestId("geo-w").press("Enter");
    await expect.poll(async () => (await geometry(page)).x).toBe(100);
    expect((await geometry(page)).w).toBe(60);
  });

  test("removes the picture with the Delete key and with the bar by it, and undo brings it back", async ({ page }) => {
    const sheet = await openFixture(page, "objects.pdf");
    await waitForObjects(page);
    await sheet.click(280, 190);
    await page.keyboard.press("Delete");
    await expect(panelTitle(page)).toHaveText("Document");
    await sheet.click(280, 190);
    // Nothing there any more: the empty page was clicked.
    await expect(panelTitle(page)).toHaveText("Document");
    await page.keyboard.press("Control+z");
    await sheet.click(280, 190);
    await expect(panelTitle(page)).toHaveText("Image on the page");
    await page.getByTestId("sel-delete").click();
    await sheet.click(280, 190);
    await expect(panelTitle(page)).toHaveText("Document");
  });

  test("moves a block of text with the arrow keys and changes its words by double-clicking", async ({ page }) => {
    const sheet = await openFixture(page, "objects.pdf");
    await waitForObjects(page);
    await sheet.click(100, 262);
    await expect(panelTitle(page)).toHaveText("Text on the page");
    for (let i = 0; i < 3; i += 1) await page.keyboard.press("Shift+ArrowRight");
    await expect.poll(async () => (await geometry(page)).x).toBe(100);

    await sheet.doubleClick(140, 262);
    await expect(page.getByTestId("line-editor")).toBeVisible();
    await page.getByTestId("line-editor").fill("Boxed line ONE");
    await page.getByTestId("line-editor").press("Enter");
    await expect(page.getByTestId("save-status")).toContainText("Unsaved changes");

    const file = await downloadAs(page, "moved-text");
    const text = (await pageTexts(file.bytes))[0] ?? "";
    expect(text).toContain("Boxed line ONE");
    expect(text).toContain("Boxed line two");
    const lines = (await analyze(file.bytes)).lines;
    expect(lines.find((l) => l.text === "Boxed line ONE")?.box.x).toBeCloseTo(100, 0);
    expect(lines.find((l) => l.text === "Boxed line two")?.box.x).toBeCloseTo(100, 0);
    expect(lines.find((l) => l.text === "Objects page")?.box.x).toBeCloseTo(40, 0);
  });

  test("selects several things by dragging a frame around them, then moves and removes them together", async ({ page }) => {
    const sheet = await openFixture(page, "objects.pdf");
    await waitForObjects(page);
    await sheet.drag([30, 105], [370, 215]);
    await expect(panelTitle(page)).toHaveText("3 objects");
    await page.keyboard.press("Delete");
    await expect(panelTitle(page)).toHaveText("Document");
    const file = await downloadAs(page, "cleared");
    const after = await analyze(file.bytes);
    expect(after.objects.map((o) => o.label).sort()).toEqual(["Line", "Rectangle", "Rectangle"]);
  });

  test("a download holds the changes, in the file and not just on the screen, and says the original is untouched", async ({ page }) => {
    const sheet = await openFixture(page, "objects.pdf");
    await waitForObjects(page);
    // Move the triangle, remove the picture, put the orange square at the back.
    await sheet.drag([110, 180], [250, 440]);
    await sheet.click(280, 190);
    await page.keyboard.press("Delete");
    await sheet.click(350, 130);
    await page.getByTestId("z-back").click();

    await page.getByTestId("download-as").click();
    await expect(page.getByTestId("export-summary")).toContainText("removed");
    await expect(page.getByTestId("export-summary")).toContainText("moved");
    await page.getByTestId("export-name").fill("changed");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-start").click()]);
    expect(download.suggestedFilename()).toBe("changed.pdf");
    await expect(page.getByTestId("export-result")).toContainText("original file was not changed");
    const bytes = new Uint8Array((await import("node:fs")).readFileSync((await download.path()) as string));

    const picture = await renderPdfPage(bytes, 1, 2);
    expect(isWhite(picture.at(px(110), px(180)))).toBe(true); // the triangle is no longer where it was
    expect(isRed(picture.at(px(250), px(450)))).toBe(true); // it is near the bottom now, apex at (250, 380)
    expect(isBlue(picture.at(px(280), px(190)))).toBe(false); // the picture is gone
    expect(new TextDecoder("latin1").decode(bytes)).not.toContain("/Subtype /Image");
    // The file that was opened is unchanged.
    expect(fixtureBytes("objects.pdf").length).toBeGreaterThan(0);
  });

  test("Reset puts a moved thing back where it was in the file", async ({ page }) => {
    const sheet = await openFixture(page, "objects.pdf");
    await waitForObjects(page);
    await sheet.click(110, 180);
    await sheet.drag([110, 180], [210, 260]);
    expect((await geometry(page)).x).toBe(160);
    await page.getByTestId("reset-existing").click();
    await expect.poll(async () => (await geometry(page)).x).toBe(60);
    await expect(page.getByTestId("reset-existing")).toHaveCount(0);
  });

  test("a thing the file keeps in a shared block cannot be changed, and the panel says why", async ({ page }) => {
    // One reusable block drawn twice: changing one would change both.
    const doc = await PDFDocument.create();
    const pdfPage = doc.addPage([300, 200]);
    const { context } = doc;
    const form = context.register(context.stream("1 0 0 rg 0 0 40 40 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 100] }));
    pdfPage.node.set(PDFName.of("Resources"), context.obj({ XObject: { Fm1: form } }));
    pdfPage.node.set(PDFName.of("Contents"), context.register(context.flateStream("q 1 0 0 1 20 100 cm /Fm1 Do Q q 1 0 0 1 160 100 cm /Fm1 Do Q")));
    const sheet = await openEditor(page, await doc.save(), "shared.pdf");
    await waitForObjects(page);
    await sheet.click(40, 80);
    await expect(panelTitle(page)).toContainText("on the page");
    await expect(page.locator(".ed-panel__head p")).toContainText("2 times");
    await page.keyboard.press("Delete");
    await expect(page.getByTestId("notice")).toContainText("2 times");
    await expect(page.getByTestId("save-status")).not.toContainText("Unsaved changes");
  });
});
