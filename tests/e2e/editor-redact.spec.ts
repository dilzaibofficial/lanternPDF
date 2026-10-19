import { fixtureBytes } from "../fixtures/build";
import { renderPdfPage } from "../unit/helpers/images";
import { pageTexts } from "../unit/helpers/pdf";
import { analyze, chooseTool, downloadAs, openFixture, panelTitle, waitForObjects } from "./editorHelpers";
import { expect, test } from "./fixtures";

// Redaction removes what is under a box from the file. A cover box only hides it. The two must never be confused.

test.use({ viewport: { width: 1440, height: 900 } });

const px = (points: number) => points * 2;

test.describe("redaction", () => {
  test("removes the words under a box from the downloaded file, not just from view", async ({ page }) => {
    const sheet = await openFixture(page, "objects.pdf");
    await waitForObjects(page);
    await chooseTool(page, "redact");
    await expect(page.getByTestId("properties")).toContainText("removed from the file");
    await sheet.drag([65, 273], [160, 292]); // over "Boxed line two"
    await expect(panelTitle(page)).toHaveText("Redaction");

    await page.getByTestId("download-as").click();
    await expect(page.getByTestId("export-dialog")).toContainText("Redaction is permanent");
    await expect(page.getByTestId("redact-properties")).toBeChecked();
    await page.getByTestId("export-name").fill("redacted");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-start").click()]);
    await expect(page.getByTestId("redaction-result")).toContainText("removed from the file");
    await expect(page.getByTestId("redaction-result")).toContainText("Checked afterwards");
    const bytes = new Uint8Array((await import("node:fs")).readFileSync((await download.path()) as string));

    const text = (await pageTexts(bytes))[0] ?? "";
    expect(text).toContain("Boxed line one");
    expect(text).not.toContain("Boxed line two");
    // Not in the content at all: the second line's letters are not found by the editor's own reader either.
    expect((await analyze(bytes)).lines.map((l) => l.text)).not.toContain("Boxed line two");
    const rendered = await renderPdfPage(bytes, 1, 2);
    expect(rendered.at(px(100), px(282))[0]).toBeLessThan(30); // a black box where the words were
  });

  test("a cover box only hides: its words are still in the file, and the dialog says so", async ({ page }) => {
    const sheet = await openFixture(page, "objects.pdf");
    await waitForObjects(page);
    await chooseTool(page, "cover");
    await sheet.drag([65, 273], [160, 292]);
    await page.getByTestId("download-as").click();
    await expect(page.getByTestId("export-dialog")).toContainText("Cover boxes do not remove anything");
    await page.getByTestId("export-name").fill("covered");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-start").click()]);
    const bytes = new Uint8Array((await import("node:fs")).readFileSync((await download.path()) as string));
    expect((await pageTexts(bytes))[0]).toContain("Boxed line two"); // still there, only covered
  });

  test("blanks the covered part of a picture and keeps the rest of it", async ({ page }) => {
    const sheet = await openFixture(page, "objects.pdf");
    await waitForObjects(page);
    await chooseTool(page, "redact");
    await sheet.drag([280, 172], [340, 200]);
    const file = await downloadAs(page, "redacted-picture");
    const r = await renderPdfPage(file.bytes, 1, 2);
    expect(r.at(px(310), px(190))[0]).toBeLessThan(30); // the covered part is black
    expect(r.at(px(240), px(190))[2]).toBeGreaterThan(150); // the rest of the picture is still blue-ish
    expect((await analyze(file.bytes)).objects.filter((o) => o.kind === "image")).toHaveLength(1);
  });

  test("finds every match of a word and puts a redaction box over each", async ({ page }) => {
    await openFixture(page, "pdfkit-standard.pdf");
    await page.keyboard.press("Control+f");
    await page.getByTestId("find-input").fill("Annual");
    await expect(page.getByTestId("find-count")).toContainText("1");
    await page.getByTestId("redact-matches").click();
    await expect(page.getByTestId("notice")).toContainText("redaction box");
    const file = await downloadAs(page, "no-annual");
    const text = (await pageTexts(file.bytes))[0] ?? "";
    expect(text).not.toContain("Annual");
    expect(text).toContain("Report"); // only the match was removed
    expect(new TextDecoder("latin1").decode(file.bytes)).not.toContain("Annual");
  });

  test("clears the document's properties and bookmarks along with the redaction unless told not to", async ({ page }) => {
    const sheet = await openFixture(page, "pdfkit-standard.pdf");
    await waitForObjects(page);
    await chooseTool(page, "redact");
    await sheet.drag([60, 40], [200, 70]);
    await page.getByTestId("download-as").click();
    await page.getByTestId("redact-properties").uncheck();
    await page.getByTestId("export-name").fill("keep-props");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-start").click()]);
    const kept = new Uint8Array((await import("node:fs")).readFileSync((await download.path()) as string));
    expect(new TextDecoder("latin1").decode(kept)).toContain("Fixture"); // the title the fixture carries
    await page.getByTestId("export-done").click();

    const cleared = await downloadAs(page, "clear-props");
    expect(new TextDecoder("latin1").decode(cleared.bytes)).not.toContain("Fixture");
    void fixtureBytes;
  });
});
