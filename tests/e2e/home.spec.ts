import { TOOLS } from "../../src/config/tools";
import { expect, test } from "./fixtures";

test.describe("home page and catalog", () => {
  test("shows the brand, the hero and every tool", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/LanternPDF/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Every PDF tool you need");
    await expect(page.getByTestId("tool-grid").getByRole("link")).toHaveCount(TOOLS.length);
  });

  test("searching filters the catalog and the URL keeps the query", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("searchbox", { name: "Search PDF tools" }).fill("merge");
    const cards = page.getByTestId("tool-grid").getByRole("link");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("Merge PDF");
    await expect(page).toHaveURL(/q=merge/);

    await page.getByRole("searchbox", { name: "Search PDF tools" }).fill("zzzznothing");
    await expect(page.getByText("No tool matches")).toBeVisible();
    await page.getByRole("button", { name: "Show all tools" }).click();
    await expect(page.getByTestId("tool-grid").getByRole("link")).toHaveCount(TOOLS.length);
  });

  test("keyword search finds tools by what people call them", async ({ page }) => {
    await page.goto("/");
    const search = page.getByRole("searchbox", { name: "Search PDF tools" });
    await search.fill("password");
    const names = await page.getByTestId("tool-grid").getByRole("link").allInnerTexts();
    expect(names.join(" ")).toContain("Protect PDF");
    expect(names.join(" ")).toContain("Unlock PDF");
  });

  test("category chips filter and stay in sync with the URL", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Security & info" }).click();
    await expect(page).toHaveURL(/category=security/);
    const count = TOOLS.filter((tool) => tool.category === "security").length;
    await expect(page.getByTestId("tool-grid").getByRole("link")).toHaveCount(count);
    await expect(page.getByRole("button", { name: "Security & info" })).toHaveAttribute("aria-pressed", "true");
  });

  test("the theme can be switched and is remembered", async ({ page }) => {
    await page.goto("/");
    const html = page.locator("html");
    await page.getByRole("button", { name: /Switch to (dark|light) theme/ }).click();
    const first = await html.getAttribute("data-theme");
    expect(["dark", "light"]).toContain(first);
    await page.reload();
    await expect(html).toHaveAttribute("data-theme", first as string);
    // back to following the system
    await page.getByRole("radio", { name: "System" }).check();
    await expect(html).not.toHaveAttribute("data-theme", /.+/);
  });

  test("Ctrl+K opens the command palette and Enter opens the tool", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Find a tool" });
    await expect(palette).toBeVisible();
    await palette.getByRole("combobox").fill("split");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/tools\/split$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Split PDF");
  });

  test("the all-tools menu lists every category", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "All tools" }).click();
    const menu = page.locator("#mega-menu");
    for (const heading of ["Organize", "Optimize", "Convert to PDF", "Convert from PDF", "Edit", "Security & info"]) {
      await expect(menu.getByRole("heading", { name: heading })).toBeVisible();
    }
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });

  test("unknown routes show a helpful page", async ({ page }) => {
    await page.goto("/tools/does-not-exist");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("That page does not exist");
  });

  test("makes no requests to other origins", async ({ page }) => {
    const external: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (!["127.0.0.1", "localhost"].includes(url.hostname) && url.protocol.startsWith("http")) external.push(request.url());
    });
    await page.goto("/");
    await page.goto("/tools/merge");
    await page.waitForLoadState("networkidle");
    expect(external).toEqual([]);
  });
});
