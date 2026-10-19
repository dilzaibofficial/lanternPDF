import { PDFDocument } from "@cantoo/pdf-lib";
import { makeTextPdf, pageGeometry, pageTexts } from "../unit/helpers/pdf";
import { addFiles, expect, test } from "./fixtures";
import { downloadResult, expectThumbnailsDrawn, unzip } from "./helpers";

test.describe("Extract pages", () => {
  test("selecting thumbnails and typing ranges stay in sync", async ({ page }) => {
    await page.goto("/tools/extract-pages");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("X", 6) }]);
    const cards = page.getByTestId("page-card");
    await expect(cards).toHaveCount(6);
    await expectThumbnailsDrawn(page, ".page-card__thumb canvas", 6);

    await cards.nth(1).click();
    await cards.nth(3).click();
    await expect(page.getByLabel("Pages", { exact: true })).toHaveValue("2,4");
    await expect(page.getByTestId("selection-summary")).toContainText("2 pages will be saved in one new PDF");

    await page.getByLabel("Pages", { exact: true }).fill("1-3, 6");
    await expect(cards.nth(0)).toHaveAttribute("aria-pressed", "true");
    await expect(cards.nth(2)).toHaveAttribute("aria-pressed", "true");
    await expect(cards.nth(3)).toHaveAttribute("aria-pressed", "false");
    await expect(cards.nth(5)).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Invert" }).click();
    await expect(page.getByLabel("Pages", { exact: true })).toHaveValue("4-5");
    await page.getByRole("button", { name: "Odd" }).click();
    await expect(page.getByLabel("Pages", { exact: true })).toHaveValue("1,3,5");
    await page.getByRole("button", { name: "None" }).click();
    await expect(page.getByTestId("run-button")).toBeDisabled();
  });

  test("extracts the chosen pages into a new PDF", async ({ page }) => {
    await page.goto("/tools/extract-pages");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("X", 6) }]);
    await page.getByLabel("Pages", { exact: true }).fill("5, 2-3");
    await page.getByTestId("run-button").click();
    await expect(page.getByRole("heading", { name: "Your PDF is ready" })).toBeVisible();
    const file = await downloadResult(page);
    expect(file.name).toBe("doc_extracted.pdf");
    // pages keep their original order
    expect(await pageTexts(file.bytes)).toEqual(["X p2", "X p3", "X p5"]);
  });

  test("can save each page as its own PDF", async ({ page }) => {
    await page.goto("/tools/extract-pages");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("X", 5) }]);
    await page.getByLabel("Pages", { exact: true }).fill("1, 5");
    await page.getByLabel("Save each page as its own PDF").check();
    await page.getByTestId("run-button").click();
    const files = unzip((await downloadResult(page)).bytes);
    expect(Object.keys(files).sort()).toEqual(["doc_page-1.pdf", "doc_page-5.pdf"]);
    expect(await pageTexts(files["doc_page-5.pdf"] as Uint8Array)).toEqual(["X p5"]);
  });

  test("rejects out-of-range pages with a clear message", async ({ page }) => {
    await page.goto("/tools/extract-pages");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("X", 3) }]);
    await page.getByLabel("Pages", { exact: true }).fill("2, 9");
    await expect(page.getByRole("alert").filter({ hasText: "Page 9 is out of range" })).toBeVisible();
    await expect(page.getByTestId("run-button")).toBeDisabled();
  });
});

test.describe("Delete pages", () => {
  test("removes marked pages and keeps the rest", async ({ page }) => {
    await page.goto("/tools/delete-pages");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("Y", 5) }]);
    const cards = page.getByTestId("page-card");
    await cards.nth(1).click();
    await cards.nth(2).click();
    await expect(page.getByTestId("selection-summary")).toContainText("2 pages will be removed. 3 pages will remain.");
    await page.getByTestId("run-button").click();
    await expect(page.getByRole("heading", { name: "Your PDF is ready" })).toBeVisible();
    const file = await downloadResult(page);
    expect(file.name).toBe("doc_edited.pdf");
    expect(await pageTexts(file.bytes)).toEqual(["Y p1", "Y p4", "Y p5"]);
  });

  test("will not remove every page", async ({ page }) => {
    await page.goto("/tools/delete-pages");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("Y", 2) }]);
    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect(page.getByText("You cannot remove every page")).toBeVisible();
    await expect(page.getByTestId("run-button")).toBeDisabled();
  });
});

test.describe("Organize pages", () => {
  test("reorders, rotates, duplicates, inserts blanks and deletes, then saves exactly that", async ({ page }) => {
    await page.goto("/tools/organize");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("Z", 4) }]);
    const cards = page.getByTestId("page-card");
    await expect(cards).toHaveCount(4);
    await expectThumbnailsDrawn(page, ".page-card__thumb canvas", 4);
    await expect(page.getByTestId("run-button")).toBeDisabled(); // nothing changed yet

    // Move the last page to the front using the accessible buttons: 4 1 2 3
    await page.getByRole("button", { name: "Move Page 4 earlier" }).click();
    await page.getByRole("button", { name: "Move Page 3 earlier" }).click();
    await page.getByRole("button", { name: "Move Page 2 earlier" }).click();
    // Now: Z p4, Z p1, Z p2, Z p3. Rotate the first one right.
    await page.getByRole("button", { name: "Rotate Page 1 right" }).click();
    // Delete page 3 (Z p2), duplicate the first, add a blank page at the end.
    await page.getByRole("button", { name: "Delete Page 3" }).click();
    await page.getByRole("button", { name: "Duplicate Page 1" }).click();
    await page.getByRole("button", { name: "Blank page", exact: true }).click();

    // Z p4 (rot 90), Z p4 (rot 90), Z p1, Z p3, blank
    await expect(cards).toHaveCount(5);
    await expect(page.getByTestId("organize-summary")).toContainText("5 pages will be saved");

    await page.getByTestId("run-button").click();
    await expect(page.getByRole("heading", { name: "Your organized PDF is ready" })).toBeVisible();
    const file = await downloadResult(page);
    expect(file.name).toBe("doc_organized.pdf");
    expect(await pageTexts(file.bytes)).toEqual(["Z p4", "Z p4", "Z p1", "Z p3", ""]);
    const geometry = await pageGeometry(file.bytes);
    expect(geometry.map((g) => g.rotation)).toEqual([90, 90, 0, 0, 0]);
    expect(geometry[4]).toMatchObject({ width: 595, height: 842 }); // the blank page is A4
  });

  test("undo, redo and reset restore earlier states", async ({ page }) => {
    await page.goto("/tools/organize");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("Z", 3) }]);
    const count = page.getByTestId("page-count");
    await page.getByRole("button", { name: "Delete Page 2" }).click();
    await expect(count).toHaveText("2 pages");
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(count).toHaveText("3 pages");
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(count).toHaveText("2 pages");
    await page.getByRole("button", { name: "Reset" }).click();
    await expect(count).toHaveText("3 pages");
    await expect(page.getByTestId("run-button")).toBeDisabled();
  });

  test("drag and drop reorders pages", async ({ page }) => {
    await page.goto("/tools/organize");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("Z", 3) }]);
    const cards = page.getByTestId("page-card");
    await cards.nth(0).dragTo(cards.nth(2));
    await page.getByTestId("run-button").click();
    await expect(page.getByTestId("result-panel")).toBeVisible();
    const file = await downloadResult(page);
    expect(await pageTexts(file.bytes)).toEqual(["Z p2", "Z p3", "Z p1"]);
  });

  test("combines pages from several PDFs", async ({ page }) => {
    await page.goto("/tools/organize");
    await addFiles(page, [
      { name: "a.pdf", bytes: await makeTextPdf("A", 2) },
      { name: "b.pdf", bytes: await makeTextPdf("B", 2) },
    ]);
    const cards = page.getByTestId("page-card");
    await expect(cards).toHaveCount(4);
    await expect(cards.nth(0)).toHaveClass(/page-card--source-0/);
    await expect(cards.nth(2)).toHaveClass(/page-card--source-1/);
    await page.getByRole("button", { name: "Reverse order" }).click();
    await page.getByTestId("run-button").click();
    await expect(page.getByTestId("result-panel")).toBeVisible();
    const file = await downloadResult(page);
    expect(file.name).toBe("organized.pdf");
    expect(await pageTexts(file.bytes)).toEqual(["B p2", "B p1", "A p2", "A p1"]);
  });

  test("adds another PDF after the first", async ({ page }) => {
    await page.goto("/tools/organize");
    await addFiles(page, [{ name: "a.pdf", bytes: await makeTextPdf("A", 2) }]);
    await expect(page.getByTestId("page-card")).toHaveCount(2);
    await page.getByTestId("file-input-add").setInputFiles({ name: "b.pdf", mimeType: "application/pdf", buffer: Buffer.from(await makeTextPdf("B", 3)) });
    await expect(page.getByTestId("page-card")).toHaveCount(5);
    await page.getByRole("button", { name: "Delete Page 1" }).click();
    await page.getByTestId("run-button").click();
    const file = await downloadResult(page);
    expect(await pageTexts(file.bytes)).toEqual(["A p2", "B p1", "B p2", "B p3"]);
  });
});

test.describe("Rotate PDF", () => {
  test("rotates every page", async ({ page }) => {
    await page.goto("/tools/rotate");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("R", 3) }]);
    await expectThumbnailsDrawn(page, ".page-card__thumb canvas", 3);
    const firstThumb = page.locator(".page-card__thumb canvas").first();
    expect(await firstThumb.evaluate((canvas: HTMLCanvasElement) => canvas.width > canvas.height)).toBe(true); // landscape page
    await page.getByRole("button", { name: "Rotate all pages right" }).click();
    // the thumbnail itself turns: it is re-rendered as a portrait page
    await expect.poll(() => firstThumb.evaluate((canvas: HTMLCanvasElement) => canvas.height > canvas.width)).toBe(true);
    await page.getByTestId("run-button").click();
    await expect(page.getByRole("heading", { name: "Your rotated PDF is ready" })).toBeVisible();
    const file = await downloadResult(page);
    expect(file.name).toBe("doc_rotated.pdf");
    expect((await pageGeometry(file.bytes)).map((g) => g.rotation)).toEqual([90, 90, 90]);
    expect(await pageTexts(file.bytes)).toEqual(["R p1", "R p2", "R p3"]);
  });

  test("rotates single pages in either direction", async ({ page }) => {
    await page.goto("/tools/rotate");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("R", 3) }]);
    await page.getByRole("button", { name: "Rotate Page 2 right" }).click();
    await page.getByRole("button", { name: "Rotate Page 2 right" }).click();
    await page.getByRole("button", { name: "Rotate Page 3 left" }).click();
    await page.getByTestId("run-button").click();
    const file = await downloadResult(page);
    expect((await pageGeometry(file.bytes)).map((g) => g.rotation)).toEqual([0, 180, 270]);
  });

  test("keeps the original document properties", async ({ page }) => {
    const source = await PDFDocument.create();
    source.setTitle("Keep me");
    source.addPage([300, 200]);
    source.addPage([300, 200]);
    await page.goto("/tools/rotate");
    await addFiles(page, [{ name: "doc.pdf", bytes: await source.save() }]);
    await page.getByRole("button", { name: "Rotate all pages left" }).click();
    await page.getByTestId("run-button").click();
    const file = await downloadResult(page);
    expect((await PDFDocument.load(file.bytes)).getTitle()).toBe("Keep me");
  });
});
