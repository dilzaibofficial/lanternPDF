import { formatBytes } from "../../src/lib/format";
import { protectPdf } from "../../src/lib/pdf/security";
import { renderPdfPage, withExifOrientation } from "../unit/helpers/images";
import { makeTextPdf, pageGeometry, pageTexts } from "../unit/helpers/pdf";
import { imageObjects, jpegPage, meanAbsDiff, photoJpeg } from "../unit/helpers/pdfImages";
import { addFiles, expect, test } from "./fixtures";
import { downloadResult, unzip } from "./helpers";

/** A scan-like page: a large photograph at about 288 dpi, plus a line of real text on top. */
const scan = (seed = 1, label = "Quarterly scan") => jpegPage(photoJpeg(1600, 1200, seed), 400, 300, label);

/** Nothing here can be recompressed: the JPEG has an EXIF rotation tag, so it is deliberately left alone. */
const untouchable = () => jpegPage(withExifOrientation(photoJpeg(1200, 900, 5), 6), 400, 300);

test.describe("Compress PDF", () => {
  test("shrinks a photo-heavy PDF at the recommended level and shows the real sizes", async ({ page }) => {
    const original = await scan();
    await page.goto("/tools/compress");
    await addFiles(page, [{ name: "scan.pdf", bytes: original }]);

    await expect(page.getByTestId("compress-summary")).toContainText("1 file");
    await expect(page.getByTestId("level-balanced")).toBeChecked(); // the recommended level is the default
    await page.getByTestId("compress-button").click();

    await expect(page.getByRole("heading", { name: "Your compressed PDF is ready" })).toBeVisible();
    const file = await downloadResult(page);
    expect(file.name).toBe("scan_compressed.pdf");
    expect(file.bytes.length).toBeLessThan(original.length * 0.5);

    // The table states the actual numbers of the file that was produced.
    const row = page.getByTestId("savings-row");
    await expect(row).toContainText("scan.pdf");
    await expect(row).toContainText(formatBytes(original.length));
    await expect(row).toContainText(formatBytes(file.bytes.length));
    await expect(row).toContainText("% smaller");
    await expect(page.getByTestId("result-stats")).toContainText("Saved");

    // What changed: the image is now 150 dpi (400 pt -> 833 px); what did not: the text, and how the page looks.
    const [image] = await imageObjects(file.bytes);
    expect(image?.width).toBe(833);
    expect(image?.filter).toBe("/DCTDecode");
    expect(await pageTexts(file.bytes)).toEqual(["Quarterly scan"]);
    expect(meanAbsDiff(await renderPdfPage(original, 1, 1), await renderPdfPage(file.bytes, 1, 1))).toBeLessThan(8);
  });

  test("the strong level goes further than the recommended one", async ({ page }) => {
    const original = await scan(3);
    const sizes: Record<string, number> = {};
    for (const level of ["balanced", "strong"] as const) {
      await page.goto("/tools/compress");
      await addFiles(page, [{ name: "scan.pdf", bytes: original }]);
      await page.getByTestId(`level-${level}`).check();
      await page.getByTestId("compress-button").click();
      await expect(page.getByRole("heading", { name: "Your compressed PDF is ready" })).toBeVisible();
      sizes[level] = (await downloadResult(page)).bytes.length;
    }
    expect(sizes.strong).toBeLessThan(sizes.balanced as number);
  });

  test("compresses several files at once, downloads only those that got smaller, and says so", async ({ page }) => {
    await page.goto("/tools/compress");
    await addFiles(page, [
      { name: "a.pdf", bytes: await scan(1, "A") },
      { name: "b.pdf", bytes: await scan(2, "B") },
      { name: "c.pdf", bytes: await untouchable() },
    ]);
    await expect(page.getByTestId("compress-summary")).toContainText("3 files");
    await expect(page.getByTestId("compress-button")).toContainText("Compress 3 PDFs");
    await page.getByTestId("compress-button").click();

    await expect(page.getByRole("heading", { name: "2 compressed PDFs are ready" })).toBeVisible();
    const rows = page.getByTestId("savings-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: "a.pdf" })).toContainText("% smaller");
    await expect(rows.filter({ hasText: "b.pdf" })).toContainText("% smaller");
    await expect(rows.filter({ hasText: "c.pdf" })).toContainText("No reduction");
    await expect(page.getByText("Files that could not be made smaller are not included in the download")).toBeVisible();

    const zip = await downloadResult(page);
    expect(zip.name).toBe("compressed-pdfs.zip");
    expect(Object.keys(unzip(zip.bytes)).sort()).toEqual(["a_compressed.pdf", "b_compressed.pdf"]);
  });

  test("when nothing can be made smaller it says so plainly and offers a stronger level", async ({ page }) => {
    const original = await untouchable();
    await page.goto("/tools/compress");
    await addFiles(page, [{ name: "stuck.pdf", bytes: original }]);
    await page.getByTestId("level-lossless").check();
    await page.getByTestId("compress-button").click();

    await expect(page.getByTestId("no-reduction")).toHaveText("This PDF could not be made smaller");
    await expect(page.getByTestId("download-all")).toHaveCount(0); // there is nothing to download
    await expect(page.getByTestId("savings-row")).toContainText("No reduction");
    await expect(page.getByText("your originals are untouched")).toBeVisible();

    await page.getByRole("button", { name: "Try the recommended level" }).click();
    await expect(page.getByTestId("level-balanced")).toBeChecked();
    await expect(page.getByTestId("compress-button")).toBeEnabled(); // the file is still loaded
  });

  test("converting pages to pictures needs a confirmation, and really flattens the text", async ({ page }) => {
    const original = await scan(4, "Selectable text");
    await page.goto("/tools/compress");
    await addFiles(page, [{ name: "flat.pdf", bytes: original }]);

    await page.getByTestId("level-pictures").check();
    await expect(page.getByText("This changes what the PDF is")).toBeVisible();
    await expect(page.getByTestId("compress-button")).toBeDisabled();
    await page.getByLabel(/I understand that text, links and form fields will be flattened/).check();
    await expect(page.getByTestId("compress-button")).toBeEnabled();
    await page.getByTestId("compress-button").click();

    await expect(page.getByRole("heading", { name: "Your compressed PDF is ready" })).toBeVisible();
    const file = await downloadResult(page);
    expect(file.bytes.length).toBeLessThan(original.length);
    expect(await pageTexts(file.bytes)).toEqual([""]); // no text layer is left
    expect(await pageGeometry(file.bytes)).toEqual([{ width: 400, height: 300, rotation: 0 }]); // same page size
    expect((await imageObjects(file.bytes)).length).toBe(1);
    await expect(page.getByTestId("savings-row")).toContainText("converted to pictures");
  });

  test("opens a password-protected PDF with its password and writes an unprotected copy", async ({ page }) => {
    const locked = await protectPdf({ name: "locked.pdf", bytes: await scan(6, "Secret") }, { userPassword: "open-sesame" });
    await page.goto("/tools/compress");
    await addFiles(page, [{ name: "locked.pdf", bytes: locked.bytes }]);

    const row = page.getByTestId("file-row").filter({ hasText: "locked.pdf" });
    await expect(row).toContainText("Password required");
    await expect(page.getByTestId("compress-button")).toBeDisabled();
    await row.getByLabel("Password", { exact: true }).fill("open-sesame");
    await row.getByRole("button", { name: "Open file" }).click();
    await expect(row).toContainText("1 page");
    await expect(page.getByText("The compressed copy is not protected")).toBeVisible();

    await page.getByTestId("compress-button").click();
    await expect(page.getByText("The compressed copies are not password-protected")).toBeVisible();
    const file = await downloadResult(page);
    expect(await pageTexts(file.bytes)).toEqual(["Secret"]); // opens with no password
    expect(file.bytes.length).toBeLessThan(locked.bytes.length);
  });

  test("the level choices are a keyboard-operable radio group", async ({ page }) => {
    await page.goto("/tools/compress");
    await addFiles(page, [{ name: "t.pdf", bytes: await makeTextPdf("T", 1) }]);
    const group = page.getByRole("radiogroup", { name: "Compression level" });
    await expect(group.getByRole("radio")).toHaveCount(5); // four on-device levels, plus Ghostscript because the test server has it
    await page.getByTestId("level-balanced").focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("level-strong")).toBeChecked();
    await expect(page.getByTestId("level-strong")).toBeFocused();
  });

  test("can be cancelled while it works, and the files stay loaded", async ({ page }) => {
    // Many large pages keep the job busy long enough to press Cancel.
    const { PDFDocument } = await import("@cantoo/pdf-lib");
    const doc = await PDFDocument.create();
    const jpeg = await doc.embedJpg(photoJpeg(2400, 1800, 9));
    for (let i = 0; i < 12; i += 1) doc.addPage([400, 300]).drawImage(jpeg, { x: 0, y: 0, width: 400, height: 300 });
    // distinct images, so duplicates are not simply merged away
    for (let i = 0; i < 4; i += 1) doc.addPage([400, 300]).drawImage(await doc.embedJpg(photoJpeg(2400, 1800, 20 + i)), { x: 0, y: 0, width: 400, height: 300 });
    await page.goto("/tools/compress");
    await addFiles(page, [{ name: "big.pdf", bytes: await doc.save() }]);
    await page.getByTestId("compress-button").click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("compress-button")).toBeEnabled();
    await expect(page.getByTestId("file-row")).toHaveCount(1);
  });
});
