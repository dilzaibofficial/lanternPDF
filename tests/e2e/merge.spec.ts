import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { protectPdf } from "../../src/lib/pdf/security";
import { makeTextPdf, pageTexts } from "../unit/helpers/pdf";
import { addFiles, expect, test } from "./fixtures";
import { expectThumbnailsDrawn } from "./helpers";

/** Drops files onto an element with a real DataTransfer, as dragging from the desktop would. */
async function dropFiles(page: Page, target: Locator, files: { name: string; bytes: Uint8Array; type?: string }[]): Promise<void> {
  const payload = files.map((file) => ({ name: file.name, type: file.type ?? "application/pdf", data: Array.from(file.bytes) }));
  const dataTransfer = await page.evaluateHandle((items) => {
    const transfer = new DataTransfer();
    for (const item of items) transfer.items.add(new File([new Uint8Array(item.data)], item.name, { type: item.type }));
    return transfer;
  }, payload);
  await target.dispatchEvent("dragenter", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
}

async function downloadResult(page: Page): Promise<{ name: string; bytes: Uint8Array }> {
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("download-all").click()]);
  return { name: download.suggestedFilename(), bytes: new Uint8Array(readFileSync(await download.path())) };
}

test.describe("Merge PDF", () => {
  test("merges PDFs in the chosen order and the download matches", async ({ page }) => {
    await page.goto("/tools/merge");
    const a = await makeTextPdf("A", 2);
    const b = await makeTextPdf("B", 3);
    await addFiles(page, [
      { name: "a.pdf", bytes: a },
      { name: "b.pdf", bytes: b },
    ]);

    const rows = page.getByTestId("file-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("2 pages");
    await expect(rows.nth(1)).toContainText("3 pages");
    await expect(page.getByTestId("merge-summary")).toContainText("2 files · 5 pages");
    await expectThumbnailsDrawn(page, ".file-row__thumb canvas", 2); // first-page thumbnails are really painted

    // Move a.pdf below b.pdf with the keyboard-accessible button.
    await page.getByRole("button", { name: "Move a.pdf down" }).click();
    await expect(rows.nth(0)).toContainText("b.pdf");
    await expect(page.getByText("Moved a.pdf to position 2 of 2.")).toBeAttached();

    await page.getByTestId("merge-button").click();
    await expect(page.getByTestId("result-panel")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your merged PDF is ready" })).toBeFocused();
    await expect(page.getByTestId("result-stats")).toContainText("5");

    // The preview really renders the merged document.
    await expect(page.getByTestId("viewer-canvas")).toBeVisible();

    const file = await downloadResult(page);
    expect(file.name).toBe("merged.pdf");
    expect(await pageTexts(file.bytes)).toEqual(["B p1", "B p2", "B p3", "A p1", "A p2"]);
  });

  test("needs two files, and says so", async ({ page }) => {
    await page.goto("/tools/merge");
    await addFiles(page, [{ name: "only.pdf", bytes: await makeTextPdf("O", 1) }]);
    await expect(page.getByTestId("file-row")).toHaveCount(1);
    await expect(page.getByText("Add at least two PDFs to merge.")).toBeVisible();
    await expect(page.getByTestId("merge-button")).toBeDisabled();
  });

  test("accepts files dropped onto the page", async ({ page }) => {
    await page.goto("/tools/merge");
    await dropFiles(page, page.getByTestId("dropzone"), [
      { name: "dropped1.pdf", bytes: await makeTextPdf("D1", 1) },
      { name: "dropped2.pdf", bytes: await makeTextPdf("D2", 2) },
    ]);
    await expect(page.getByTestId("file-row")).toHaveCount(2);
    await expect(page.getByTestId("merge-summary")).toContainText("3 pages");
  });

  test("refuses files that are not PDFs, with a reason", async ({ page }) => {
    await page.goto("/tools/merge");
    await addFiles(page, [{ name: "notes.txt", bytes: new TextEncoder().encode("hello"), mimeType: "text/plain" }]);
    await expect(page.getByTestId("rejections")).toContainText("notes.txt");
    await expect(page.getByTestId("rejections")).toContainText("not a supported file");

    // A PNG renamed to .pdf passes the extension check but not the content check.
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await addFiles(page, [{ name: "fake.pdf", bytes: png }]);
    const row = page.getByTestId("file-row").first();
    await expect(row).toContainText("not really a PDF document");
    await expect(row).toContainText("PNG image");
  });

  test("asks for a password, rejects a wrong one and accepts the right one", async ({ page }) => {
    await page.goto("/tools/merge");
    const plain = await makeTextPdf("P", 1);
    const locked = await protectPdf({ name: "secret.pdf", bytes: await makeTextPdf("S", 2) }, { userPassword: "open-sesame" });
    await addFiles(page, [
      { name: "plain.pdf", bytes: plain },
      { name: "secret.pdf", bytes: locked.bytes },
    ]);

    const secretRow = page.getByTestId("file-row").filter({ hasText: "secret.pdf" });
    await expect(secretRow).toContainText("Password required");
    await expect(page.getByTestId("merge-button")).toBeDisabled();

    await secretRow.getByLabel("Password", { exact: true }).fill("wrong");
    await secretRow.getByRole("button", { name: "Open file" }).click();
    await expect(secretRow).toContainText("Incorrect password");

    await secretRow.getByLabel("Password", { exact: true }).fill("open-sesame");
    await secretRow.getByRole("button", { name: "Open file" }).click();
    await expect(secretRow).toContainText("2 pages");
    await expect(page.getByTestId("merge-button")).toBeEnabled();

    await page.getByTestId("merge-button").click();
    await expect(page.getByText("The merged PDF is not password-protected")).toBeVisible();
    const file = await downloadResult(page);
    expect(await pageTexts(file.bytes)).toEqual(["P p1", "S p1", "S p2"]);
  });

  test("offers to repair a damaged PDF and then merges it", async ({ page }) => {
    await page.goto("/tools/merge");
    const good = await makeTextPdf("G", 1);
    const whole = await makeTextPdf("R", 2);
    const text = Buffer.from(whole).toString("latin1");
    const damaged = whole.slice(0, text.lastIndexOf("startxref"));

    await addFiles(page, [
      { name: "good.pdf", bytes: good },
      { name: "damaged.pdf", bytes: damaged },
    ]);
    // Track the row by position: a repaired file is renamed "<name>_repaired.pdf".
    const damagedRow = page.getByTestId("file-row").nth(1);
    await expect(damagedRow).toContainText("damaged.pdf");
    await expect(damagedRow).toContainText("could not be read");
    await expect(page.getByTestId("merge-button")).toBeDisabled();

    await damagedRow.getByRole("button", { name: "Try to repair this file" }).click();
    await expect(damagedRow).toContainText("damaged_repaired.pdf");
    await expect(damagedRow).toContainText("2 pages");
    await expect(page.getByTestId("merge-button")).toBeEnabled();

    await page.getByTestId("merge-button").click();
    const file = await downloadResult(page);
    expect(await pageTexts(file.bytes)).toEqual(["G p1", "R p1", "R p2"]);
  });

  test("start over clears the files and shows the drop zone again", async ({ page }) => {
    await page.goto("/tools/merge");
    await addFiles(page, [
      { name: "a.pdf", bytes: await makeTextPdf("A", 1) },
      { name: "b.pdf", bytes: await makeTextPdf("B", 1) },
    ]);
    await page.getByTestId("merge-button").click();
    await expect(page.getByTestId("result-panel")).toBeVisible();
    await page.getByRole("button", { name: "Start over" }).click();
    await expect(page.getByTestId("dropzone")).toBeVisible();
    await expect(page.getByTestId("file-row")).toHaveCount(0);
  });

  test("removing a file updates the summary", async ({ page }) => {
    await page.goto("/tools/merge");
    await addFiles(page, [
      { name: "a.pdf", bytes: await makeTextPdf("A", 2) },
      { name: "b.pdf", bytes: await makeTextPdf("B", 3) },
      { name: "c.pdf", bytes: await makeTextPdf("C", 4) },
    ]);
    await expect(page.getByTestId("merge-summary")).toContainText("9 pages");
    await page.getByRole("button", { name: "Remove b.pdf" }).click();
    await expect(page.getByTestId("merge-summary")).toContainText("2 files · 6 pages");
  });
});
