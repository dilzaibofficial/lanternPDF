import { PDFDocument, degrees } from "@cantoo/pdf-lib";
import { readMetadata } from "../../src/lib/pdf/metadata";
import { inkBounds, isWhite, makeImage, renderPdfPage } from "../unit/helpers/images";
import { makeColorPdf, makeTextPdf, pageGeometry, pageTexts } from "../unit/helpers/pdf";
import { addFiles, expect, test } from "./fixtures";
import { downloadResult, setRange } from "./helpers";

test.describe("Add page numbers", () => {
  test("shows a live preview and numbers the pages as configured", async ({ page }) => {
    await page.goto("/tools/page-numbers");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("D", 4, [400, 300]) }]);

    const preview = page.getByTestId("preview-canvas");
    await expect(preview).toBeVisible();
    await page.getByTestId("format").fill("Page {n} of {total}");
    await page.getByRole("radio", { name: "Top right" }).click();
    // The preview is the real engine output: wait for it to repaint with ink in the top-right corner.
    await expect
      .poll(async () =>
        preview.evaluate((canvas: HTMLCanvasElement) => {
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) return false;
          const w = canvas.width;
          const h = canvas.height;
          const data = context.getImageData(Math.floor(w * 0.7), 0, Math.ceil(w * 0.3), Math.ceil(h * 0.15)).data;
          for (let i = 0; i < data.length; i += 4) if (data[i] < 200) return true;
          return false;
        }),
      )
      .toBe(true);

    await page.getByLabel("First number").fill("5");
    await page.getByTestId("run-button").click();
    await expect(page.getByRole("heading", { name: "Your numbered PDF is ready" })).toBeVisible();
    const file = await downloadResult(page);
    expect(file.name).toBe("doc_numbered.pdf");
    const texts = await pageTexts(file.bytes);
    expect(texts[0]).toContain("Page 5 of 8");
    expect(texts[3]).toContain("Page 8 of 8");
    expect(texts[2]).toContain("D p3");
  });

  test("can number only some pages, in roman numerals", async ({ page }) => {
    await page.goto("/tools/page-numbers");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("D", 4, [400, 300]) }]);
    await page.getByTestId("page-scope").selectOption("skip-first");
    await page.getByRole("radio", { name: "i, ii, iii", exact: true }).check();
    await page.getByTestId("run-button").click();
    const file = await downloadResult(page);
    const texts = await pageTexts(file.bytes);
    expect(texts[0]).toBe("D p1"); // the cover stays unnumbered
    expect(texts[1]).toContain("i");
    expect(texts.map((t) => t.split(" ").pop())).toEqual(["p1", "i", "ii", "iii"]);
  });

  test("rejects a template without {n}", async ({ page }) => {
    await page.goto("/tools/page-numbers");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("D", 2, [400, 300]) }]);
    await page.getByTestId("format").fill("page");
    await expect(page.getByRole("alert").filter({ hasText: "Include {n}" })).toBeVisible();
  });
});

test.describe("Add watermark", () => {
  test("stamps text over the pages with a live preview", async ({ page }) => {
    await page.goto("/tools/watermark");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("W", 2, [400, 300]) }]);
    await expect(page.getByTestId("preview-canvas")).toBeVisible();
    await page.getByTestId("watermark-text").fill("TOP SECRET");
    await page.getByRole("radio", { name: "Behind the content" }).check();
    await expect(page.getByText("A watermark behind the content is hidden")).toBeVisible();
    await page.getByRole("radio", { name: "Over the content" }).check();
    // Upright text, so that a text reader (pdf.js) can read it back whole; a diagonal stamp that runs past the
    // edge of this small page would have its off-page glyphs dropped by the reader, which says nothing about the file.
    await setRange(page.getByLabel(/^Rotation/), 0);
    await expect(page.getByText("Rotation: 0°")).toBeVisible();
    await page.getByTestId("run-button").click();
    await expect(page.getByRole("heading", { name: "Your watermarked PDF is ready" })).toBeVisible();
    const file = await downloadResult(page);
    expect(file.name).toBe("doc_watermarked.pdf");
    const texts = await pageTexts(file.bytes);
    expect(texts[0]).toContain("W p1");
    expect(texts[0]).toContain("TOP SECRET");
    expect(texts[1]).toContain("TOP SECRET");
    const rendered = await renderPdfPage(file.bytes, 1, 1);
    expect(inkBounds(rendered, isWhite).count).toBeGreaterThan(500); // the grey stamp is really drawn
  });

  test("stamps an uploaded image at a chosen corner", async ({ page }) => {
    await page.goto("/tools/watermark");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeColorPdf([[255, 255, 255]], [400, 300]) }]);
    await page.getByRole("radio", { name: "Image" }).check();
    await expect(page.getByTestId("run-button")).toBeDisabled(); // nothing chosen yet
    await page.getByTestId("watermark-image-input").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: Buffer.from(makeImage("png", 40, 40, (c, w, h) => { c.fillStyle = "#0000ff"; c.fillRect(0, 0, w, h); })) });
    await expect(page.getByText("logo.png")).toBeVisible();
    await page.getByRole("radio", { name: "Bottom right" }).click();
    await setRange(page.getByLabel(/^Size:/), 20); // 20% of the page width: an 80 pt square on this 400 pt page
    await setRange(page.getByLabel(/^Rotation/), 0);
    await expect(page.getByText("Size: 20% of the page width")).toBeVisible();
    await page.getByTestId("run-button").click();
    const file = await downloadResult(page);
    const rendered = await renderPdfPage(file.bytes, 1, 1);
    const ink = inkBounds(rendered, isWhite);
    expect(ink.count).toBeGreaterThan(500);
    expect(ink.minX).toBeGreaterThan(rendered.width * 0.7);
    expect(ink.minY).toBeGreaterThan(rendered.height * 0.6);
    expect(ink.maxX).toBeLessThan(rendered.width); // inside the page, with its margin
    expect(ink.maxX - ink.minX).toBeGreaterThan(70);
    expect(ink.maxX - ink.minX).toBeLessThan(90);
  });

  test("refuses a file that is not an image", async ({ page }) => {
    await page.goto("/tools/watermark");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("W", 1, [400, 300]) }]);
    await page.getByRole("radio", { name: "Image" }).check();
    await page.getByTestId("watermark-image-input").setInputFiles({ name: "fake.png", mimeType: "image/png", buffer: Buffer.from("this is text") });
    await expect(page.getByText(/not really a PNG image/)).toBeVisible();
    await expect(page.getByTestId("run-button")).toBeDisabled();
  });
});

test.describe("Crop PDF", () => {
  test("crops using numeric margins, previews the result, and saves the cropped geometry", async ({ page }) => {
    await page.goto("/tools/crop");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeColorPdf([[255, 0, 0], [255, 0, 0]], [300, 200]) }]);
    await expect(page.getByTestId("crop-box")).toBeVisible();

    await page.getByRole("radio", { name: "pt", exact: true }).check();
    await page.getByLabel("Top (pt)").fill("20");
    await page.getByLabel("Bottom (pt)").fill("20");
    await page.getByLabel("Left (pt)").fill("30");
    await page.getByLabel("Right (pt)").fill("50");

    await page.getByRole("radio", { name: "Preview the result" }).check();
    await expect
      .poll(() => page.getByTestId("preview-canvas").evaluate((canvas: HTMLCanvasElement) => Math.round((canvas.width / canvas.height) * 100) / 100))
      .toBeCloseTo(220 / 160, 1); // aspect ratio of the cropped page

    await page.getByTestId("run-button").click();
    await expect(page.getByRole("heading", { name: "Your cropped PDF is ready" })).toBeVisible();
    await expect(page.getByText("Cropping hides, it does not erase")).toBeVisible();
    const file = await downloadResult(page);
    expect(file.name).toBe("doc_cropped.pdf");
    const geometry = await pageGeometry(file.bytes);
    expect(geometry.map((g) => `${g.width}x${g.height}`)).toEqual(["220x160", "220x160"]);
  });

  test("dragging the box changes the margins", async ({ page }) => {
    await page.goto("/tools/crop");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeColorPdf([[255, 0, 0]], [400, 300]) }]);
    await page.getByRole("radio", { name: "%", exact: true }).check();
    const left = page.getByLabel("Left (%)");
    await expect(left).toHaveValue("8");

    const box = page.getByTestId("crop-box");
    const handle = box.locator('[data-edge="w"]');
    const area = await page.getByTestId("crop-area").boundingBox();
    const start = await handle.boundingBox();
    expect(area && start).toBeTruthy();
    await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
    await page.mouse.down();
    await page.mouse.move(start!.x + start!.width / 2 + area!.width * 0.2, start!.y + start!.height / 2, { steps: 5 });
    await page.mouse.up();
    // moved right by ~20% of the page width: the left margin grew from 8% to about 28%
    await expect.poll(async () => Number(await left.inputValue())).toBeGreaterThan(25);
    await expect.poll(async () => Number(await left.inputValue())).toBeLessThan(31);
  });

  test("moves the box with the arrow keys", async ({ page }) => {
    await page.goto("/tools/crop");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeColorPdf([[255, 0, 0]], [400, 300]) }]);
    await page.getByRole("radio", { name: "%", exact: true }).check();
    await page.getByTestId("crop-box").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByLabel("Left (%)")).toHaveValue("10");
    await expect(page.getByLabel("Right (%)")).toHaveValue("6");
  });

  test("clearing the box disables cropping", async ({ page }) => {
    await page.goto("/tools/crop");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeColorPdf([[255, 0, 0]], [400, 300]) }]);
    await expect(page.getByTestId("run-button")).toBeEnabled();
    await page.getByRole("button", { name: "Clear" }).click();
    await expect(page.getByTestId("run-button")).toBeDisabled();
  });

  test("crops a rotated page the way it is displayed", async ({ page }) => {
    const doc = await PDFDocument.create();
    const p = doc.addPage([300, 200]);
    p.setRotation(degrees(90));
    await page.goto("/tools/crop");
    await addFiles(page, [{ name: "rot.pdf", bytes: await doc.save() }]);
    await page.getByRole("radio", { name: "pt", exact: true }).check();
    await page.getByLabel("Top (pt)").fill("50");
    await page.getByLabel("Bottom (pt)").fill("0");
    await page.getByLabel("Left (pt)").fill("0");
    await page.getByLabel("Right (pt)").fill("0");
    await page.getByTestId("run-button").click();
    const file = await downloadResult(page);
    // displayed 200x300 -> displayed 200x250, i.e. stored 250x200 with the rotation kept
    expect(await pageGeometry(file.bytes)).toEqual([{ width: 250, height: 200, rotation: 90 }]);
  });
});

test.describe("PDF metadata", () => {
  async function sample() {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.setTitle("Quarterly numbers");
    doc.setAuthor("Jordan Writer");
    doc.setCreator("Writer 7");
    doc.setProducer("Acme PDF");
    doc.addPage([595.28, 841.89]);
    doc.addPage([595.28, 841.89]);
    return doc.save();
  }

  test("shows the document's properties and warns about what it reveals", async ({ page }) => {
    await page.goto("/tools/metadata");
    await addFiles(page, [{ name: "report.pdf", bytes: await sample() }]);
    const props = page.getByTestId("properties");
    await expect(props).toContainText("Pages2");
    await expect(props).toContainText("A4 portrait");
    await expect(props).toContainText("PDF version1.7");
    await expect(page.getByLabel("Title")).toHaveValue("Quarterly numbers");
    await expect(page.getByLabel("Author", { exact: true })).toHaveValue("Jordan Writer");
    await expect(page.getByText("The author field names “Jordan Writer”.")).toBeVisible();
    await expect(page.getByTestId("run-button")).toBeDisabled(); // nothing edited yet
  });

  test("edits fields and saves a PDF that carries them", async ({ page }) => {
    await page.goto("/tools/metadata");
    await addFiles(page, [{ name: "report.pdf", bytes: await sample() }]);
    await page.getByLabel("Title").fill("Renamed report");
    await page.getByLabel("Author", { exact: true }).fill("");
    await page.getByLabel("Subject").fill("Finance");
    await page.getByTestId("run-button").click();
    await expect(page.getByRole("heading", { name: "Your updated PDF is ready" })).toBeVisible();
    const file = await downloadResult(page);
    expect(file.name).toBe("report_edited.pdf");
    const info = await readMetadata({ name: file.name, bytes: file.bytes });
    expect(info).toMatchObject({ title: "Renamed report", subject: "Finance", creator: "Writer 7", pageCount: 2 });
    expect(info.author).toBeUndefined();
  });

  test("removes all metadata after an explicit confirmation", async ({ page }) => {
    await page.goto("/tools/metadata");
    await addFiles(page, [{ name: "report.pdf", bytes: await sample() }]);
    await page.getByTestId("clear-all").click();
    await expect(page.getByText("Remove every property and the hidden XMP data?")).toBeVisible();
    await page.getByTestId("confirm-clear").click();
    await expect(page.getByRole("heading", { name: "Your cleaned PDF is ready" })).toBeVisible();
    const file = await downloadResult(page);
    expect(file.name).toBe("report_clean.pdf");
    const info = await readMetadata({ name: file.name, bytes: file.bytes });
    expect(info.title).toBeUndefined();
    expect(info.author).toBeUndefined();
    expect(info.producer).toBeUndefined();
    expect(info.pageCount).toBe(2);
  });

  test("cancelling the confirmation keeps everything", async ({ page }) => {
    await page.goto("/tools/metadata");
    await addFiles(page, [{ name: "report.pdf", bytes: await sample() }]);
    await page.getByTestId("clear-all").click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("clear-all")).toBeVisible();
    await expect(page.getByLabel("Title")).toHaveValue("Quarterly numbers");
  });
});
