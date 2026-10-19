import { isBlue, isRed, isWhite, makeImage, renderPdfPage } from "../unit/helpers/images";
import { pageTexts } from "../unit/helpers/pdf";
import { analyze, chooseTool, downloadAs, geometry, openFixture, panelTitle, snapOff, waitForObjects } from "./editorHelpers";
import { expect, test } from "./fixtures";

// Lining things up, stacking them, drawing them behind the page, grouping them and merging them into the page. All of it
// works the same for a picture that was added and for one the page already had.

test.use({ viewport: { width: 1440, height: 900 } });

const px = (points: number) => points * 2;
const isYellow = ([r, g, b]: number[]) => (r as number) > 230 && (g as number) > 180 && (g as number) < 225 && (b as number) < 60;

test.describe("aligning", () => {
  test("lines one thing up with the page: left, centre, right, top, middle and bottom", async ({ page }) => {
    const sheet = await openFixture(page, "objects.pdf");
    await waitForObjects(page);
    await sheet.click(280, 190); // the picture: 220, 140, 120 × 60 on a 400 × 500 page
    await expect(panelTitle(page)).toHaveText("Image on the page");
    const read = async () => {
      const g = await geometry(page);
      return [g.x, g.y];
    };

    await page.getByTestId("align-left").click();
    await expect.poll(read).toEqual([0, 140]);
    await page.getByTestId("align-right").click();
    await expect.poll(read).toEqual([280, 140]);
    await page.getByTestId("align-centre").click();
    await expect.poll(read).toEqual([140, 140]);
    await page.getByTestId("align-top").click();
    await expect.poll(read).toEqual([140, 0]);
    await page.getByTestId("align-bottom").click();
    await expect.poll(read).toEqual([140, 440]);
    await page.getByTestId("align-middle").click();
    await expect.poll(read).toEqual([140, 220]);

    await page.getByTestId("align-left").click();
    await page.getByTestId("align-top").click();
    await page.getByTestId("align-page-centre").click();
    await expect.poll(read).toEqual([140, 220]);
  });

  test("lines several things up with each other, or moves them together against the page, and spaces them evenly", async ({ page }) => {
    const sheet = await openFixture(page, "objects.pdf");
    await waitForObjects(page);
    await sheet.drag([30, 105], [370, 215]); // the triangle, the picture and the orange square
    await expect(panelTitle(page)).toHaveText("3 objects");

    await page.getByTestId("distribute-x").click();
    await page.getByTestId("align-to-selection").click();
    await page.getByTestId("align-top").click();
    const file = await downloadAs(page, "aligned");
    const objects = (await analyze(file.bytes)).objects;
    const triangle = objects.find((o) => o.label === "Triangle")!;
    const picture = objects.find((o) => o.kind === "image")!;
    const orange = objects.find((o) => o.label === "Rectangle" && Math.abs(o.box.width - 60) < 1)!;
    // Spaced evenly across 60…360 (10 points between each), then lined up along the top edge of the group.
    expect(picture.box.x).toBeCloseTo(170, 0);
    expect(triangle.box.y).toBeCloseTo(120, 0);
    expect(picture.box.y).toBeCloseTo(120, 0);
    expect(orange.box.y).toBeCloseTo(120, 0);
  });

  test("against the page a selection moves as one and keeps its shape", async ({ page }) => {
    const sheet = await openFixture(page, "objects.pdf");
    await waitForObjects(page);
    await sheet.drag([30, 105], [370, 215]);
    await page.getByTestId("align-left").click();
    const file = await downloadAs(page, "left");
    const objects = (await analyze(file.bytes)).objects;
    // Everything moved left by the same 60 (the group's left edge was at 60).
    expect(objects.find((o) => o.label === "Triangle")?.box.x).toBeCloseTo(0, 0);
    expect(objects.find((o) => o.kind === "image")?.box.x).toBeCloseTo(160, 0);
  });
});

test.describe("the order things are stacked in", () => {
  test("sends the orange square behind the picture, then brings it back to the front", async ({ page }) => {
    const sheet = await openFixture(page, "objects.pdf");
    await waitForObjects(page);
    await sheet.click(350, 125);
    await expect(panelTitle(page)).toHaveText("Rectangle on the page");
    await page.getByTestId("z-back").click();
    const behind = await downloadAs(page, "behind");
    const a = await renderPdfPage(behind.bytes, 1, 2);
    // Where the square overlapped the picture the picture shows now; its free part is still orange.
    expect(isRed(a.at(px(320), px(160)))).toBe(false);
    expect(a.at(px(320), px(160))[2]).toBeGreaterThan(100);
    expect(a.at(px(350), px(130))[0]).toBeGreaterThan(200);

    await sheet.click(350, 125);
    await page.getByTestId("z-front").click();
    const front = await downloadAs(page, "front");
    const b = await renderPdfPage(front.bytes, 1, 2);
    expect(b.at(px(320), px(160))[0]).toBeGreaterThan(200); // orange again
    expect(b.at(px(320), px(160))[2]).toBeLessThan(80);
  });

  test("text can be moved and removed but is not stacked: those buttons say why", async ({ page }) => {
    const sheet = await openFixture(page, "objects.pdf");
    await waitForObjects(page);
    await sheet.click(100, 262);
    await expect(panelTitle(page)).toHaveText("Text on the page");
    await expect(page.getByTestId("z-front")).toBeDisabled();
    await expect(page.getByTestId("z-front")).toHaveAttribute("title", /not placed above or below/);
  });
});

test.describe("behind the page, as a background, grouped and merged", () => {
  test("a rectangle drawn behind the page is under the page's own graphics, and in front it hides them", async ({ page }) => {
    const sheet = await openFixture(page, "objects.pdf");
    await waitForObjects(page);
    await chooseTool(page, "rect");
    await sheet.drag([5, 5], [395, 495]);
    await expect(panelTitle(page)).toHaveText("Rectangle");
    await page.getByRole("button", { name: "Fill: #facc15" }).click();

    await page.getByTestId("layer-behind").click();
    await expect(page.getByTestId("behind-layer")).toHaveCount(1);
    const behind = await downloadAs(page, "yellow-behind");
    const a = await renderPdfPage(behind.bytes, 1, 2);
    expect(isYellow(a.at(px(30), px(480)))).toBe(true); // empty paper shows the yellow
    expect(a.at(px(100), px(400))[1]).toBeGreaterThan(130); // the page's green rectangle is in front of it
    expect(a.at(px(100), px(400))[0]).toBeLessThan(60);

    await page.getByTestId("layer-front").click();
    await expect(page.getByTestId("behind-layer")).toHaveCount(0);
    const front = await downloadAs(page, "yellow-front");
    const b = await renderPdfPage(front.bytes, 1, 2);
    expect(isYellow(b.at(px(100), px(400)))).toBe(true); // now it covers the green rectangle
  });

  test("a picture can become the background of the page: it fills the page, behind everything", async ({ page }) => {
    await openFixture(page, "objects.pdf");
    await waitForObjects(page);
    await page.getByTestId("image-input").setInputFiles({ name: "wash.png", mimeType: "image/png", buffer: Buffer.from(makeImage("png", 40, 20)) });
    await expect(panelTitle(page)).toHaveText("Image");
    await page.getByTestId("bg-set").click();
    await expect.poll(() => geometry(page)).toMatchObject({ x: 0, y: 0, w: 400, h: 500 });
    await expect(page.getByTestId("behind-layer")).toHaveCount(1);

    const file = await downloadAs(page, "with-background");
    const r = await renderPdfPage(file.bytes, 1, 2);
    expect(isRed(r.at(px(60), px(20)))).toBe(true); // the left half of the picture is red…
    expect(isBlue(r.at(px(340), px(20)))).toBe(true); // …the right half is blue
    expect(r.at(px(100), px(400))[1]).toBeGreaterThan(130); // the page's green rectangle is still on top
    expect((await pageTexts(file.bytes))[0]).toContain("Objects page"); // and so is its text
    // The picture was not stretched: 40 × 20 kept its shape by being cropped to the page's 4:5.
    expect(isWhite(r.at(px(200), px(250)))).toBe(false);
  });

  test("grouped things are picked, moved and let go together", async ({ page }) => {
    const sheet = await openFixture(page, "objects.pdf");
    await waitForObjects(page);
    await snapOff(page);
    await chooseTool(page, "rect");
    await sheet.drag([20, 20], [60, 50]);
    await chooseTool(page, "rect");
    await sheet.drag([300, 20], [340, 50]);
    await chooseTool(page, "select");
    await sheet.click(20, 35); // the first rectangle's edge
    await page.keyboard.down("Shift");
    await sheet.click(300, 35);
    await page.keyboard.up("Shift");
    await expect(panelTitle(page)).toHaveText("2 objects");
    await page.getByTestId("group").click();

    await sheet.click(0, 480); // nothing there: deselect
    await sheet.click(20, 35);
    await expect(panelTitle(page)).toHaveText("2 objects");
    await sheet.drag([20, 35], [20, 75]);
    await page.getByTestId("ungroup").click();
    await sheet.click(0, 480);
    await sheet.click(20, 75);
    await expect(panelTitle(page)).toHaveText("Rectangle");
    await expect.poll(async () => (await geometry(page)).y).toBeCloseTo(60, 0);
  });

  test("merging makes what was added part of the page: it can then be picked like the rest of the page", async ({ page }) => {
    const sheet = await openFixture(page, "objects.pdf");
    await waitForObjects(page);
    await chooseTool(page, "text");
    await sheet.click(40, 470);
    await page.getByTestId("text-editor").fill("Merged words");
    await page.keyboard.press("Control+Enter");
    await expect(panelTitle(page)).toHaveText("Text box");
    await page.getByTestId("merge-into-page").click();
    await expect(page.getByTestId("notice")).toContainText("part of the page");

    // It is page text now: the block of text can be picked and the line can be edited as the page's own.
    await expect.poll(async () => (await page.locator(".ed-panel__head h2").first().textContent()) ?? "").toBe("Document");
    await sheet.doubleClick(60, 476);
    await expect(page.getByTestId("line-editor")).toBeVisible();
    await expect(page.getByTestId("line-editor")).toHaveValue("Merged words");
    await page.getByTestId("line-editor").fill("Merged words!");
    await page.getByTestId("line-editor").press("Enter");
    const file = await downloadAs(page, "merged");
    expect((await pageTexts(file.bytes))[0]).toContain("Merged words!");
    expect((await analyze(file.bytes)).lines.map((l) => l.text)).toContain("Merged words!");
  });
});
