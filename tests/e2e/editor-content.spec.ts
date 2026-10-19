import { isRed, isWhite, inkBounds, makeImage, renderPdfPage } from "../unit/helpers/images";
import { makeTextPdf, pageTexts } from "../unit/helpers/pdf";
import { fixtureBytes } from "../fixtures/build";
import { Sheet, analyze, chooseTool, downloadAs, geometry, openEditor, openFixture, panelTitle, snapOff, waitForObjects } from "./editorHelpers";
import { expect, test } from "./fixtures";

// Adding things to a page (text, shapes, pictures, markup), changing the words that are already there, and what lands where.

test.use({ viewport: { width: 1440, height: 1000 } });

const PAGE_W = 400;
const PAGE_H = 300;
const px = (points: number) => points * 2;
const baseDoc = (pages = 1) => makeTextPdf("Base", pages, [PAGE_W, PAGE_H]);

test.describe("adding things", () => {
  test("adds text where you click, and writes it into the PDF at that spot", async ({ page }) => {
    const sheet = await openEditor(page, await baseDoc());
    await expect(page.getByTestId("save-status")).toContainText("No changes yet");
    await chooseTool(page, "text");
    await sheet.click(100, 200);
    await expect(page.getByTestId("text-editor")).toBeFocused();
    await page.keyboard.type("Hello editor");
    await page.keyboard.press("Control+Enter");
    await expect(panelTitle(page)).toHaveText("Text box");
    await expect(page.getByTestId("tool-select")).toHaveAttribute("aria-pressed", "true"); // back to Select after placing text
    await expect(page.getByTestId("save-status")).toContainText("Unsaved changes");

    const file = await downloadAs(page, "with-text");
    expect(file.name).toBe("with-text.pdf");
    const [content] = await pageTexts(file.bytes);
    expect(content).toContain("Base p1"); // the page's own text is untouched
    expect(content).toContain("Hello editor");
    const ink = inkBounds(await renderPdfPage(file.bytes, 1, 2), isWhite, { x0: px(90), y0: px(185), x1: px(300), y1: px(230) });
    expect(ink.count).toBeGreaterThan(100);
    expect(Math.abs(ink.minX - px(100))).toBeLessThan(px(8));
    await expect(page.getByTestId("save-status")).toContainText("Downloaded");
  });

  test("draws shapes, lines and cover boxes by dragging, and they land where they were drawn", async ({ page }) => {
    const sheet = await openEditor(page, await baseDoc());
    await chooseTool(page, "rect");
    await sheet.drag([40, 40], [140, 100]);
    await page.getByRole("button", { name: "Fill: #dc2626" }).click();
    await chooseTool(page, "ellipse");
    await sheet.drag([200, 40], [300, 100]);
    await page.getByRole("button", { name: "Fill: #2563eb" }).click();
    await chooseTool(page, "line");
    await sheet.drag([40, 250], [300, 250]);
    await chooseTool(page, "cover");
    await sheet.drag([150, 200], [260, 230]);
    await expect(page.getByTestId("properties")).toContainText("stays in the file");

    const file = await downloadAs(page, "shapes");
    const r = await renderPdfPage(file.bytes, 1, 2);
    expect(isRed(r.at(px(90), px(70)))).toBe(true);
    const [br, bg, bb] = r.at(px(250), px(70)); // #2563eb
    expect(br).toBeLessThan(80);
    expect(bg).toBeGreaterThan(70);
    expect(bg).toBeLessThan(130);
    expect(bb).toBeGreaterThan(200);
    expect(isWhite(r.at(px(250), px(215)))).toBe(true); // the cover box is white
    expect(isWhite(r.at(px(170), px(250)))).toBe(false); // the line
  });

  test("a cover box says it hides but does not remove, in the editor and in the download dialog", async ({ page }) => {
    const sheet = await openEditor(page, await baseDoc());
    await chooseTool(page, "cover");
    await sheet.drag([20, 130], [380, 170]);
    await page.getByTestId("download-as").click();
    await expect(page.getByTestId("export-dialog")).toContainText("Cover boxes do not remove anything");
    await expect(page.getByTestId("export-dialog")).toContainText("Redact");
  });

  test("the pen stays on for the next stroke, and each stroke is one step that undo takes back", async ({ page }) => {
    const sheet = await openEditor(page, await baseDoc());
    await chooseTool(page, "draw");
    await sheet.stroke([[40, 40], [100, 80], [160, 40]]);
    await expect(page.getByTestId("tool-draw")).toHaveAttribute("aria-pressed", "true");
    await sheet.stroke([[200, 200], [260, 240], [320, 200]]);
    await page.getByTestId("history").click();
    await expect(page.getByTestId("history-steps")).toContainText("Add draw");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await expect(page.getByTestId("undo")).toBeDisabled();
    await expect(page.getByTestId("save-status")).toContainText("No changes yet");
  });

  test("selects, moves, resizes, nudges and deletes something added", async ({ page }) => {
    const sheet = await openEditor(page, await baseDoc());
    await snapOff(page);
    await chooseTool(page, "rect");
    await sheet.drag([100, 100], [200, 160]);
    expect(await geometry(page)).toMatchObject({ x: 100, y: 100, w: 100, h: 60 });
    // An outline-only rectangle is picked by its edge (away from the handles), so the drag starts on the top edge.
    await sheet.drag([130, 100], [160, 130]);
    expect(await geometry(page)).toMatchObject({ x: 130, y: 130, w: 100, h: 60 });
    await sheet.dragHandle(page.getByTestId("handle-se"), [260, 220]);
    expect(await geometry(page)).toMatchObject({ x: 130, y: 130, w: 130, h: 90 });
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    await expect.poll(async () => (await geometry(page)).x).toBe(131);
    expect((await geometry(page)).y).toBe(140);
    await page.keyboard.press("Delete");
    await expect(panelTitle(page)).toHaveText("Document");
  });

  test("undo and redo step back and forth from the buttons and the keyboard", async ({ page }) => {
    const sheet = await openEditor(page, await baseDoc());
    await chooseTool(page, "rect");
    await sheet.drag([100, 100], [200, 160]);
    await expect(page.getByTestId("undo")).toBeEnabled();
    await page.getByTestId("undo").click();
    await expect(panelTitle(page)).toHaveText("Document");
    await expect(page.getByTestId("redo")).toBeEnabled();
    await page.getByTestId("redo").click();
    await sheet.click(150, 100);
    await expect(panelTitle(page)).toHaveText("Rectangle");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+Shift+z");
    await page.keyboard.press("Control+y");
    await expect(page.getByTestId("redo")).toBeDisabled();
  });

  test("copies, pastes and duplicates what was added, and keeps the copy a little apart", async ({ page }) => {
    const sheet = await openEditor(page, await baseDoc());
    await snapOff(page);
    await chooseTool(page, "rect");
    await sheet.drag([100, 100], [200, 160]);
    await page.keyboard.press("Control+c");
    await page.keyboard.press("Control+v");
    expect(await geometry(page)).toMatchObject({ x: 114, y: 114 });
    await page.keyboard.press("Control+d");
    expect(await geometry(page)).toMatchObject({ x: 126, y: 126 });
    await sheet.click(10, 290);
    await page.waitForTimeout(450); // not a double-click
    await sheet.drag([20, 20], [380, 280]);
    // The three rectangles and the page's own line of text, which the frame holds whole.
    await expect(panelTitle(page)).toHaveText("4 objects");
  });

  test("adds a picture from a file and refuses a file that is not a picture", async ({ page }) => {
    await openEditor(page, await baseDoc());
    await page.getByTestId("image-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not an image") });
    await expect(page.getByTestId("notice")).toContainText(/image|picture|PNG|JPG/i);
    await page.getByTestId("image-input").setInputFiles({ name: "halves.png", mimeType: "image/png", buffer: Buffer.from(makeImage("png", 40, 20)) });
    await expect(panelTitle(page)).toHaveText("Image");
    const file = await downloadAs(page, "with-picture");
    const r = await renderPdfPage(file.bytes, 1, 2);
    expect((await analyze(file.bytes)).objects.filter((o) => o.kind === "image")).toHaveLength(1);
    expect(inkBounds(r, isWhite).count).toBeGreaterThan(500);
  });

  test("puts things on the page they were drawn on in a longer document", async ({ page }) => {
    const sheet = await openEditor(page, await baseDoc(3));
    void sheet;
    const second = new Sheet(page, 2);
    await second.reveal();
    await chooseTool(page, "rect");
    await second.drag([100, 100], [200, 160]);
    await page.getByRole("button", { name: "Fill: #dc2626" }).click();
    const file = await downloadAs(page, "page-two");
    expect(isRed((await renderPdfPage(file.bytes, 2, 2)).at(px(150), px(130)))).toBe(true);
    expect(isRed((await renderPdfPage(file.bytes, 1, 2)).at(px(150), px(130)))).toBe(false);
    expect(isRed((await renderPdfPage(file.bytes, 3, 2)).at(px(150), px(130)))).toBe(false);
  });

  test("places things where the viewer shows them on a rotated page with a crop", async ({ page }) => {
    const sheet = await openFixture(page, "pdflib-rotated.pdf");
    await chooseTool(page, "rect");
    await sheet.drag([20, 20], [80, 60]);
    await page.getByRole("button", { name: "Fill: #dc2626" }).click();
    const file = await downloadAs(page, "rotated");
    const r = await renderPdfPage(file.bytes, 1, 2);
    // The viewer shows this page turned a quarter: the box lands at the top-left of what is shown.
    expect(isRed(r.at(px(50), px(40)))).toBe(true);
    expect(isRed(r.at(px(300), px(200)))).toBe(false);
  });

  test("zooming does not change where things end up", async ({ page }) => {
    const sheet = await openEditor(page, await baseDoc());
    await snapOff(page);
    await chooseTool(page, "rect");
    await page.getByTestId("zoom-in").click();
    await page.getByTestId("zoom-in").click();
    await sheet.drag([100, 100], [180, 150]);
    expect(await geometry(page)).toMatchObject({ x: 100, y: 100, w: 80, h: 50 });
    await page.getByTestId("zoom-out").click();
    await page.getByTestId("zoom-out").click();
    await page.getByTestId("zoom-out").click();
    await sheet.drag([120, 100], [140, 120]);
    expect(await geometry(page)).toMatchObject({ x: 120, y: 120 });
  });
});

test.describe("the words that are already on the page", () => {
  test("changes a line by double-clicking it, in place, and a removed word is gone from the file", async ({ page }) => {
    const sheet = await openFixture(page, "pdfkit-standard.pdf");
    await waitForObjects(page);
    const analysis = await analyze(fixtureBytes("pdfkit-standard.pdf"));
    const title = analysis.lines.find((l) => l.text === "Annual Report")!;
    await sheet.doubleClick(title.box.x + 20, title.box.y + title.box.height / 2);
    await expect(page.getByTestId("line-editor")).toHaveValue("Annual Report");
    await page.getByTestId("line-editor").fill("Annual Summary");
    await page.getByTestId("line-editor").press("Enter");
    await expect(page.getByTestId("save-status")).toContainText("Unsaved changes");
    const file = await downloadAs(page, "summary");
    const texts = (await pageTexts(file.bytes))[0] ?? "";
    expect(texts).toContain("Annual Summary");
    expect(texts).not.toContain("Annual Report");
    expect(new TextDecoder("latin1").decode(file.bytes)).not.toContain("Annual Report");
  });

  test("the Edit text tool edits a line with one click, and Escape leaves it as it was", async ({ page }) => {
    const sheet = await openFixture(page, "pdfkit-standard.pdf");
    await waitForObjects(page);
    const title = (await analyze(fixtureBytes("pdfkit-standard.pdf"))).lines.find((l) => l.text === "Annual Report")!;
    await chooseTool(page, "edit-text");
    await sheet.click(title.box.x + 20, title.box.y + title.box.height / 2);
    await expect(page.getByTestId("line-editor")).toBeVisible();
    await page.getByTestId("line-editor").fill("Something else");
    await page.getByTestId("line-editor").press("Escape");
    await expect(page.getByTestId("save-status")).toContainText("No changes yet");
  });

  test("emptying a line removes it, and letters from other alphabets are kept", async ({ page }) => {
    const sheet = await openFixture(page, "pdfkit-standard.pdf");
    await waitForObjects(page);
    const lines = (await analyze(fixtureBytes("pdfkit-standard.pdf"))).lines;
    const title = lines.find((l) => l.text === "Annual Report")!;
    const sub = lines.find((l) => l.text === "Revenue   1,204,000")!;
    await sheet.doubleClick(title.box.x + 20, title.box.y + title.box.height / 2);
    await page.getByTestId("line-editor").fill("");
    await page.getByTestId("line-editor").press("Enter");
    await sheet.doubleClick(sub.box.x + 20, sub.box.y + sub.box.height / 2);
    await page.getByTestId("line-editor").fill("Revenue   café ñ 1,204,000");
    await page.getByTestId("line-editor").press("Enter");
    const file = await downloadAs(page, "edited-lines");
    const texts = (await pageTexts(file.bytes))[0] ?? "";
    expect(texts).not.toContain("Annual Report");
    expect(texts).toContain("café ñ");
  });

  test("changes the look of a line from the properties panel, and says which font was used", async ({ page }) => {
    const sheet = await openFixture(page, "pdfkit-standard.pdf");
    await waitForObjects(page);
    const title = (await analyze(fixtureBytes("pdfkit-standard.pdf"))).lines.find((l) => l.text === "Annual Report")!;
    await sheet.doubleClick(title.box.x + 20, title.box.y + title.box.height / 2);
    await page.getByTestId("line-editor").fill("Annual Summary");
    await page.getByTestId("line-editor").press("Enter");
    await expect(page.getByTestId("line-outcome")).toContainText(/Edited in place|checked/, { timeout: 20_000 });
    await page.getByTestId("line-italic").click();
    await expect(page.getByTestId("line-outcome")).toContainText(/Redrawn partly in/i, { timeout: 20_000 });
  });

  test("finds text across the document and replaces it", async ({ page }) => {
    await openFixture(page, "pdfkit-standard.pdf");
    await page.keyboard.press("Control+f");
    await page.getByTestId("find-input").fill("Annual");
    await expect(page.getByTestId("find-count")).toContainText("1");
    await page.getByTestId("find-replace-toggle").click();
    await page.getByTestId("replace-input").fill("Yearly");
    await page.getByTestId("replace-all").click();
    await expect(page.getByTestId("notice")).toContainText("Replaced");
    const file = await downloadAs(page, "yearly");
    expect((await pageTexts(file.bytes))[0]).toContain("Yearly Report");
  });
});
