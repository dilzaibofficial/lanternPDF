# Phase 3 plan: brand, domain, SEO and GitHub release

Written 2026-10-19. This is a working checklist. A box is ticked only when the work was done and checked; anything else says what is missing.

## Where things stand

| Step | What | Status |
| --- | --- | --- |
| 1 | Inspect the app, git state and available skills; write this plan | Done |
| 2 | Research .com names, check availability and price, write `domain-shortlist.md` | Done: [domain-shortlist.md](./domain-shortlist.md). Best pick: `lanternpdf.com` |
| – | **You choose a domain** | **Waiting for you. Nothing below this line starts before that.** |
| 3 | Apply the chosen name and domain everywhere | Not started |
| 4 | Recheck skills and use every relevant installed SEO skill | Not started |
| 5 | Route-by-route technical SEO audit and fixes | Not started |
| 6 | SEO for each real, index-worthy tool | Not started |
| 7 | Competitor and user-feedback research | Not started |
| 8 | Content, internal linking and keyword map | Not started |
| 9 | Measure SEO quality with automated checks | Not started |
| 10 | GitHub release | Not started (needs answers from you, see below) |
| 11 | Production checklist and final report | Not started |

## Rules that stay in force

- No domain is bought and no money is spent for you. Registering the name is your step.
- Until you pick a name: the public brand, canonical URLs, deployment config and the repository stay untouched. Step 1 and 2 only add files under `docs/seo/` and `scripts/seo/`.
- Only .com, with a first-year price of at most PKR 4,000. No premium or aftermarket names.
- Nothing is called done, indexed, ranking, fast or "passing" without evidence. Search position cannot be promised and is not scored from a domain name.
- No secrets, `.env` files, uploads or private data are committed. No force-push, history rewrite or branch deletion.

## What the app is today (inspected)

| Area | Finding |
| --- | --- |
| Stack | Vite 8, React 19, TypeScript, React Router 8. Optional Express 5 server for Office conversions and Ghostscript compression. |
| Pages | `/`, `/tools`, `/tools/:toolId` (23 tools), `/privacy`, `/about`, `/self-hosting`, `/editor` (the advanced editor), and a catch-all not-found page. |
| Rendering | Client-side only. Every URL is served the same `index.html`; titles and descriptions are set by JavaScript afterwards (`src/hooks/useDocumentTitle.ts`). Crawlers that do not run JavaScript, including most AI crawlers, see an empty page. |
| Metadata today | `index.html` has one title and one description. There is no canonical tag, no Open Graph or Twitter tags, no structured data. |
| `robots.txt` | `Allow: /` and `Disallow: /api/`. No `Sitemap:` line. |
| Sitemap | None. |
| Unknown URLs | The server and the React catch-all both answer **HTTP 200** with the app shell (a "soft 404"). The not-found page has no `noindex`. |
| Brand | One file, `src/config/brand.ts` (name, tagline, description). "Sheaf" also appears in 11 files in total (index.html, package.json, pages, tests and more). Colours are indigo and teal. |
| Tools | 23 tools. 17 run fully in the browser, 3 have an extra server mode (compress, PDF to Word, PDF to PowerPoint), and **3 need the self-hosted server with LibreOffice** (Word, Excel and PowerPoint to PDF). |
| Security headers | A strict content security policy (`script-src 'self'`) in `server/app.ts`. Any analytics script would be blocked unless that policy is changed on purpose. |
| Repo files | `.gitignore`, `.env.example` and `.nvmrc` exist. There is **no `README.md` and no `LICENSE` file** (package.json says MIT). |
| Git | At the start of Phase 3 the folder was **not a git repository** (no `.git`). `git` 2.54.0 is installed, the GitHub CLI (`gh`) is not, and Git Credential Manager holds a login for the GitHub account `dilzaibofficial`. The GitHub repository `dilzaibofficial/lanternPDF` was checked and is empty. |

What this means for SEO:

1. A search engine that does not run JavaScript sees the same shell on every URL. Real per-page HTML (prerendering) is the biggest technical fix. It is planned for Step 5.
2. The three Office-to-PDF tools cannot work on a static host. They must not be presented, or indexed, as working public tools unless the production site runs the Node server with LibreOffice. This depends on where you host (see the questions below).
3. `/editor` and `/tools/edit` both describe editing a PDF. One of them has to be the page that targets "edit PDF", so they do not compete with each other. Decided in Step 6.

Current build health: see "Baseline build health" at the bottom of this file.

## Skills: what is installed, and how that was checked

Checked on 2026-10-19 by listing the plugin folder, reading `~/.claude/settings.json`, and loading each skill through the Skill tool.

| Plugin | Version | Enabled | How verified |
| --- | --- | --- | --- |
| `claude-seo` (marketplace `AgriciDaniel/claude-seo`) | 2.2.4 | yes | Present in `~/.claude/plugins/installed_plugins.json` and the plugin cache; enabled in settings; its sub-agents are listed in this session. |
| `ui-ux-pro-max` | 2.13.0 | yes | Same files. It is a design plugin, not an SEO one. |
| `reverse-engineer-anything` | local skill | yes | Used in earlier phases; not an SEO skill. |

`claude-seo` provides 25 skills. These seven, named in your brief, were **loaded through the Skill tool in this session**, so they are confirmed available: `seo-schema`, `seo-content`, `seo-sitemap`, `seo-page`, `seo-competitor-pages`, `seo-geo`, `seo-google`. None of their workflows has been run yet, because they need the final domain and a running site.

The other 18 are present in the plugin folder (not yet loaded in this session): `seo`, `seo-audit`, `seo-backlinks`, `seo-cluster`, `seo-content-brief`, `seo-dataforseo`, `seo-drift`, `seo-ecommerce`, `seo-flow`, `seo-hreflang`, `seo-image-gen`, `seo-images`, `seo-local`, `seo-maps`, `seo-plan`, `seo-programmatic`, `seo-sxo`, `seo-technical`.

**The plugin's Python helper scripts are not ready.** `claude-seo doctor` reports "setup required: managed environment is missing, Chromium not installed". Running `claude-seo setup` would create a virtual environment and download about 15 Python packages plus a Chromium build. I have not run it. I will ask before I do. Until then the skills are used as written instructions, with my own Node and Playwright checks doing the measuring.

How each skill will be used after you choose a domain (Step 4 onward):

| Skill | Planned use | Needs |
| --- | --- | --- |
| `seo-technical`, `seo-page` | Route-by-route audit: titles, descriptions, H1, canonicals, status codes, images, links | Local build |
| `seo-schema` | Organization, WebSite, BreadcrumbList on every page; a software-application type only where the markup is valid and honest. No ratings or reviews, because there are none. Its own notes say HowTo is deprecated and FAQ rich results ended in 2026; both are to be re-checked against Google's documentation before use. | Domain |
| `seo-sitemap` | Generate `sitemap.xml` from the real tool list; accurate `lastmod`; no `priority` or `changefreq` | Domain |
| `seo-content`, `seo-content-brief` | Original how-to copy, limits and honest wording per tool | Domain |
| `seo-cluster`, `seo-plan`, `seo-programmatic` | Keyword map and internal-link plan, without doorway pages | Domain |
| `seo-competitor-pages` | Research only, from real public sources with dates. No "alternative to X" pages unless real comparison data and fair wording back them. | Sources |
| `seo-geo` | Server-rendered answers, crawler access in robots.txt. `llms.txt` is optional and Google ignores it. | Prerendering |
| `seo-google` | Search Console, indexing, Core Web Vitals field data | **A live site and Google credentials. Cannot run before launch.** |
| `seo-images`, `seo-image-gen` | Social preview image audit; image generation only if you ask | Domain |
| `seo-hreflang`, `seo-local`, `seo-maps`, `seo-ecommerce`, `seo-backlinks`, `seo-dataforseo`, `seo-drift` | Not applicable now (single-language, no shop, no address). Backlinks and DataForSEO need paid or account access. `seo-drift` is useful after launch. | – |

## Step checklists

### Step 2 — domain research (done 2026-10-19)

- [x] Candidate generator, registry checker and other-endings checker: `scripts/seo/domain-candidates.mjs`, `rdap-check.mjs`, `other-tlds.mjs` (lint clean)
- [x] 1,391 plain-English .com names checked against the .com registry (Verisign RDAP): 320 unregistered, 0 errors. `docs/seo/evidence/rdap-scan-2026-10-19.json`
- [x] Registrar price sources and exchange rate recorded, with dates and what could not be verified (see shortlist)
- [x] Finalists checked for existing products by web search; 7 names rejected for near-collisions. This is **not** a trademark search.
- [x] `docs/seo/domain-shortlist.md` written; **stopped to ask you to choose**

### Step 3 — apply the name (after you choose)

- [ ] `src/config/brand.ts`: name, tagline, description, site URL
- [ ] `index.html`, `package.json`, `.env.example`, server startup message, README, docs, test expectations that mention the old name
- [ ] Footer and header text, the About page, the Privacy page, the Self-hosting page
- [ ] Social preview (Open Graph) image and favicon for the new name
- [ ] Canonical host rule (apex or www) and `SITE_URL` setting
- [ ] Keep a short note on whether the old name "Sheaf" is dropped or kept

### Step 4 — skills

- [ ] Recheck the installed list; load every relevant skill; record which ones were used, what each changed, and which could not run (and why) in `docs/seo/skills-used.md`

### Step 5 — technical SEO (route by route)

- [ ] Prerender every public route to real HTML with its own title, description, canonical, headings and structured data
- [ ] `robots.txt` with a `Sitemap:` line; `sitemap.xml` generated from the tool list
- [ ] Real HTTP 404 for unknown URLs, a useful 404 page, `noindex` on it
- [ ] Redirect rules: http to https, www to apex (or the reverse), trailing-slash rule, one canonical per page
- [ ] Open Graph and Twitter tags; Organization, WebSite and BreadcrumbList data
- [ ] Heading order, link text, image alt text, mobile layout, keyboard use, colour contrast
- [ ] Core Web Vitals: **lab measurements only** (they are not field data). Field data needs real visitors.
- [ ] Decide what `noindex` or "needs your own server" wording the three server-only tools get on a public static site

### Step 6 — per-tool SEO

- [ ] One original title, description, H1, how-to, limits, related links and short Q&A for each tool that really works on the public site
- [ ] Keyword-to-URL map so no two pages target the same search ("edit PDF" has two candidates today)
- [ ] Structured data only where valid; no fake ratings; no claims the app cannot back up (for example "no upload" stays true only for the browser-only tools)

### Step 7 and 8 — research, content, linking

- [ ] `docs/seo/competitor-research.md`: public pages and public user feedback only, each with source and date
- [ ] `docs/seo/keyword-map.md`, `docs/seo/content-strategy.md`, `docs/seo/internal-linking.md`
- [ ] No keyword stuffing, doorway pages, fake reviews, paid or artificial links, or claims of affiliation with other products

### Step 9 — measure

- [ ] A repeatable local check script covering: titles, descriptions, H1 count, canonicals, sitemap and robots validity, broken internal links, structured-data parse, status codes, image alt text
- [ ] Browser checks with Playwright (mobile viewport, accessibility rules where available)
- [ ] Report each check as passed, failed, not run, or needs production

### Step 10 — GitHub release

- [ ] Confirm the repository URL, target branch and how to sign in
- [ ] `git init` only if you want a new local repository and have given the remote; otherwise stop and ask
- [ ] Add `README.md` (exact install, run, build and test commands) and `LICENSE`
- [ ] Run lint, type-check, unit tests, build and the browser tests; report real results
- [ ] Scan for secrets, `.env` files, keys, uploads, build output and large files before the first commit
- [ ] Descriptive commits; push without force; show Git's own confirmation

### Step 11 — production checklist and final report

- [ ] Domain registration (you), DNS, HTTPS, hosting, environment variables
- [ ] Submit the sitemap, verify the site in Search Console, inspect key URLs, set up monitoring
- [ ] Analytics only if you want it and in a way that fits the privacy promise (the current security policy blocks outside scripts)
- [ ] A realistic 90-day plan. No promise of any search position.

## What I need from you

1. **Which domain** from the shortlist (or ask for more names).
2. **GitHub**: answered on 2026-10-19: `https://github.com/dilzaibofficial/lanternPDF.git`, branch `main`, commits use the git identity already set on this PC.
3. **Hosting plan**: static hosting only (browser tools work; the three Office-to-PDF tools are marked as needing your own server), or a Node server with LibreOffice (everything works, costs more). Default if you do not say: static hosting.
4. **Permission to run `claude-seo setup`** (Python environment and Chromium for the plugin's helper scripts), or skip it.

## Baseline build health

Measured on 2026-10-19 before any Phase 3 change to the app (only `docs/seo/` and `scripts/seo/` were added):

| Check | Result |
| --- | --- |
| `npm run typecheck` (app, server, node and test configs) | Passed |
| `npm run lint` | 3 errors left over from the form-field work (one irregular space in a regex, two type-only imports). Fixed; the full `npm run lint` now reports no problems. |
| `npx vitest run tests/unit/engine/forms.test.ts` | 9 of 9 passed after the fix |
| Full unit suite, build, browser tests | **Not re-run yet.** They run again before the GitHub release (Step 10). |

Known unfinished work from Phase 2 that the release must describe honestly: form fields are read, filled and created by the engine and covered by unit tests, but the editor does not use them yet (export still refuses form-field objects); crop UI, OCR, compare, duplicate finder, print-ready, batch, and the performance benchmarks are not built. See `docs/phase-2-gap-analysis.md`.
