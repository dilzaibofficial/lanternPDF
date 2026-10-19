import type { Page } from "@playwright/test";
import { renderPdfPage } from "../unit/helpers/images";
import { pageTexts } from "../unit/helpers/pdf";
import { csv, docx, docxParagraphs, makeReport, makeScan, makeTable, nonEmpty, odt, sheetsOf, textOf, unzip, withMarker } from "../unit/helpers/documents";
import { makeDeck, makeWordDocument, makeWorkbook } from "../unit/helpers/officeDocs";
import { addFiles, expect, test } from "./fixtures";
import { downloadResult } from "./helpers";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function expectServerMode(page: Page, available: boolean) {
  await expect(page.getByTestId("mode-device")).toBeChecked();
  if (available) await expect(page.getByTestId("mode-server")).toBeEnabled();
  else await expect(page.getByTestId("mode-server")).toBeDisabled();
}

test.describe("PDF to Word", () => {
  test("rebuilds the text on this device and the download is a real Word file", async ({ page }) => {
    await page.goto("/tools/pdf-to-word");
    await addFiles(page, [{ name: "report.pdf", bytes: await makeReport() }]);
    await expectServerMode(page, true);
    await page.getByTestId("convert-button").click();

    await expect(page.getByRole("heading", { name: "Your word document is ready" })).toBeVisible();
    await expect(page.getByText("Made on this device. The PDF never left it.")).toBeVisible();
    const file = await downloadResult(page);
    expect(file.name).toBe("report.docx");
    const paragraphs = docxParagraphs(file.bytes);
    const texts = nonEmpty(paragraphs);
    expect(texts[0]).toBe("Annual Report");
    expect(paragraphs.find((p) => p.text === "Annual Report")?.xml).toContain("Heading1");
    expect(texts).toContain("The company grew steadily during the year and expanded into three new markets while keeping costs under control. Customer satisfaction reached an all-time high in the autumn survey.");
    expect(paragraphs.find((p) => p.text === "Revenue up 12%")?.xml).toContain("<w:numPr>");
    expect(texts).toContain("Second page text goes here with some more words in the line.");

    const row = page.getByTestId("result-row");
    await expect(row).toContainText("report.pdf");
    await expect(row).toContainText("report.docx");
    await row.getByText("What was done").click();
    await expect(row).toContainText("Text, headings, lists, columns and simple tables were rebuilt");
  });

  test("a table becomes a Word table", async ({ page }) => {
    await page.goto("/tools/pdf-to-word");
    await addFiles(page, [{ name: "prices.pdf", bytes: await makeTable() }]);
    await page.getByTestId("convert-button").click();
    await expect(page.getByRole("heading", { name: "Your word document is ready" })).toBeVisible();
    const file = await downloadResult(page);
    expect(textOf(unzip(file.bytes)["word/document.xml"])).toContain("<w:tbl>");
    expect(nonEmpty(docxParagraphs(file.bytes))).toContain("$129.50");
  });

  test("a scanned PDF is refused with the reason, and nothing is offered for download", async ({ page }) => {
    await page.goto("/tools/pdf-to-word");
    await addFiles(page, [{ name: "scan.pdf", bytes: await makeScan() }]);
    await page.getByTestId("convert-button").click();
    await expect(page.getByTestId("convert-failed")).toContainText("could not be turned into a word document");
    await expect(page.getByTestId("result-row")).toContainText("no text that can be read");
    await expect(page.getByTestId("download-all")).toHaveCount(0);
    await page.getByRole("button", { name: "Back to the files" }).click();
    await expect(page.getByTestId("convert-button")).toBeEnabled(); // the file is still loaded
  });

  test("converts what it can in a mixed batch and reports the rest", async ({ page }) => {
    await page.goto("/tools/pdf-to-word");
    await addFiles(page, [
      { name: "report.pdf", bytes: await makeReport() },
      { name: "scan.pdf", bytes: await makeScan() },
    ]);
    await expect(page.getByTestId("convert-button")).toContainText("Convert 2 PDFs");
    await page.getByTestId("convert-button").click();
    await expect(page.getByRole("heading", { name: "Your word document is ready" })).toBeVisible();
    await expect(page.getByText("1 file could not be converted")).toBeVisible();
    const rows = page.getByTestId("result-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "scan.pdf" })).toContainText("Failed");
    await expect(rows.filter({ hasText: "report.pdf" })).toContainText("report.docx");
  });

  test("the layout mode sends the PDF to the server's LibreOffice and checks what comes back", async ({ page }) => {
    await page.goto("/tools/pdf-to-word");
    await addFiles(page, [{ name: "report.pdf", bytes: await makeReport() }]);
    await page.getByTestId("mode-server").check();
    await page.getByTestId("convert-button").click();
    await expect(page.getByRole("heading", { name: "Your word document is ready" })).toBeVisible();
    await expect(page.getByText("Converted with LibreOffice on your server.")).toBeVisible();
    const file = await downloadResult(page);
    expect(file.name).toBe("report.docx");
    // the test double records which import filter it was asked to use
    expect(textOf(unzip(file.bytes)["content.txt"])).toBe("converted with --infilter=writer_pdf_import");
  });

  test("offers the server mode as unavailable, with the reason, when LibreOffice is missing", async ({ page }) => {
    await page.route("**/api/capabilities", (route) =>
      route.fulfill({ json: { version: "1.0.0", limits: { maxUploadBytes: 2097152 }, engines: { libreoffice: { available: false, reason: "LibreOffice is not installed (or not on the server's PATH)." }, ghostscript: { available: false } } } }),
    );
    await page.goto("/tools/pdf-to-word");
    await addFiles(page, [{ name: "report.pdf", bytes: await makeReport() }]);
    await expectServerMode(page, false);
    await expect(page.getByText("Not available: LibreOffice is not installed")).toBeVisible();
    await page.getByTestId("convert-button").click(); // the on-device mode still works
    await expect(page.getByRole("heading", { name: "Your word document is ready" })).toBeVisible();
  });

  test("works when there is no server at all", async ({ page }) => {
    await page.route("**/api/capabilities", (route) => route.fulfill({ status: 502, body: "bad gateway" }));
    await page.goto("/tools/pdf-to-word");
    await addFiles(page, [{ name: "report.pdf", bytes: await makeReport() }]);
    await expectServerMode(page, false);
    await expect(page.getByText("this site is not connected to a conversion server")).toBeVisible();
    await page.getByTestId("convert-button").click();
    await expect(page.getByRole("heading", { name: "Your word document is ready" })).toBeVisible();
  });
});

test.describe("PDF to Excel", () => {
  test("pulls the table into cells, with numbers as numbers", async ({ page }) => {
    await page.goto("/tools/pdf-to-excel");
    await addFiles(page, [{ name: "prices.pdf", bytes: await makeTable() }]);
    await expect(page.getByTestId("mode-device")).toHaveCount(0); // no server mode for spreadsheets: it is always on this device
    await page.getByTestId("convert-button").click();
    await expect(page.getByRole("heading", { name: "Your excel spreadsheet is ready" })).toBeVisible();
    const file = await downloadResult(page);
    expect(file.name).toBe("prices.xlsx");
    const [sheet] = await sheetsOf(file.bytes);
    expect(sheet?.rows.slice(1, 4)).toEqual([
      ["Item", "Qty", "Price"],
      ["Widget", 4, 9.99],
      ["Gadget with a long name", 1200, 129.5],
    ]);
  });

  test("can keep everything as text and put the pages on one sheet", async ({ page }) => {
    await page.goto("/tools/pdf-to-excel");
    await addFiles(page, [{ name: "report.pdf", bytes: await makeReport() }]);
    await page.getByLabel("Store clear numbers as numbers").uncheck();
    await page.getByRole("radio", { name: "Everything on one sheet" }).check();
    await page.getByTestId("convert-button").click();
    await expect(page.getByRole("heading", { name: "Your excel spreadsheet is ready" })).toBeVisible();
    const sheets = await sheetsOf((await downloadResult(page)).bytes);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.rows.map((row) => row[0])).toContain("Details");
  });

  test("does not ask the server anything", async ({ page }) => {
    const asked: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/")) asked.push(request.url());
    });
    await page.goto("/tools/pdf-to-excel");
    await addFiles(page, [{ name: "prices.pdf", bytes: await makeTable() }]);
    await page.getByTestId("convert-button").click();
    await expect(page.getByRole("heading", { name: "Your excel spreadsheet is ready" })).toBeVisible();
    expect(asked).toEqual([]);
  });
});

test.describe("PDF to PowerPoint", () => {
  test("makes one slide per page from real renders, with the text in the notes", async ({ page }) => {
    await page.goto("/tools/pdf-to-powerpoint");
    await addFiles(page, [{ name: "report.pdf", bytes: await makeReport() }]);
    await page.getByRole("radio", { name: "Balanced" }).check();
    await page.getByTestId("convert-button").click();
    await expect(page.getByRole("heading", { name: "Your powerpoint presentation is ready" })).toBeVisible();
    const file = await downloadResult(page);
    expect(file.name).toBe("report.pptx");
    const entries = unzip(file.bytes);
    expect(Object.keys(entries).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(2);
    const media = Object.entries(entries).filter(([name]) => /^ppt\/media\/[^/]+\.jpe?g$/i.test(name));
    expect(media).toHaveLength(2);
    for (const [, bytes] of media) {
      expect(bytes[0]).toBe(0xff); // a real JPEG, rendered by the browser
      expect(bytes[1]).toBe(0xd8);
      expect(bytes.length).toBeGreaterThan(5000);
    }
    const notes = Object.entries(entries)
      .filter(([name]) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))
      .map(([, bytes]) => textOf(bytes))
      .join(" ");
    expect(notes).toContain("Annual Report");
  });

  test("the server's editable mode asks LibreOffice's Impress import and is checked", async ({ page }) => {
    await page.goto("/tools/pdf-to-powerpoint");
    await addFiles(page, [{ name: "deck.pdf", bytes: await makeReport() }]);
    await page.getByTestId("mode-server").check();
    await page.getByTestId("convert-button").click();
    await expect(page.getByRole("heading", { name: "Your powerpoint presentation is ready" })).toBeVisible();
    const file = await downloadResult(page);
    expect(file.name).toBe("deck.pptx");
    expect(textOf(unzip(file.bytes)["content.txt"])).toBe("converted with --infilter=impress_pdf_import");
  });
});

test.describe("Word, Excel and PowerPoint to PDF", () => {
  test("converts a document on the server and checks the PDF before offering it", async ({ page }) => {
    await page.goto("/tools/word-to-pdf");
    await page.getByTestId("mode-server").check();
    await addFiles(page, [{ name: "Quarterly report.docx", bytes: docx(), mimeType: DOCX }]);
    await expect(page.getByTestId("convert-summary")).toContainText("1 file");
    await page.getByTestId("convert-button").click();
    await expect(page.getByRole("heading", { name: "Your PDF is ready" })).toBeVisible();
    await expect(page.getByText("Converted by LibreOffice on your server")).toBeVisible();
    const file = await downloadResult(page);
    expect(file.name).toBe("Quarterly report.pdf");
    expect(await pageTexts(file.bytes)).toEqual(["converted from .docx"]);
    expect(file.bytes.length).toBeGreaterThan(300);
  });

  test("converts several files at once into a ZIP, each with its own name", async ({ page }) => {
    await page.goto("/tools/word-to-pdf");
    await page.getByTestId("mode-server").check();
    await addFiles(page, [
      { name: "a.docx", bytes: docx(), mimeType: DOCX },
      { name: "b.odt", bytes: odt(), mimeType: "application/vnd.oasis.opendocument.text" },
    ]);
    await expect(page.getByTestId("convert-button")).toContainText("Convert 2 files");
    await page.getByTestId("convert-button").click();
    await expect(page.getByRole("heading", { name: "2 PDFs are ready" })).toBeVisible();
    const zip = await downloadResult(page);
    expect(zip.name).toBe("converted-pdfs.zip");
    expect(Object.keys(unzip(zip.bytes)).sort()).toEqual(["a.pdf", "b.pdf"]);
  });

  test("spreadsheets go through the same server path", async ({ page }) => {
    await page.goto("/tools/excel-to-pdf");
    await page.getByTestId("mode-server").check();
    await addFiles(page, [{ name: "numbers.csv", bytes: csv(), mimeType: "text/csv" }]);
    await page.getByTestId("convert-button").click();
    await expect(page.getByRole("heading", { name: "Your PDF is ready" })).toBeVisible();
    expect(await pageTexts((await downloadResult(page)).bytes)).toEqual(["converted from .csv"]);
  });

  test("shows why a document could not be converted, without leaking server details", async ({ page }) => {
    await page.goto("/tools/word-to-pdf");
    await page.getByTestId("mode-server").check();
    await addFiles(page, [
      { name: "good.docx", bytes: docx(), mimeType: DOCX },
      { name: "broken.docx", bytes: docx("FAKE:FAIL"), mimeType: DOCX },
    ]);
    await page.getByTestId("convert-button").click();
    await expect(page.getByRole("heading", { name: "Your PDF is ready" })).toBeVisible();
    await expect(page.getByText("1 file could not be converted")).toBeVisible();
    const broken = page.getByTestId("result-row").filter({ hasText: "broken.docx" });
    await expect(broken).toContainText("could not process this file");
    await expect(broken).not.toContainText("source file could not be loaded"); // the engine's own message stays on the server
    const good = await downloadResult(page); // only the file that converted is offered
    expect(good.name).toBe("good.pdf");
    expect(await pageTexts(good.bytes)).toEqual(["converted from .docx"]);
  });

  test("when every file fails, nothing is offered for download", async ({ page }) => {
    await page.goto("/tools/word-to-pdf");
    await page.getByTestId("mode-server").check();
    await addFiles(page, [{ name: "broken.docx", bytes: docx("FAKE:FAIL"), mimeType: DOCX }]);
    await page.getByTestId("convert-button").click();
    await expect(page.getByRole("heading", { name: "The file could not be converted" })).toBeVisible();
    await expect(page.getByTestId("download-all")).toHaveCount(0);
    await expect(page.getByTestId("result-row")).toContainText("Failed");
  });

  test("a conversion that returns a damaged PDF is discarded", async ({ page }) => {
    await page.goto("/tools/word-to-pdf");
    await page.getByTestId("mode-server").check();
    await addFiles(page, [{ name: "odd.docx", bytes: docx("FAKE:GARBAGE"), mimeType: DOCX }]);
    await page.getByTestId("convert-button").click();
    await expect(page.getByRole("heading", { name: "The file could not be converted" })).toBeVisible();
    await expect(page.getByTestId("result-row")).toContainText("unexpected format");
  });

  test("rejects a file that is not what its name says, before uploading it", async ({ page }) => {
    const uploads: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/api/convert")) uploads.push(request.url());
    });
    await page.goto("/tools/word-to-pdf");
    await addFiles(page, [{ name: "fake.docx", bytes: new TextEncoder().encode("just some text pretending"), mimeType: DOCX }]);
    const row = page.getByTestId("file-row");
    await expect(row).toContainText("is not really");
    await expect(page.getByTestId("convert-button")).toBeDisabled();
    expect(uploads).toEqual([]);
  });

  test("applies the server's upload limit in the browser", async ({ page }) => {
    await page.goto("/tools/word-to-pdf");
    await page.getByTestId("mode-server").check();
    await addFiles(page, [{ name: "huge.docx", bytes: docx("x".repeat(3 * 1024 * 1024)), mimeType: DOCX }]);
    await expect(page.getByText(/over the 2\.0 MB limit/)).toBeVisible();
    await expect(page.getByTestId("file-row")).toHaveCount(0);
  });

  test("PowerPoint still converts on this device when there is no server, and the server mode says why it is off", async ({ page }) => {
    await page.route("**/api/capabilities", (route) => route.abort());
    await page.goto("/tools/powerpoint-to-pdf");
    await expect(page.getByTestId("mode-device")).toBeChecked();
    await expect(page.getByTestId("mode-server")).toBeDisabled();
    await expect(page.getByText("Not available: this site is not connected to a conversion server.")).toBeVisible();
    await expect(page.getByTestId("file-input")).toHaveCount(1);
  });

  test("says the server has no LibreOffice, and still offers the on-device mode", async ({ page }) => {
    await page.route("**/api/capabilities", (route) =>
      route.fulfill({ json: { version: "1.0.0", limits: { maxUploadBytes: 2097152 }, engines: { libreoffice: { available: false, reason: "SOFFICE_PATH points to nowhere." }, ghostscript: { available: false } } } }),
    );
    await page.goto("/tools/powerpoint-to-pdf");
    await expect(page.getByTestId("mode-server")).toBeDisabled();
    await expect(page.getByText("Not available: LibreOffice is not installed on the server.")).toBeVisible();
    await expect(page.getByTestId("mode-device")).toBeChecked();
  });

  test("the self-hosting page the notices point to exists", async ({ page }) => {
    await page.goto("/self-hosting");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
  test("Word to PDF converts on this device, with no upload and no server needed", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/")) requests.push(request.method() + " " + request.url());
    });
    await page.route("**/api/capabilities", (route) => route.abort());
    await page.goto("/tools/word-to-pdf");
    await expect(page.getByTestId("mode-device")).toBeChecked();
    await expect(page.getByTestId("mode-server")).toBeDisabled();
    await addFiles(page, [{ name: "Annual summary.docx", bytes: await makeWordDocument(), mimeType: DOCX }]);
    await page.getByTestId("convert-button").click();
    await expect(page.getByRole("heading", { name: "Your PDF is ready" })).toBeVisible();
    await expect(page.getByText("Converted on this device. Your file never left it.")).toBeVisible();
    const file = await downloadResult(page);
    expect(file.name).toBe("Annual summary.pdf");
    const [text] = await pageTexts(file.bytes);
    expect(text).toContain("Annual summary");
    expect(text).toContain("Second point");
    expect(text).toContain("Page 1 of 1");
    expect(requests.filter((entry) => entry.startsWith("POST"))).toEqual([]);
  });

  test("Word to PDF on this device refuses an old .doc file with the reason, and offers a way forward", async ({ page }) => {
    await page.route("**/api/capabilities", (route) => route.abort());
    await page.goto("/tools/word-to-pdf");
    await addFiles(page, [{ name: "old.doc", bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]), mimeType: "application/msword" }]);
    await expect(page.getByText(/is not a supported file/)).toBeVisible();
    await expect(page.getByText(/.docx/).first()).toBeVisible();
  });

  test("Excel to PDF converts a workbook on this device and shows the formats it kept", async ({ page }) => {
    await page.route("**/api/capabilities", (route) => route.abort());
    await page.goto("/tools/excel-to-pdf");
    await addFiles(page, [{ name: "sales.xlsx", bytes: await makeWorkbook(), mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }]);
    await expect(page.getByLabel("Fit wide sheets to the page width")).toBeChecked();
    await page.getByTestId("convert-button").click();
    await expect(page.getByRole("heading", { name: "Your PDF is ready" })).toBeVisible();
    const file = await downloadResult(page);
    expect(file.name).toBe("sales.pdf");
    const texts = await pageTexts(file.bytes);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("$1,234.50");
    expect(texts[0]).toContain("25.6%");
    expect(texts[1]).toContain("Second sheet text");
  });

  test("a CSV file becomes a PDF table on this device", async ({ page }) => {
    await page.route("**/api/capabilities", (route) => route.abort());
    await page.goto("/tools/excel-to-pdf");
    await addFiles(page, [{ name: "numbers.csv", bytes: new TextEncoder().encode("name,amount\nwidget,4\ngadget,10.5\n"), mimeType: "text/csv" }]);
    await page.getByTestId("convert-button").click();
    await expect(page.getByRole("heading", { name: "Your PDF is ready" })).toBeVisible();
    const [text] = await pageTexts((await downloadResult(page)).bytes);
    expect(text).toContain("widget");
    expect(text).toContain("10.5");
  });

  test("PowerPoint to PDF converts a deck on this device, one page per visible slide, with no upload", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/")) requests.push(request.method() + " " + request.url());
    });
    await page.route("**/api/capabilities", (route) => route.abort());
    await page.goto("/tools/powerpoint-to-pdf");
    await addFiles(page, [{ name: "Quarterly review.pptx", bytes: await makeDeck(), mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }]);
    await page.getByTestId("convert-button").click();
    await expect(page.getByRole("heading", { name: "Your PDF is ready" })).toBeVisible();
    await expect(page.getByText("Converted on this device. Your file never left it.")).toBeVisible();
    await expect(page.getByTestId("conversion-notes")).toBeVisible(); // the hidden slide is reported, not silently dropped
    const file = await downloadResult(page);
    expect(file.name).toBe("Quarterly review.pdf");
    const texts = await pageTexts(file.bytes);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("Quarterly review");
    expect(texts[0]).toContain("Revenue grew");
    expect(texts[1]).toContain("Second slide with a link");
    expect(requests.filter((entry) => entry.startsWith("POST"))).toEqual([]);
  });
});

test.describe("Compress with Ghostscript on the server", () => {
  const photoPdf = async () => {
    const { jpegPage, photoJpeg } = await import("../unit/helpers/pdfImages");
    return jpegPage(photoJpeg(1200, 900), 400, 300, "Scan");
  };

  test("offers the server level only because the server has Ghostscript, and keeps its result when it is smaller", async ({ page }) => {
    await page.goto("/tools/compress");
    await addFiles(page, [{ name: "scan.pdf", bytes: withMarker(await photoPdf(), "FAKE:SHRINK") }]);
    await expect(page.getByTestId("level-server")).toBeEnabled();
    await page.getByTestId("level-server").check();
    await page.getByRole("radio", { name: "Smallest (72 dpi)" }).check();
    await page.getByTestId("compress-button").click();
    await expect(page.getByRole("heading", { name: "Your compressed PDF is ready" })).toBeVisible();
    const row = page.getByTestId("savings-row");
    await expect(row).toContainText("% smaller");
    await row.getByText("What was done").click();
    await expect(row).toContainText("Compressed by Ghostscript on your server (screen");
    const file = await downloadResult(page);
    expect(file.name).toBe("scan_compressed.pdf");
    expect((await renderPdfPage(file.bytes, 1, 1)).width).toBe(400); // same page, same size
  });

  test("keeps the original when Ghostscript cannot make it smaller", async ({ page }) => {
    await page.goto("/tools/compress");
    await addFiles(page, [{ name: "scan.pdf", bytes: await photoPdf() }]); // the test double copies the file: no gain
    await page.getByTestId("level-server").check();
    await page.getByTestId("compress-button").click();
    await expect(page.getByTestId("no-reduction")).toBeVisible();
    await expect(page.getByTestId("savings-row")).toContainText("No reduction");
  });

  test("reports a Ghostscript failure for that file", async ({ page }) => {
    await page.goto("/tools/compress");
    await addFiles(page, [{ name: "scan.pdf", bytes: withMarker(await photoPdf(), "FAKE:FAIL") }]);
    await page.getByTestId("level-server").check();
    await page.getByTestId("compress-button").click();
    await expect(page.getByTestId("savings-row")).toContainText("Failed");
    await expect(page.getByTestId("savings-row")).toContainText("could not process this file");
  });

  test("is not offered when the server has no Ghostscript", async ({ page }) => {
    await page.route("**/api/capabilities", (route) =>
      route.fulfill({ json: { version: "1.0.0", limits: { maxUploadBytes: 2097152 }, engines: { libreoffice: { available: true }, ghostscript: { available: false, reason: "Ghostscript is not installed." } } } }),
    );
    await page.goto("/tools/compress");
    await addFiles(page, [{ name: "scan.pdf", bytes: await photoPdf() }]);
    await expect(page.getByTestId("level-server")).toHaveCount(0);
    await expect(page.getByRole("radiogroup", { name: "Compression level" }).getByRole("radio")).toHaveCount(4);
  });
});
