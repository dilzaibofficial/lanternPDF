// Copies the runtime assets pdf.js needs (CMaps, standard fonts, WASM decoders, ICC profiles)
// from node_modules into public/pdfjs so they are served from our own origin.
// This keeps the app fully self-contained: no CDN requests, no third parties.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules", "pdfjs-dist");
const target = join(root, "public", "pdfjs");

if (!existsSync(source)) {
  console.warn("[copy-pdfjs-assets] pdfjs-dist is not installed yet; skipping.");
  process.exit(0);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

const copied = [];
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  const from = join(source, dir);
  if (existsSync(from)) {
    cpSync(from, join(target, dir), { recursive: true });
    copied.push(dir);
  }
}
console.log(`[copy-pdfjs-assets] copied: ${copied.join(", ") || "(nothing found)"} -> public/pdfjs`);
