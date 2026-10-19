// A stand-in for LibreOffice's `soffice`, used only by the server tests (LibreOffice is not installed on the
// machines this project is developed and tested on). It understands the options the server passes and
// behaves according to markers inside the input file, so the tests can exercise every path of the server's
// process handling: success, failure, a hang, an "exit 0 but no output" run, and garbage output.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "@cantoo/pdf-lib";
import { strToU8, zipSync } from "fflate";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log("LibreOffice 7.6.99.0 (test double)");
  process.exit(0);
}

const after = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const input = args.at(-1);
const outDir = after("--outdir");
const convertTo = after("--convert-to") ?? "";
const inFilter = args.find((arg) => arg.startsWith("--infilter="));
const profile = args.find((arg) => arg.startsWith("-env:UserInstallation="));

// Tests read this to check how the server called the converter.
appendFileSync(join(here, "fake-soffice.log"), `${JSON.stringify({ pid: process.pid, cwd: process.cwd(), args, convertTo, inFilter, profile, env: { HOME: process.env.HOME, SECRET_TOKEN: process.env.SECRET_TOKEN ?? null } })}\n`);

const data = readFileSync(input).toString("latin1");
const format = convertTo.split(":")[0];

if (data.includes("FAKE:HANG")) {
  setInterval(() => undefined, 1000); // never finishes; the server must kill us
} else if (data.includes("FAKE:FAIL")) {
  console.error("Error: source file could not be loaded");
  process.exit(1);
} else if (data.includes("FAKE:NOOUTPUT")) {
  process.exit(0); // claims success but writes nothing
} else {
  if (data.includes("FAKE:SLOW")) await new Promise((resolve) => setTimeout(resolve, 1500));
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${basename(input, extname(input))}.${format}`);
  if (data.includes("FAKE:GARBAGE")) {
    writeFileSync(out, "this is not what was asked for");
  } else if (format === "pdf") {
    const doc = await PDFDocument.create();
    doc.addPage([300, 200]).drawText(`converted from ${extname(input)}`, { x: 20, y: 100, size: 14 });
    writeFileSync(out, await doc.save());
  } else if (format === "docx" || format === "pptx") {
    // The parts every real file of the type has, so the browser's own check of what it receives passes.
    const main = format === "docx" ? "word/document.xml" : "ppt/presentation.xml";
    writeFileSync(out, zipSync({ "[Content_Types].xml": strToU8("<Types/>"), [main]: strToU8("<root/>"), "content.txt": strToU8(`converted with ${inFilter ?? "no filter"}`) }));
  } else {
    console.error(`unsupported target ${convertTo}`);
    process.exit(2);
  }
}
