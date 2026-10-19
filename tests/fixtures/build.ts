import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PDFDocument, PDFName, StandardFonts, degrees, rgb } from "@cantoo/pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import PDFKit from "pdfkit";

/**
 * Builds the PDF fixtures the engine and editor tests run against. They are generated, not downloaded, and each
 * comes from a different producer so the engine meets different habits:
 *
 *   chromium-*   Microsoft Edge / Chromium "Print to PDF" (Skia): subset TrueType fonts as Type 0, `ToUnicode`,
 *                glyph-positioned `TJ`, rotated text via matrices, tables, links, images, several scripts
 *   pdfkit-*     PDFKit: standard fonts with WinAnsi and kerning `TJ`, justified text (word spacing), an embedded
 *                subset TrueType font, and an AcroForm
 *   pdflib-*     pdf-lib: standard fonts, rotated page and CropBox offset
 *   objects.pdf  pdf-lib: a triangle (an SVG path under a transformation), an image, overlapping rectangles, a bordered
 *                text box, a line and a title: the things the editor can select, move and remove
 *   scan*.pdf    image-only pages, one with real rendered text for OCR
 *   kerned-type1 hand-written Type 1 with a `Differences` encoding and TJ kerning
 *
 * `npm run fixtures` rebuilds them all; the unit tests build any that are missing before they start.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(here, "pdfs");
const require = createRequire(import.meta.url);

export interface FixtureReport {
  built: string[];
  existing: string[];
  skipped: { name: string; reason: string }[];
}

type Builder = () => Promise<Uint8Array>;

const DEJAVU = () => readFileSync(require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf"));

// ---- PDFKit ---------------------------------------------------------------------------------------------------

function pdfkit(configure: (doc: InstanceType<typeof PDFKit>) => void, options: ConstructorParameters<typeof PDFKit>[0] = {}): Promise<Uint8Array> {
  return new Promise((resolvePromise, reject) => {
    // `compress: true` is PDFKit's default; keeping it makes these look like ordinary files in the wild.
    const doc = new PDFKit({ size: "A4", margin: 72, info: { Title: "Fixture" }, ...options });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolvePromise(new Uint8Array(Buffer.concat(chunks))));
    doc.on("error", reject);
    configure(doc);
    doc.end();
  });
}

const LOREM =
  "The company grew steadily during the year and expanded into three new markets while keeping costs under control. Customer satisfaction reached an all-time high in the autumn survey, and the team shipped every release on schedule.";

const pdfkitStandard: Builder = () =>
  pdfkit((doc) => {
    doc.font("Helvetica-Bold").fontSize(24).text("Annual Report", { align: "left" });
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(12).text("Fiscal year 2026", { align: "center" });
    doc.moveDown();
    doc.font("Times-Roman").fontSize(12).text(LOREM, { align: "justify" });
    doc.moveDown();
    doc.font("Courier").fontSize(10).text("Revenue   1,204,000", { align: "left" });
    doc.text("Costs       388,500", { align: "left" });
    doc.moveDown();
    doc.font("Helvetica").fontSize(12).text("Right aligned total: 815,500", { align: "right" });
    doc.moveDown();
    doc.font("Helvetica").text("Plain text then ", { continued: true }).font("Helvetica-Bold").text("a bold word", { continued: true }).font("Helvetica").text(" and the rest of the line.");
    doc.moveDown();
    doc.fillColor("#b91c1c").text("A line in dark red.", { underline: true });
    doc.fillColor("#000000").text("A link to the example site", { link: "https://example.com/", underline: true });
  });

const pdfkitEmbedded: Builder = () =>
  pdfkit((doc) => {
    doc.registerFont("DejaVu", DEJAVU());
    doc.font("DejaVu").fontSize(20).text("Embedded font sample", { align: "left" });
    doc.moveDown();
    doc.fontSize(12).text("The quick brown fox jumps over the lazy dog.");
    doc.text("Привет, мир! Это строка на русском языке.");
    doc.text("Ελληνικά: γειά σου κόσμε.");
    doc.text("Accents: café, naïve, jalapeño, Zürich, Škoda.");
    doc.moveDown();
    doc.fontSize(14).text("Numbers 0123456789 and symbols € £ ¥ © ® ™");
  });

const pdfkitForm: Builder = () =>
  pdfkit((doc) => {
    doc.initForm();
    doc.font("Helvetica-Bold").fontSize(18).text("Registration form", 72, 72);
    doc.font("Helvetica").fontSize(12);
    doc.text("Full name:", 72, 130);
    doc.formText("fullName", 160, 124, 240, 22, { value: "Jane Doe", align: "left" });
    doc.text("E-mail:", 72, 170);
    doc.formText("email", 160, 164, 240, 22, { value: "", align: "left" });
    doc.text("I agree to the terms:", 72, 210);
    doc.formCheckbox("agree", 220, 208, 16, 16, { value: false });
    doc.text("Country:", 72, 250);
    doc.formCombo("country", 160, 244, 180, 22, { select: ["Norway", "India", "Brazil"], value: "India" });
    doc.text("Comments:", 72, 290);
    doc.formText("comments", 160, 284, 300, 60, { multiline: true, value: "" });
  });

// ---- Chromium -------------------------------------------------------------------------------------------------

const CHROMIUM_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 20mm 18mm; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11pt; color: #111827; }
  h1 { font-family: "Times New Roman", Times, serif; font-size: 26pt; margin: 0 0 6pt; }
  h2 { font-size: 14pt; margin: 14pt 0 4pt; color: #1d4ed8; }
  .center { text-align: center; } .right { text-align: right; } .justify { text-align: justify; }
  .mono { font-family: "Courier New", Courier, monospace; font-size: 10pt; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0; }
  td, th { border: 1px solid #9ca3af; padding: 3pt 6pt; } td.n { text-align: right; }
  .rot { position: absolute; left: 14mm; top: 150mm; transform: rotate(-90deg); transform-origin: left top; font-size: 12pt; color: #7c3aed; }
  a { color: #1d4ed8; }
</style></head><body>
  <h1>Quarterly Report</h1>
  <p class="center">Fiscal year 2026 &mdash; Confidential draft</p>
  <h2>Overview</h2>
  <p class="justify">The company grew steadily during the year and expanded into <b>three</b> new markets while <i>keeping costs</i> under control. Customer satisfaction reached an all-time high in the autumn survey. Visit <a href="https://example.com/report">our report page</a> for the full details of every figure quoted here.</p>
  <h2>Figures</h2>
  <table>
    <tr><th>Item</th><th>Quantity</th><th>Price</th></tr>
    <tr><td>Widget</td><td class="n">4</td><td class="n">$9.99</td></tr>
    <tr><td>Gadget with a long name</td><td class="n">1,200</td><td class="n">$129.50</td></tr>
    <tr><td>Gizmo</td><td class="n">12</td><td class="n">12%</td></tr>
  </table>
  <p class="mono">const total = 4 * 9.99 + 1200 * 129.5;</p>
  <p class="right">Prepared by Finance &mdash; page one</p>
  <p>Accented words: caf&eacute;, na&iuml;ve, jalape&ntilde;o, Z&uuml;rich. Prices in &euro; and &pound;.</p>
  <div class="rot">Rotated margin note</div>
  <img alt="" width="160" height="60" src="__PNG__">
</body></html>`;

const MULTILINGUAL_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 25mm; } body { font-family: Arial, "Segoe UI", sans-serif; font-size: 13pt; }
  p { margin: 0 0 10pt; }
</style></head><body>
  <p>English: The quick brown fox jumps over the lazy dog.</p>
  <p>Русский: Съешь же ещё этих мягких французских булок.</p>
  <p>Ελληνικά: Ξεσκεπάζω την ψυχοφθόρα βδελυγμία.</p>
  <p>Français: Voix ambiguë d'un cœur qui, au zéphyr, préfère les jattes de kiwis.</p>
  <p>Deutsch: Falsches Üben von Xylophonmusik quält jeden größeren Zwerg.</p>
</body></html>`;

async function chromiumPdf(html: string): Promise<Uint8Array> {
  const { chromium } = await import("@playwright/test");
  const channel = process.env.E2E_CHANNEL === undefined ? "msedge" : process.env.E2E_CHANNEL || undefined;
  const browser = await chromium.launch({ channel });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    return new Uint8Array(await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true }));
  } finally {
    await browser.close();
  }
}

function gradientPngBytes(): Buffer {
  const canvas = createCanvas(160, 60);
  const context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, 160, 0);
  gradient.addColorStop(0, "#2563eb");
  gradient.addColorStop(1, "#14b8a6");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 160, 60);
  return canvas.toBuffer("image/png");
}

function gradientPng(): string {
  const canvas = createCanvas(160, 60);
  const context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, 160, 0);
  gradient.addColorStop(0, "#2563eb");
  gradient.addColorStop(1, "#14b8a6");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 160, 60);
  return `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`;
}

// ---- pdf-lib --------------------------------------------------------------------------------------------------

const pdflibRotated: Builder = async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([420, 300]);
  page.drawText("Rotated page title", { x: 40, y: 250, size: 20, font: bold });
  page.drawText("This page has a CropBox and a 90 degree rotation.", { x: 40, y: 220, size: 11, font });
  page.drawText("Lower left text", { x: 40, y: 40, size: 11, font });
  page.drawText("Sideways label", { x: 300, y: 60, size: 12, font, rotate: degrees(90) });
  page.setCropBox(20, 20, 380, 260);
  page.setRotation(degrees(90));
  return doc.save();
};

const pdflibStandard: Builder = async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  const page = doc.addPage([595, 842]);
  page.drawText("Hello World", { x: 72, y: 760, size: 24, font });
  page.drawText("The quick brown fox jumps over the lazy dog.", { x: 72, y: 720, size: 12, font: times });
  page.drawText("Second line of body text", { x: 72, y: 700, size: 12, font: times });
  return doc.save();
};

/** A page of things that are not text: the editor must be able to find, move, resize and remove each of them. */
const objectsPage: Builder = async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([400, 500]);
  const picture = await doc.embedPng(new Uint8Array(gradientPngBytes()));
  page.drawText("Objects page", { x: 40, y: 440, size: 24, font: bold });
  // A triangle with its apex up: (60,300) (160,300) (110,380). pdf-lib writes SVG paths under a translate and a flip.
  page.drawSvgPath("M 0 80 L 100 80 L 50 0 Z", { x: 60, y: 380, color: rgb(1, 0, 0) });
  page.drawImage(picture, { x: 220, y: 300, width: 120, height: 60 });
  // Painted after the picture, over its right part.
  page.drawRectangle({ x: 300, y: 330, width: 60, height: 50, color: rgb(1, 0.55, 0) });
  // A text box: a bordered rectangle with two lines in it.
  page.drawRectangle({ x: 60, y: 160, width: 280, height: 100, borderColor: rgb(0, 0, 1), borderWidth: 2 });
  page.drawText("Boxed line one", { x: 70, y: 235, size: 12, font });
  page.drawText("Boxed line two", { x: 70, y: 215, size: 12, font });
  page.drawRectangle({ x: 60, y: 80, width: 80, height: 40, color: rgb(0, 0.6, 0.2) });
  page.drawLine({ start: { x: 200, y: 100 }, end: { x: 340, y: 120 }, thickness: 3, color: rgb(0, 0, 0) });
  return doc.save();
};

// ---- scans ----------------------------------------------------------------------------------------------------

const scanWithText: Builder = async () => {
  const canvas = createCanvas(1240, 1754);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 1240, 1754);
  context.fillStyle = "#111111";
  context.font = "bold 64px Arial, sans-serif";
  context.fillText("SCANNED INVOICE 2026", 120, 220);
  context.font = "40px Arial, sans-serif";
  context.fillText("Customer: Jane Doe", 120, 340);
  context.fillText("Total due: 1,234.50 EUR", 120, 420);
  context.fillText("Thank you for your business.", 120, 500);
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(new Uint8Array(canvas.toBuffer("image/png")));
  doc.addPage([595, 842]).drawImage(image, { x: 0, y: 0, width: 595, height: 842 });
  return doc.save();
};

// ---- hand-written ---------------------------------------------------------------------------------------------

const kernedType1: Builder = async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const { context } = doc;
  const widths = Array.from({ length: 95 }, () => 500);
  const font = context.register(
    context.obj({
      Type: "Font",
      Subtype: "Type1",
      BaseFont: "Times-Roman",
      FirstChar: 32,
      LastChar: 126,
      Widths: widths,
      // code 12 is the fi ligature, code 13 the fl ligature: a TeX-style Differences encoding
      Encoding: { Type: "Encoding", BaseEncoding: "WinAnsiEncoding", Differences: [12, "fi", "fl"] },
    }),
  );
  const resources = context.obj({ Font: { F1: font } });
  page.node.set(PDFName.of("Resources"), resources);
  const content = "BT /F1 12 Tf 72 700 Td [(A) 120 (V) -80 (A) -300 (T) 40 (ea) -250 (W) 30 (ave)] TJ 0 -20 Td [(The \\014nal \\014sh) -333 (an) 20 (d) -333 (\\015ow)] TJ ET";
  page.node.set(PDFName.of("Contents"), context.register(context.flateStream(content)));
  return doc.save();
};

// ---- the set --------------------------------------------------------------------------------------------------

const BUILDERS: Record<string, { build: Builder; browser?: boolean }> = {
  "chromium-article.pdf": { build: () => chromiumPdf(CHROMIUM_HTML.replace("__PNG__", gradientPng())), browser: true },
  "chromium-multilingual.pdf": { build: () => chromiumPdf(MULTILINGUAL_HTML), browser: true },
  "pdfkit-standard.pdf": { build: pdfkitStandard },
  "pdfkit-embedded.pdf": { build: pdfkitEmbedded },
  "pdfkit-form.pdf": { build: pdfkitForm },
  "pdflib-standard.pdf": { build: pdflibStandard },
  "pdflib-rotated.pdf": { build: pdflibRotated },
  "objects.pdf": { build: objectsPage },
  "scan.pdf": { build: scanWithText },
  "kerned-type1.pdf": { build: kernedType1 },
};

export const FIXTURE_NAMES = Object.keys(BUILDERS);

export const fixturePath = (name: string): string => join(FIXTURE_DIR, name);
export const fixtureBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(fixturePath(name)));
export const hasFixture = (name: string): boolean => existsSync(fixturePath(name)) && statSync(fixturePath(name)).size > 0;

/**
 * Builds missing fixtures (or all of them with `force`). A fixture that needs a browser is skipped, with the
 * reason recorded, when no browser can be launched; tests that need it say so rather than passing silently.
 */
export async function ensureFixtures(options: { force?: boolean } = {}): Promise<FixtureReport> {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const report: FixtureReport = { built: [], existing: [], skipped: [] };
  for (const [name, entry] of Object.entries(BUILDERS)) {
    if (!options.force && hasFixture(name)) {
      report.existing.push(name);
      continue;
    }
    try {
      writeFileSync(fixturePath(name), await entry.build());
      report.built.push(name);
    } catch (error) {
      if (!entry.browser) throw error;
      report.skipped.push({ name, reason: error instanceof Error ? error.message.split("\n")[0] ?? "browser unavailable" : "browser unavailable" });
    }
  }
  return report;
}

// `npm run fixtures`
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const report = await ensureFixtures({ force: true });
  console.log(`Built ${report.built.length}: ${report.built.join(", ")}`);
  for (const skipped of report.skipped) console.warn(`Skipped ${skipped.name}: ${skipped.reason}`);
}
