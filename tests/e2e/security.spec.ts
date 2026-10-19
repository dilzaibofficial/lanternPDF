import { probePdf } from "../../src/lib/pdf/inspect";
import { withQpdf } from "../../src/lib/pdf/qpdf";
import { protectPdf } from "../../src/lib/pdf/security";
import { makeTextPdf, pageTexts } from "../unit/helpers/pdf";
import { addFiles, expect, test } from "./fixtures";
import { downloadResult } from "./helpers";

const describeEncryption = (bytes: Uint8Array, password: string) =>
  withQpdf((qpdf) => qpdf.run([`--password=${password}`, "--show-encryption", qpdf.put(bytes)]).output.join("\n"));

test.describe("Protect PDF", () => {
  test("encrypts the file: it needs the password, and the preview works with it", async ({ page }) => {
    await page.goto("/tools/protect");
    await addFiles(page, [{ name: "report.pdf", bytes: await makeTextPdf("S", 2) }]);

    const run = page.getByTestId("run-button");
    await expect(run).toBeDisabled();
    await page.getByLabel("Password", { exact: true }).fill("correct horse");
    await page.getByLabel("Confirm password").fill("something else");
    await expect(page.getByText("The passwords do not match.")).toBeVisible();
    await expect(run).toBeDisabled();

    await page.getByLabel("Confirm password").fill("correct horse");
    await expect(run).toBeEnabled();
    await run.click();

    await expect(page.getByRole("heading", { name: "Your protected PDF is ready" })).toBeVisible();
    await expect(page.getByTestId("result-stats")).toContainText("AES-256");
    await expect(page.getByText("Keep the password safe")).toBeVisible();
    await expect(page.getByTestId("viewer-canvas")).toBeVisible(); // preview opened with the password

    const file = await downloadResult(page);
    expect(file.name).toBe("report_protected.pdf");
    expect(await probePdf(file.bytes)).toMatchObject({ state: "needs-password" });
    expect(await probePdf(file.bytes, "wrong")).toMatchObject({ state: "wrong-password" });
    expect(await probePdf(file.bytes, "correct horse")).toMatchObject({ state: "ok", pageCount: 2, encrypted: true });
    expect(await pageTexts(file.bytes, "correct horse")).toEqual(["S p1", "S p2"]);
  });

  test("applies the permission options", async ({ page }) => {
    await page.goto("/tools/protect");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("S", 1) }]);
    await page.getByLabel("Password", { exact: true }).fill("pw");
    await page.getByLabel("Confirm password").fill("pw");
    await page.getByText("Advanced options").click();
    await page.getByLabel("Owner password (optional)").fill("owner-secret");
    await page.getByRole("radio", { name: "AES-128 (older readers)" }).check();
    await page.getByLabel("Print", { exact: true }).uncheck();
    await page.getByLabel("Copy text and images").uncheck();
    await page.getByTestId("run-button").click();
    await expect(page.getByText("Readers who know only the password cannot: print, copy text")).toBeVisible();

    const file = await downloadResult(page);
    const info = await describeEncryption(file.bytes, "pw");
    expect(info).toMatch(/R = 4/);
    expect(info).toMatch(/print high resolution: not allowed/);
    expect(info).toMatch(/extract for any purpose: not allowed/);
    expect(await probePdf(file.bytes, "owner-secret")).toMatchObject({ state: "ok" });
  });

  test("handles unusual passwords such as one that starts with dashes", async ({ page }) => {
    await page.goto("/tools/protect");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("S", 1) }]);
    await page.getByLabel("Password", { exact: true }).fill("--пароль 🔑");
    await page.getByLabel("Confirm password").fill("--пароль 🔑");
    await page.getByTestId("run-button").click();
    const file = await downloadResult(page);
    expect(await probePdf(file.bytes, "--пароль 🔑")).toMatchObject({ state: "ok" });
  });

  test("can reveal what you are typing", async ({ page }) => {
    await page.goto("/tools/protect");
    await addFiles(page, [{ name: "doc.pdf", bytes: await makeTextPdf("S", 1) }]);
    const field = page.getByLabel("Password", { exact: true });
    await field.fill("visible?");
    await expect(field).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Show password" }).first().click();
    await expect(field).toHaveAttribute("type", "text");
  });
});

test.describe("Unlock PDF", () => {
  async function protectedFile(password: string, pages = 2) {
    return (await protectPdf({ name: "locked.pdf", bytes: await makeTextPdf("L", pages) }, { userPassword: password })).bytes;
  }

  test("asks for the password, then removes the protection once the user confirms", async ({ page }) => {
    await page.goto("/tools/unlock");
    await addFiles(page, [{ name: "locked.pdf", bytes: await protectedFile("open-me") }]);

    await expect(page.getByText("Password required")).toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill("nope");
    await page.getByRole("button", { name: "Open file" }).click();
    await expect(page.getByText("Incorrect password").first()).toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill("open-me");
    await page.getByRole("button", { name: "Open file" }).click();

    await expect(page.getByText("The password worked")).toBeVisible();
    const run = page.getByTestId("run-button");
    await expect(run).toBeDisabled(); // needs the authorisation checkbox
    await page.getByLabel("I own this file or have permission to remove its protection").check();
    await run.click();

    await expect(page.getByRole("heading", { name: "Your unlocked PDF is ready" })).toBeVisible();
    const file = await downloadResult(page);
    expect(file.name).toBe("locked_unlocked.pdf");
    expect(await probePdf(file.bytes)).toEqual({ state: "ok", pageCount: 2, encrypted: false });
    expect(await pageTexts(file.bytes)).toEqual(["L p1", "L p2"]);
  });

  test("tells the user a normal PDF has nothing to unlock", async ({ page }) => {
    await page.goto("/tools/unlock");
    await addFiles(page, [{ name: "plain.pdf", bytes: await makeTextPdf("P", 1) }]);
    await expect(page.getByText("This PDF is not protected")).toBeVisible();
    await expect(page.getByTestId("run-button")).toHaveCount(0);
  });

  test("removes owner-only restrictions from a PDF that opens freely", async ({ page }) => {
    const doc = await makeTextPdf("R", 1);
    const locked = await withQpdf((qpdf) => {
      const source = qpdf.put(doc);
      const target = qpdf.path();
      qpdf.run(["--encrypt", "", "owner", "256", "--print=none", "--modify=none", "--", source, target]);
      return qpdf.read(target).slice();
    });
    await page.goto("/tools/unlock");
    await addFiles(page, [{ name: "restricted.pdf", bytes: locked }]);
    await expect(page.getByText("This PDF opens without a password")).toBeVisible();
    await page.getByLabel("I own this file or have permission to remove its protection").check();
    await page.getByTestId("run-button").click();
    const file = await downloadResult(page);
    expect(await probePdf(file.bytes)).toMatchObject({ state: "ok", encrypted: false });
  });
});

test.describe("Repair PDF", () => {
  test("accepts a damaged file, repairs it and explains what happened", async ({ page }) => {
    const whole = await makeTextPdf("R", 3);
    const damaged = whole.slice(0, Buffer.from(whole).toString("latin1").lastIndexOf("startxref"));
    await page.goto("/tools/repair");
    await addFiles(page, [{ name: "broken.pdf", bytes: damaged }]);

    await expect(page.getByText("This file cannot be read as it is")).toBeVisible();
    await expect(page.getByRole("button", { name: "Try to repair this file" })).toHaveCount(0); // the tool has its own button
    await page.getByTestId("run-button").click();

    await expect(page.getByRole("heading", { name: "Your repaired PDF is ready" })).toBeVisible();
    await expect(page.getByText("The file's internal index was damaged")).toBeVisible();
    await expect(page.getByText("Content that is missing from the original file cannot be restored")).toBeVisible();
    const file = await downloadResult(page);
    expect(file.name).toBe("broken_repaired.pdf");
    expect(await pageTexts(file.bytes)).toEqual(["R p1", "R p2", "R p3"]);
  });

  test("says so when the file is already fine", async ({ page }) => {
    await page.goto("/tools/repair");
    await addFiles(page, [{ name: "fine.pdf", bytes: await makeTextPdf("F", 2) }]);
    await expect(page.getByText("This PDF opens normally")).toBeVisible();
    await page.getByTestId("run-button").click();
    await expect(page.getByText("No structural problems were found")).toBeVisible();
  });

  test("gives up honestly when nothing can be recovered", async ({ page }) => {
    await page.goto("/tools/repair");
    await addFiles(page, [{ name: "garbage.pdf", bytes: new TextEncoder().encode("%PDF-1.4\n" + "x".repeat(600)) }]);
    await page.getByTestId("run-button").click();
    await expect(page.getByTestId("error-alert")).toHaveAttribute("data-error-code", "DAMAGED_PDF");
    await expect(page.getByTestId("error-alert")).toContainText("too damaged to recover");
  });
});
