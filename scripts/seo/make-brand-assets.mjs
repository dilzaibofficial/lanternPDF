#!/usr/bin/env node
/**
 * Draws the brand images from the logo shapes: PNG icons, favicon.ico and the 1200x630 social share image.
 *
 *   node scripts/seo/make-brand-assets.mjs
 *
 * Uses the Playwright browser that the end-to-end tests already use (Microsoft Edge), so nothing extra is installed.
 * The results are committed to public/, so this only needs to run when the logo or the share image changes.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";

const require = createRequire(import.meta.url);
const OUT = "public";
mkdirSync(`${OUT}/icons`, { recursive: true });
mkdirSync(`${OUT}/og`, { recursive: true });

const INDIGO = "#3a3ad1";
const TEAL = "#0b7f72";
const PAPER = "#f6f4ef";

const fontPath = require.resolve("@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2");
const fontData = readFileSync(fontPath).toString("base64");
const fontFace = `@font-face{font-family:"PJS";src:url(data:font/woff2;base64,${fontData}) format("woff2");font-weight:200 800;}`;

/** The lantern, with caller-chosen colours. Same shapes as src/components/brand/BrandMark.tsx. */
const lantern = ({ body, accent, page = "#fff", pageLine = accent }) => `
  <path d="M13.1 6.6a2.9 2.9 0 1 1 5.8 0" fill="none" stroke="${body}" stroke-width="1.8" stroke-linecap="round"/>
  <path d="M8.6 12 12.2 7.4h7.6L23.4 12z" fill="${body}"/>
  <rect x="8" y="11.6" width="16" height="2.2" rx="1.1" fill="${body}"/>
  <rect x="9.6" y="13.2" width="12.8" height="11" rx="2" fill="${body}"/>
  <path d="M12.9 14.9h3.8l2.5 2.5v5.2a.8.8 0 0 1-.8.8h-5.5a.8.8 0 0 1-.8-.8v-6.9a.8.8 0 0 1 .8-.8z" fill="${page}"/>
  <path d="M16.7 14.9v2.5h2.5z" fill="${accent}" opacity=".55"/>
  <path d="M14 20h4M14 21.7h2.6" stroke="${pageLine}" stroke-width="1.1" stroke-linecap="round" fill="none"/>
  <rect x="8" y="24" width="16" height="2.2" rx="1.1" fill="${body}"/>
  <rect x="10.4" y="26.2" width="11.2" height="2.2" rx="1.1" fill="${accent}"/>`;

const iconHtml = (size, { padding, radius }) => `<!doctype html><html><body style="margin:0;background:transparent">
  <div style="width:${size}px;height:${size}px;background:${PAPER};border-radius:${radius}px;display:grid;place-items:center">
    <svg viewBox="0 0 32 32" width="${size - padding * 2}" height="${size - padding * 2}">${lantern({ body: INDIGO, accent: TEAL })}</svg>
  </div></body></html>`;

const ogHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFace}
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;overflow:hidden;font-family:"PJS",system-ui,sans-serif;color:#fff;
  background:radial-gradient(circle at 82% 48%, #14b8a6 0%, rgba(20,184,166,0) 38%), linear-gradient(135deg,#1c1c78 0%,#3a3ad1 62%,#2a5fd8 100%);position:relative}
.left{position:absolute;left:84px;top:0;bottom:0;width:690px;display:flex;flex-direction:column;justify-content:center;gap:26px}
.brand{display:flex;align-items:center;gap:16px;font-size:34px;font-weight:700;letter-spacing:-.01em}
.brand svg{width:54px;height:54px}
h1{font-size:76px;line-height:1.04;font-weight:800;letter-spacing:-.025em}
p{font-size:31px;line-height:1.35;font-weight:500;color:#e3e6ff;max-width:640px}
.pills{display:flex;gap:14px;margin-top:6px}
.pill{font-size:23px;font-weight:650;padding:10px 20px;border-radius:999px;background:rgba(255,255,255,.14);border:1.5px solid rgba(255,255,255,.28)}
.art{position:absolute;right:70px;top:90px;width:440px;height:450px}
.art svg{width:440px;height:450px;filter:drop-shadow(0 24px 50px rgba(8,8,60,.45))}
</style></head><body>
<div class="left">
  <div class="brand"><svg viewBox="0 0 32 32">${lantern({ body: "#ffffff", accent: "#5eead4", page: "#3a3ad1", pageLine: "#ffffff" })}</svg>LanternPDF</div>
  <h1>Free PDF tools<br>&amp; editor</h1>
  <p>Merge, edit, compress, convert, redact and protect PDFs. Your files stay in your browser.</p>
  <div class="pills"><span class="pill">No sign-up</span><span class="pill">No watermark</span><span class="pill">lanternpdf.com</span></div>
</div>
<div class="art"><svg viewBox="0 0 32 32">${lantern({ body: "#ffffff", accent: "#5eead4", page: "#3a3ad1", pageLine: "#ffffff" })}</svg></div>
</body></html>`;

/** An .ico file that holds PNG pictures. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

const browser = await chromium.launch({ channel: "msedge" });
try {
  const page = await browser.newPage();
  const shot = async (html, width, height, path, transparent = false) => {
    await page.setViewportSize({ width, height });
    await page.setContent(html);
    const png = await page.screenshot({ omitBackground: transparent, clip: { x: 0, y: 0, width, height } });
    if (path) writeFileSync(path, png);
    return png;
  };

  await shot(iconHtml(512, { padding: 96, radius: 112 }), 512, 512, `${OUT}/icons/icon-512.png`, true);
  await shot(iconHtml(192, { padding: 36, radius: 42 }), 192, 192, `${OUT}/icons/icon-192.png`, true);
  // iOS fills transparent corners with black, so the home-screen icon is a full square.
  await shot(iconHtml(180, { padding: 34, radius: 0 }), 180, 180, `${OUT}/icons/apple-touch-icon.png`);
  // Maskable icons are cropped by the phone, so the artwork stays inside the central 80%.
  await shot(iconHtml(512, { padding: 128, radius: 0 }), 512, 512, `${OUT}/icons/icon-512-maskable.png`);
  const sizes = [16, 32, 48];
  const pngs = [];
  for (const size of sizes) pngs.push({ size, png: await shot(iconHtml(size, { padding: Math.round(size * 0.12), radius: Math.round(size * 0.2) }), size, size, null, true) });
  writeFileSync(`${OUT}/favicon.ico`, ico(pngs));
  await shot(ogHtml, 1200, 630, `${OUT}/og/lanternpdf-og.png`);
  await shot(iconHtml(512, { padding: 96, radius: 112 }), 512, 512, `${OUT}/icons/logo-512.png`, true);
  console.log("brand assets written to public/");
} finally {
  await browser.close();
}

writeFileSync(
  `${OUT}/site.webmanifest`,
  `${JSON.stringify(
    {
      name: "LanternPDF",
      short_name: "LanternPDF",
      description: "Free online PDF editor and tools. Your files stay in your browser.",
      start_url: "/",
      scope: "/",
      display: "browser",
      background_color: PAPER,
      theme_color: PAPER,
      icons: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    },
    null,
    2,
  )}\n`,
);
console.log("site.webmanifest written");
