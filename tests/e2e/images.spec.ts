import { loadImage } from "@napi-rs/canvas";
import { PDFDocument } from "@cantoo/pdf-lib";
import { makeColorPdf, makeTextPdf, pageGeometry } from "../unit/helpers/pdf";
import { isBlue, isRed, makeImage, renderPdfPage, withExifOrientation } from "../unit/helpers/images";
import { addFiles, expect, test } from "./fixtures";
import { downloadResult, unzip } from "./helpers";

const imageFile = (name: string, bytes: Uint8Array, mimeType: string) => ({ name, bytes, mimeType });

test.describe("JPG to PDF", () => {
  test("combines JPG, PNG and WebP images into one PDF in the chosen order", async ({ page }) => {
    await page.goto("/tools/jpg-to-pdf");
    await addFiles(page, [
      imageFile("one.jpg", makeImage("jpeg", 80, 40), "image/jpeg"),
      imageFile("two.png", makeImage("png", 80, 40), "image/png"),
      imageFile("three.webp", makeImage("webp", 80, 40), "image/webp"),
    ]);
    const rows = page.getByTestId("file-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).locator("img")).toBeVisible(); // a real thumbnail

    // Move three.webp to the front.
    await page.getByRole("button", { name: "Move three.webp up" }).click();
    await page.getByRole("button", { name: "Move three.webp up" }).click();
    await expect(rows.nth(0)).toContainText("three.webp");

    await page.getByTestId("run-button").click();
    await expect(page.getByRole("heading", { name: "Your PDF is ready" })).toBeVisible();
    await expect(page.getByTestId("result-stats")).toContainText("3");
    await expect(page.getByTestId("viewer-canvas")).toBeVisible();

    const file = await downloadResult(page);
    expect(file.name).toBe("images.pdf");
    expect((await PDFDocument.load(file.bytes)).getPageCount()).toBe(3);
    // every page really shows the picture (red | blue halves) and the A4 landscape layout
    for (const pageNumber of [1, 2, 3]) {
      const rendered = await renderPdfPage(file.bytes, pageNumber, 1);
      expect(isRed(rendered.at(rendered.width * 0.25, rendered.height / 2))).toBe(true);
      expect(isBlue(rendered.at(rendered.width * 0.75, rendered.height / 2))).toBe(true);
    }
    expect(await pageGeometry(file.bytes)).toEqual([
      { width: 842, height: 595, rotation: 0 },
      { width: 842, height: 595, rotation: 0 },
      { width: 842, height: 595, rotation: 0 },
    ]);
  });

  test("straightens a photo that the camera stored sideways", async ({ page }) => {
    await page.goto("/tools/jpg-to-pdf");
    const sideways = withExifOrientation(makeImage("jpeg", 60, 30), 6);
    await addFiles(page, [imageFile("phone.jpg", sideways, "image/jpeg")]);
    await page.getByTestId("page-size").selectOption("fit");
    await page.getByTestId("run-button").click();
    const file = await downloadResult(page);
    const [geometry] = await pageGeometry(file.bytes);
    expect(geometry!.height).toBeGreaterThan(geometry!.width);
    const rendered = await renderPdfPage(file.bytes, 1, 6);
    expect(isRed(rendered.at(rendered.width / 2, rendered.height * 0.25))).toBe(true);
    expect(isBlue(rendered.at(rendered.width / 2, rendered.height * 0.75))).toBe(true);
  });

  test("applies page size, orientation and margin options", async ({ page }) => {
    await page.goto("/tools/jpg-to-pdf");
    await addFiles(page, [imageFile("wide.png", makeImage("png", 80, 40), "image/png")]);
    await page.getByTestId("page-size").selectOption("letter");
    await page.getByRole("radio", { name: "Portrait" }).check();
    await page.getByRole("radio", { name: "Large" }).check();
    await page.getByTestId("run-button").click();
    const file = await downloadResult(page);
    expect(await pageGeometry(file.bytes)).toEqual([{ width: 612, height: 792, rotation: 0 }]);
    const rendered = await renderPdfPage(file.bytes, 1, 1);
    expect(rendered.at(10, 10).every((channel) => channel > 245)).toBe(true); // margin stays white
  });

  test("can create one PDF per image", async ({ page }) => {
    await page.goto("/tools/jpg-to-pdf");
    await addFiles(page, [imageFile("a.png", makeImage("png"), "image/png"), imageFile("b.jpg", makeImage("jpeg"), "image/jpeg")]);
    await page.getByRole("radio", { name: "One PDF per image" }).check();
    await page.getByTestId("run-button").click();
    await expect(page.getByRole("heading", { name: "Your 2 PDFs are ready" })).toBeVisible();
    const files = unzip((await downloadResult(page)).bytes);
    expect(Object.keys(files).sort()).toEqual(["a.pdf", "b.pdf"]);
  });

  test("refuses files that are not images and keeps good ones", async ({ page }) => {
    await page.goto("/tools/jpg-to-pdf");
    await addFiles(page, [
      imageFile("fake.png", new TextEncoder().encode("not an image"), "image/png"),
      imageFile("good.png", makeImage("png"), "image/png"),
    ]);
    const bad = page.getByTestId("file-row").filter({ hasText: "fake.png" });
    await expect(bad).toContainText("not really a PNG image");
    await expect(page.getByTestId("run-button")).toBeDisabled();
    await expect(page.getByText("Remove the images that cannot be used")).toBeVisible();
    await page.getByRole("button", { name: "Remove fake.png" }).click();
    await expect(page.getByTestId("run-button")).toBeEnabled();
  });

  test("rejects unsupported file types up front", async ({ page }) => {
    await page.goto("/tools/jpg-to-pdf");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("X", 1) }]);
    await expect(page.getByTestId("rejections")).toContainText("not a supported file");
  });
});

test.describe("PDF to JPG", () => {
  const colors: [number, number, number][] = [
    [255, 0, 0],
    [0, 0, 255],
    [0, 255, 0],
  ];

  test("renders every page to a JPG at the chosen resolution, bundled as a ZIP", async ({ page }) => {
    await page.goto("/tools/pdf-to-jpg");
    await addFiles(page, [{ name: "colors.pdf", bytes: await makeColorPdf(colors, [200, 100]) }]);
    await page.getByTestId("dpi").selectOption("72");
    await expect(page.getByTestId("selection-summary")).toContainText("3 images will be created");
    await page.getByTestId("run-button").click();

    await expect(page.getByRole("heading", { name: "Your 3 images are ready" })).toBeVisible();
    await expect(page.getByLabel("Image previews").getByRole("img")).toHaveCount(3);
    const zip = await downloadResult(page);
    expect(zip.name).toBe("colors_images.zip");
    const files = unzip(zip.bytes);
    expect(Object.keys(files).sort()).toEqual(["colors_page-1.jpg", "colors_page-2.jpg", "colors_page-3.jpg"]);

    const expected = ["red", "blue", "green"];
    for (const [index, name] of Object.keys(files).sort().entries()) {
      const image = await loadImage(Buffer.from(files[name] as Uint8Array));
      expect(image.width).toBe(200); // 200pt at 72 dpi
      expect(image.height).toBe(100);
      const { createCanvas } = await import("@napi-rs/canvas");
      const canvas = createCanvas(image.width, image.height);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const [r, g, b] = context.getImageData(100, 50, 1, 1).data;
      const dominant = (r as number) > 200 ? "red" : (b as number) > 200 ? "blue" : (g as number) > 200 ? "green" : "other";
      expect(dominant, `page ${index + 1}`).toBe(expected[index]);
    }
  });

  test("higher resolutions give larger images", async ({ page }) => {
    await page.goto("/tools/pdf-to-jpg");
    await addFiles(page, [{ name: "one.pdf", bytes: await makeColorPdf([[255, 0, 0]], [200, 100]) }]);
    await page.getByTestId("dpi").selectOption("300");
    await page.getByTestId("run-button").click();
    const download = await downloadResult(page);
    expect(download.name).toBe("one_page-1.jpg"); // a single page is not zipped
    const image = await loadImage(Buffer.from(download.bytes));
    expect(image.width).toBe(833); // 200pt * 300/72 = 833.3, rounded down
    expect(image.height).toBe(416); // 100pt * 300/72 = 416.7, rounded down
  });

  test("exports PNG and only the selected pages", async ({ page }) => {
    await page.goto("/tools/pdf-to-jpg");
    await addFiles(page, [{ name: "colors.pdf", bytes: await makeColorPdf(colors, [100, 100]) }]);
    await page.getByRole("radio", { name: "PNG" }).check();
    await page.getByRole("radio", { name: "A selection" }).check();
    await page.getByRole("textbox", { name: "Pages" }).fill("2-3");
    await expect(page.getByTestId("selection-summary")).toContainText("2 images will be created");
    await page.getByTestId("dpi").selectOption("72");
    await page.getByTestId("run-button").click();
    const files = unzip((await downloadResult(page)).bytes);
    expect(Object.keys(files).sort()).toEqual(["colors_page-2.png", "colors_page-3.png"]);
    const png = files["colors_page-2.png"] as Uint8Array;
    expect(Array.from(png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("validates the page selection", async ({ page }) => {
    await page.goto("/tools/pdf-to-jpg");
    await addFiles(page, [{ name: "colors.pdf", bytes: await makeColorPdf(colors) }]);
    await page.getByRole("radio", { name: "A selection" }).check();
    await expect(page.getByTestId("run-button")).toBeDisabled();
    await page.getByRole("textbox", { name: "Pages" }).fill("7");
    await expect(page.getByRole("alert").filter({ hasText: "Page 7 is out of range" })).toBeVisible();
    await expect(page.getByTestId("run-button")).toBeDisabled();
  });
});
