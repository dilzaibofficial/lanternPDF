#!/usr/bin/env node
/**
 * Shows whether the same name is already registered under other endings (.net, .org, .app).
 * Somebody else using "name.app" is a hint that a business may already trade under that name.
 *
 *   node scripts/seo/other-tlds.mjs lanternpdf compasspdf --out result.json
 *
 * Each question goes to that ending's own registry RDAP server, taken from IANA's official list
 * (https://data.iana.org/rdap/dns.json, published 2026-09-30). That list has no public server for .io or .co,
 * so those two are not checked here and nothing is assumed about them.
 * Answers: registered / unregistered / unknown (the registry could not be reached or did not answer clearly).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const REGISTRIES = {
  net: "https://rdap.verisign.com/net/v1/domain/",
  org: "https://rdap.publicinterestregistry.org/rdap/domain/",
  app: "https://pubapi.registry.google/rdap/domain/",
};
const ENDINGS = Object.keys(REGISTRIES);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args[outIndex + 1] : null;
const outValueIndex = outIndex >= 0 ? outIndex + 1 : -1;
const names = args.filter((a, i) => !a.startsWith("--") && i !== outValueIndex).map((n) => n.toLowerCase().replace(/\.com$/, ""));

async function lookup(name, ending) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`${REGISTRIES[ending]}${name}.${ending}`, { headers: { accept: "application/rdap+json" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
      if (response.status === 404) return "unregistered";
      if (response.status === 200) return "registered";
      if (response.status === 429 || response.status >= 500) {
        await sleep(3000 * attempt);
        continue;
      }
      return `unknown (HTTP ${response.status})`;
    } catch {
      await sleep(1500 * attempt);
    }
  }
  return "unknown (no answer)";
}

const results = [];
for (const name of names) {
  const row = { name, checked: new Date().toISOString() };
  for (const ending of ENDINGS) {
    row[ending] = await lookup(name, ending);
    await sleep(350);
  }
  results.push(row);
  console.log(`${name.padEnd(16)} ${ENDINGS.map((e) => `${e}:${row[e]}`).join("  ")}`);
}

if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ source: "each registry's own RDAP server, from IANA's list (net: Verisign, org: Public Interest Registry, app: Google Registry). .io and .co are not in IANA's list and were not checked.", ran: new Date().toISOString(), results }, null, 2)}\n`);
}
