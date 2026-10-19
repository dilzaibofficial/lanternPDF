import { makeTextPdf, pageTexts } from "../unit/helpers/pdf";
import { addFiles, expect, test } from "./fixtures";
import { downloadResult, expectThumbnailsDrawn, unzip } from "./helpers";

test.describe("Split PDF", () => {
  test("splits by page ranges into separate files", async ({ page }) => {
    await page.goto("/tools/split");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("D", 6) }]);
    await expect(page.getByTestId("page-card")).toHaveCount(6);
    await expectThumbnailsDrawn(page, ".page-card__thumb canvas", 6);

    await page.getByRole("textbox", { name: "Page ranges" }).fill("1-2, 4, 5-6");
    await expect(page.getByTestId("split-summary")).toContainText("3 files will be created");
    await page.getByTestId("split-button").click();

    await expect(page.getByRole("heading", { name: "Your 3 PDFs are ready" })).toBeVisible();
    await expect(page.getByLabel("Result files").getByRole("listitem")).toHaveCount(4); // 3 files + total row

    const zip = await downloadResult(page);
    expect(zip.name).toBe("doc_split.zip");
    const files = unzip(zip.bytes);
    expect(Object.keys(files).sort()).toEqual(["doc_page-4.pdf", "doc_pages-1-2.pdf", "doc_pages-5-6.pdf"]);
    expect(await pageTexts(files["doc_pages-1-2.pdf"] as Uint8Array)).toEqual(["D p1", "D p2"]);
    expect(await pageTexts(files["doc_page-4.pdf"] as Uint8Array)).toEqual(["D p4"]);
    expect(await pageTexts(files["doc_pages-5-6.pdf"] as Uint8Array)).toEqual(["D p5", "D p6"]);
  });

  test("can merge the ranges into one PDF", async ({ page }) => {
    await page.goto("/tools/split");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("D", 6) }]);
    await page.getByRole("textbox", { name: "Page ranges" }).fill("1-2, 6");
    await page.getByLabel("Merge all ranges into one PDF").check();
    await expect(page.getByTestId("split-summary")).toContainText("1 file will be created");
    await page.getByTestId("split-button").click();
    await expect(page.getByTestId("result-panel")).toBeVisible();
    const file = await downloadResult(page);
    expect(file.name).toBe("doc_extracted.pdf");
    expect(await pageTexts(file.bytes)).toEqual(["D p1", "D p2", "D p6"]);
  });

  test("splits every N pages", async ({ page }) => {
    await page.goto("/tools/split");
    await addFiles(page, [{ name: "ten.pdf", bytes: await makeTextPdf("T", 10) }]);
    await page.getByRole("radio", { name: "Every N pages" }).check();
    await page.getByLabel("Pages per file").fill("4");
    await expect(page.getByTestId("split-summary")).toContainText("3 files will be created");
    await page.getByTestId("split-button").click();
    await expect(page.getByTestId("result-panel")).toBeVisible();
    const files = unzip((await downloadResult(page)).bytes);
    expect(Object.keys(files).sort()).toEqual(["ten_pages-1-4.pdf", "ten_pages-5-8.pdf", "ten_pages-9-10.pdf"]);
    expect(await pageTexts(files["ten_pages-9-10.pdf"] as Uint8Array)).toEqual(["T p9", "T p10"]);
  });

  test("splits into single pages", async ({ page }) => {
    await page.goto("/tools/split");
    await addFiles(page, [{ name: "tri.pdf", bytes: await makeTextPdf("S", 3) }]);
    await page.getByRole("radio", { name: "Every page" }).check();
    await expect(page.getByTestId("split-summary")).toContainText("3 files will be created");
    await page.getByTestId("split-button").click();
    const files = unzip((await downloadResult(page)).bytes);
    expect(Object.keys(files).sort()).toEqual(["tri_page-1.pdf", "tri_page-2.pdf", "tri_page-3.pdf"]);
  });

  test("explains invalid input and keeps the button disabled", async ({ page }) => {
    await page.goto("/tools/split");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("D", 4) }]);
    const button = page.getByTestId("split-button");
    await expect(button).toBeDisabled();

    await page.getByRole("textbox", { name: "Page ranges" }).fill("1-9");
    await expect(page.getByRole("alert").filter({ hasText: "out of range" })).toBeVisible();
    await expect(button).toBeDisabled();

    await page.getByRole("textbox", { name: "Page ranges" }).fill("3-1");
    await expect(page.getByRole("alert").filter({ hasText: "backwards" })).toBeVisible();

    await page.getByRole("textbox", { name: "Page ranges" }).fill("abc");
    await expect(page.getByRole("alert").filter({ hasText: "not a valid page range" })).toBeVisible();

    await page.getByRole("textbox", { name: "Page ranges" }).fill("1-2");
    await expect(button).toBeEnabled();

    await page.getByRole("radio", { name: "Every N pages" }).check();
    await page.getByLabel("Pages per file").fill("4");
    await expect(page.getByRole("alert").filter({ hasText: "one file" })).toBeVisible();
    await expect(button).toBeDisabled();
  });

  test("a one-page PDF has nothing to split", async ({ page }) => {
    await page.goto("/tools/split");
    await addFiles(page, [{ name: "one.pdf", bytes: await makeTextPdf("O", 1) }]);
    await expect(page.getByText("only one page")).toBeVisible();
    await expect(page.getByTestId("split-button")).toHaveCount(0);
  });

  test("colour-codes the pages that belong together", async ({ page }) => {
    await page.goto("/tools/split");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("D", 4) }]);
    await page.getByRole("textbox", { name: "Page ranges" }).fill("1-2, 3-4");
    const cards = page.getByTestId("page-card");
    await expect(cards.nth(0)).toHaveClass(/page-card--source-0/);
    await expect(cards.nth(2)).toHaveClass(/page-card--source-1/);
  });
});
