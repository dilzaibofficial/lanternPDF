#!/usr/bin/env node
/**
 * Passive public-page capture with REA (rea-agents), used for the Phase 2 research in docs/research/phase-2.md.
 *
 *   node scripts/rea-capture.mjs                 # every target below, then rebuild the committed index
 *   node scripts/rea-capture.mjs phase2-edit-mobile
 *   node scripts/rea-capture.mjs --index-only    # rebuild docs/evidence/rea-evidence-index-phase-2.json from the last run
 *
 * What it does for each target: writes a scenario file (docs/evidence/scenarios/<name>.scenario.json), runs
 * `rea capture-browser-scenario` on it, and splits the Evidence record into the raw artifacts under
 * docs/evidence/raw/ (git-ignored: third-party markup must not be redistributed).
 *
 * What it never does: click, type, upload, submit a form, solve a challenge or work around any protection. A scenario
 * is "load the page, wait, observe". Targets are visited one at a time with a pause between them so the sites are not
 * loaded harder than a person reading would.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scenarioDir = join(root, "docs", "evidence", "scenarios");
const rawDir = join(root, "docs", "evidence", "raw");
const PAUSE_MS = 4500;
const REA = "rea-agents@6.7.0";

const DESKTOP = { width: 1440, height: 900, device_scale_factor: 1 };
const TABLET = { width: 820, height: 1180, device_scale_factor: 1 };
const PHONE = { width: 390, height: 844, device_scale_factor: 1 };

const TARGETS = [
  { name: "phase2-blog-edit-pdf-text", url: "https://www.ilovepdf.com/blog/edit-pdf-text", viewport: DESKTOP },
  { name: "phase2-blog-advanced-editing", url: "https://www.ilovepdf.com/blog/new-advanced-pdf-editing-ilovepdf", viewport: DESKTOP },
  { name: "phase2-blog-mobile-apps", url: "https://www.ilovepdf.com/blog/pdf-editor-android-ios", viewport: DESKTOP },
  { name: "phase2-help-documentation", url: "https://www.ilovepdf.com/help/documentation", viewport: DESKTOP },
  { name: "phase2-pricing", url: "https://www.ilovepdf.com/pricing", viewport: DESKTOP },
  { name: "phase2-edit-tablet", url: "https://www.ilovepdf.com/edit-pdf", viewport: TABLET },
  { name: "phase2-edit-mobile", url: "https://www.ilovepdf.com/edit-pdf", viewport: PHONE },
  { name: "phase2-play-listing", url: "https://play.google.com/store/apps/details?id=com.ilovepdf.www&hl=en", viewport: DESKTOP },
];

function scenarioFor(target) {
  return {
    browser: { mode: "launch", executable_path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true },
    start_url: { url: target.url, query: [] },
    environment: { viewport: target.viewport, locale: "en-US", timezone: "UTC", color_scheme: "light", reduced_motion: "reduce", service_workers: "block" },
    actions: [{ step_id: "settle", action: "wait_for_timeout", duration_ms: 3500 }],
    capture: { at_end: ["url", "dom", "accessibility", "screenshot"], events: ["network", "console", "page-errors"] },
  };
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function capture(target) {
  const scenarioPath = join(scenarioDir, `${target.name}.scenario.json`);
  writeFileSync(scenarioPath, `${JSON.stringify(scenarioFor(target), null, 2)}\n`);
  const relative = `docs/evidence/scenarios/${target.name}.scenario.json`;
  const run = spawnSync("npx", ["-y", REA, "capture-browser-scenario", relative, "--format", "json"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 180_000,
  });
  if (run.status !== 0 || !run.stdout) return { name: target.name, ok: false, problem: `exit ${run.status}: ${(run.stderr || "").slice(0, 400)}` };
  let evidence;
  try {
    evidence = JSON.parse(run.stdout.replace(/^\uFEFF/, ""));
  } catch (error) {
    return { name: target.name, ok: false, problem: `the output was not JSON (${error.message})` };
  }
  writeFileSync(join(rawDir, `${target.name}.evidence.json`), run.stdout);
  const steps = evidence.normalized_result?.steps ?? [];
  const last = steps[steps.length - 1]?.artifacts ?? {};
  const record = { name: target.name, ok: true, requested_url: target.url, viewport: target.viewport, evidence_id: evidence.evidence_id, scenario_sha256: evidence.parameters?.scenario_sha256 };
  record.final_url = last.url?.value?.url ?? null;
  record.duration_ms = evidence.normalized_result?.duration_ms ?? null;
  record.completeness = evidence.normalized_result?.completeness?.status ?? null;
  record.artifacts = {};
  if (last.screenshot?.value?.data_base64) {
    const bytes = Buffer.from(last.screenshot.value.data_base64, "base64");
    writeFileSync(join(rawDir, `${target.name}.png`), bytes);
    record.artifacts.screenshot = { sha256: sha256(bytes), bytes: bytes.length };
  }
  if (typeof last.dom?.value?.text === "string") {
    writeFileSync(join(rawDir, `${target.name}.dom.html`), last.dom.value.text, "utf8");
    record.artifacts.dom = { sha256: sha256(last.dom.value.text), bytes: Buffer.byteLength(last.dom.value.text) };
    record.page_title = /<title[^>]*>([^<]*)<\/title>/i.exec(last.dom.value.text)?.[1]?.trim() ?? null;
  }
  if (typeof last.accessibility?.value?.text === "string") {
    writeFileSync(join(rawDir, `${target.name}.a11y.txt`), last.accessibility.value.text, "utf8");
    record.artifacts.accessibility = { sha256: sha256(last.accessibility.value.text), bytes: Buffer.byteLength(last.accessibility.value.text) };
  }
  const events = evidence.normalized_result?.events?.items ?? [];
  const requests = events.filter((event) => event.kind === "request");
  const hosts = {};
  for (const event of requests) {
    const origin = event.url?.origin;
    if (origin) hosts[origin] = (hosts[origin] ?? 0) + 1;
  }
  record.requests = requests.length;
  record.hosts = hosts;
  record.console_events = events.filter((event) => event.kind === "console").length;
  record.limitations = evidence.limitations ?? [];
  return record;
}

/**
 * The committed index: identifiers, digests, sizes and origin counts only. It carries no page content, so it can be
 * published; the raw artifacts it points to stay local.
 */
function writeIndex(captured, results) {
  const index = {
    tool: REA,
    operation: "capture_browser_scenario (CLI: rea capture-browser-scenario)",
    captured_on: captured,
    actions_performed: "navigate to the start URL, wait 3.5 s, capture. No clicks, no typing, no file uploads, no form submissions.",
    note: "Raw artifacts are kept locally in docs/evidence/raw (git-ignored): they contain third-party markup and branding that must not be redistributed.",
    scenarios: results
      .filter((result) => result.ok)
      .map((result) => ({
        name: result.name,
        evidence_id: result.evidence_id,
        scenario_sha256: result.scenario_sha256,
        requested_url: result.requested_url,
        final_url: result.final_url,
        page_title: result.page_title,
        viewport: result.viewport,
        duration_ms: result.duration_ms,
        completeness: result.completeness,
        artifacts: result.artifacts,
        network: { requests: result.requests, origins: Object.keys(result.hosts).length, requests_per_origin: result.hosts },
      })),
  };
  writeFileSync(join(root, "docs", "evidence", "rea-evidence-index-phase-2.json"), `${JSON.stringify(index, null, 2)}\n`);
}

mkdirSync(scenarioDir, { recursive: true });
mkdirSync(rawDir, { recursive: true });

if (process.argv.includes("--index-only")) {
  const previous = JSON.parse(readFileSync(join(rawDir, "phase2-capture-summary.json"), "utf8"));
  writeIndex(previous.captured_on, previous.results);
  console.log("Rebuilt docs/evidence/rea-evidence-index-phase-2.json from the last capture.");
  process.exit(0);
}

const wanted = process.argv.slice(2);
const chosen = wanted.length ? TARGETS.filter((target) => wanted.includes(target.name)) : TARGETS;
if (!chosen.length) {
  console.error(`No target matches. Known: ${TARGETS.map((target) => target.name).join(", ")}`);
  process.exit(2);
}

const results = [];
for (const [index, target] of chosen.entries()) {
  if (index > 0) await sleep(PAUSE_MS);
  console.log(`[${index + 1}/${chosen.length}] ${target.name}  ${target.url}`);
  const result = capture(target);
  results.push(result);
  if (!result.ok) console.log(`   FAILED: ${result.problem}`);
  else console.log(`   ${result.final_url}  title=${JSON.stringify(result.page_title)}  ${result.requests} requests to ${Object.keys(result.hosts).length} origins  ${result.completeness}`);
}

const summary = join(rawDir, "phase2-capture-summary.json");
const capturedOn = new Date().toISOString().slice(0, 10);
writeFileSync(summary, `${JSON.stringify({ captured_on: capturedOn, tool: REA, results }, null, 2)}\n`);
// A partial run (a few names) must not replace the full index with a shorter one.
if (!wanted.length) writeIndex(capturedOn, results);
console.log(`\nSummary written to ${summary}`);
