// A stand-in for Ghostscript, used only by the server tests. It "compresses" by copying the input to the
// requested output file, and fails or misbehaves on markers inside the input.
import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log("10.99.0");
  process.exit(0);
}

const output = args.find((arg) => arg.startsWith("-sOutputFile="))?.slice("-sOutputFile=".length);
const input = args.at(-1);
appendFileSync(join(here, "fake-gs.log"), `${JSON.stringify({ pid: process.pid, cwd: process.cwd(), args })}\n`);

const data = readFileSync(input).toString("latin1");
if (data.includes("FAKE:FAIL")) {
  console.error("Error: /undefined in --runpdf--");
  process.exit(1);
} else if (data.includes("FAKE:GARBAGE")) {
  writeFileSync(output, "not a pdf");
} else if (data.includes("FAKE:SHRINK")) {
  // A genuinely smaller PDF with the same pages (the content is dropped): lets tests see the "it got smaller" path.
  const { PDFDocument } = await import("@cantoo/pdf-lib");
  const source = await PDFDocument.load(readFileSync(input), { ignoreEncryption: true });
  const smaller = await PDFDocument.create();
  for (const page of source.getPages()) smaller.addPage([page.getWidth(), page.getHeight()]);
  writeFileSync(output, await smaller.save());
} else {
  copyFileSync(input, output);
}
