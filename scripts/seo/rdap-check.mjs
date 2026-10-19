#!/usr/bin/env node
/**
 * Checks whether .com names are registered, by asking the .com registry itself (Verisign RDAP).
 *
 *   node scripts/seo/rdap-check.mjs name1 name2 other.com        check the names given
 *   node scripts/seo/rdap-check.mjs --file names.txt             one name per line
 *   node scripts/seo/rdap-check.mjs --file names.txt --out result.json
 *
 * What the answer means
 *   registered     the registry has the name (HTTP 200)
 *   unregistered   the registry has no record of it (HTTP 404). This is the registry's own answer, but it is NOT a
 *                  guarantee that you can buy it at a normal price: a registrar may list it as premium, and somebody
 *                  can register it between this check and your purchase. Re-run this right before you pay.
 *   error          the registry could not be reached or answered something unexpected. Nothing is assumed.
 *
 * Only registry facts are kept (registrar name, dates, status codes). Contact data is never stored.
 * Requests are paced and back off when the registry asks us to slow down.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ENDPOINT = "https://rdap.verisign.com/com/v1/domain/";
const PAUSE_MS = 280;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const names = [];
  let file = null;
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--file") file = argv[++i];
    else if (arg === "--out") out = argv[++i];
    else names.push(arg);
  }
  if (file) names.push(...readFileSync(file, "utf8").split(/\r?\n/));
  const clean = [...new Set(names.map((n) => n.trim().toLowerCase().replace(/\.com$/, "")).filter(Boolean))];
  return { names: clean, out };
}

function summarise(body) {
  const registrar = body.entities?.find((e) => e.roles?.includes("registrar"));
  const fn = registrar?.vcardArray?.[1]?.find((row) => row[0] === "fn")?.[3] ?? null;
  const event = (action) => body.events?.find((e) => e.eventAction === action)?.eventDate ?? null;
  return { registrar: fn, registered: event("registration"), expires: event("expiration"), changed: event("last changed"), status: body.status ?? [] };
}

async function lookup(name) {
  if (!NAME.test(name)) return { name, domain: `${name}.com`, result: "error", detail: "not a valid .com label" };
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(`${ENDPOINT}${name}.com`, { headers: { accept: "application/rdap+json" }, signal: AbortSignal.timeout(20_000) });
      const checked = new Date().toISOString();
      if (response.status === 404) return { name, domain: `${name}.com`, result: "unregistered", http: 404, checked };
      if (response.status === 200) return { name, domain: `${name}.com`, result: "registered", http: 200, checked, ...summarise(await response.json()) };
      if (response.status === 429 || response.status >= 500) {
        await sleep(4000 * attempt);
        continue;
      }
      return { name, domain: `${name}.com`, result: "error", http: response.status, checked };
    } catch (error) {
      if (attempt === 4) return { name, domain: `${name}.com`, result: "error", detail: String(error?.message ?? error) };
      await sleep(2000 * attempt);
    }
  }
  return { name, domain: `${name}.com`, result: "error", detail: "the registry kept asking us to slow down" };
}

const { names, out } = parseArgs(process.argv.slice(2));
if (names.length === 0) {
  console.error("Give at least one name, or --file names.txt");
  process.exit(2);
}

const results = [];
for (const [index, name] of names.entries()) {
  results.push(await lookup(name));
  if ((index + 1) % 50 === 0) console.error(`  …${index + 1}/${names.length}`);
  await sleep(PAUSE_MS);
}

const count = (kind) => results.filter((r) => r.result === kind).length;
const report = {
  source: "Verisign RDAP, the .com registry operator: https://rdap.verisign.com/com/v1/domain/<name>.com",
  ran: new Date().toISOString(),
  meaning: "unregistered = the registry has no record (HTTP 404). Not a purchase guarantee; re-check right before buying.",
  totals: { checked: results.length, registered: count("registered"), unregistered: count("unregistered"), error: count("error") },
  results,
};

if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report.totals));
for (const r of results.filter((x) => x.result !== "registered")) console.log(`${r.result.padEnd(12)} ${r.domain}${r.detail ? `  (${r.detail})` : ""}`);
