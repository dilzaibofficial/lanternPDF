# Reference analysis (REA investigation)

This document records the mandatory first step of the project: an investigation of the public
reference website `https://www.ilovepdf.com/` with **REA** (`reverse-engineer-anything`,
`rea-agents@6.7.0`). It separates **observations** (what REA captured) from **inferences** and from
**design decisions** (what we chose to build), and it lists everything that was *not* examined.

> Nothing here is a statement about the reference site's source code or internal APIs. Neither was
> inspected. See [What was not examined](#4-what-was-not-examined).

## 1. Method

| Item | Value |
|---|---|
| Skill | `reverse-engineer-anything` (v42, 207 tools) — verified available and loaded in the Claude Code session |
| REA route | The REA MCP server was registered during this session but is not attached to an already-running session, so the **CLI fallback** was used: `npx -y rea-agents@6.7.0 capture-browser-scenario <scenario.json>` |
| REA operation | `capture_browser_scenario` — one bounded Playwright scenario per page, returned as Evidence (`confidence: observed`, `authority: controlled-replay`) |
| Browser | Chromium 155.0.4283.60 (Microsoft Edge, launched headless by REA with a temporary profile; REA reported `cleanup: terminated-owned-process`) |
| Environment | `en-US`, `UTC`, light colour scheme, reduced motion, service workers blocked |
| Actions per scenario | Navigate to the start URL, wait 3.5–4 s, capture. **No clicks, no typing, no uploads, no form submissions.** |
| Captured per page | Final URL, rendered DOM text, accessibility tree, one viewport screenshot, network *metadata* (method, URL, resource type, header **names**; no bodies, no header values) |
| Pages | 15 captures of 11 distinct public URLs (home page at three viewports; Merge at two) |
| Date | 2026-10-18 |
| Pacing | One page load at a time, ~4 s apart, 15 loads in total |

Scenario definitions (our own files) are in [`docs/evidence/scenarios/`](evidence/scenarios), so the
capture is reproducible. The index with full Evidence IDs, artifact SHA-256 digests and network
summaries is [`docs/evidence/rea-evidence-index.json`](evidence/rea-evidence-index.json).

The raw artifacts (screenshots, DOM, accessibility trees) are kept **locally** in
`docs/evidence/raw/` and are **git-ignored**: they contain third-party markup and branding that this
repository must not redistribute.

### Boundaries we kept, and why

REA's own `DISCLAIMER.md` states that it will not help with bypassing bot protection or access controls,
or with copying proprietary code and assets, and that public availability of a service does not by itself
authorise every operation. We therefore limited the investigation to what any visitor's browser does when
it loads a public page:

- no file was uploaded to, and nothing was submitted to, the reference service;
- no attempt was made to interact with, evade or test its bot protection (see O-9);
- the reference site's JavaScript bundles and source maps were not exported or analysed;
- no screenshots, markup, icons, copy or code from the reference are included in this repository.

## 2. Evidence index

`E#` identifiers are used throughout this document. Full 67-character IDs are in the JSON index.

| # | Scenario | Page | Viewport | Evidence ID | Requests (failed) | Third-party origins |
|---|----------|------|----------|-------------|-------------------|---------------------|
| E1 | `home-desktop` | `/` | 1440×900 | `ev_f76ebda3d94b777c…` | 31 (3) | 2 |
| E2 | `home-tablet` | `/` | 820×1180 | `ev_c58ea8f6f1cd873d…` | 31 (3) | 2 |
| E3 | `home-mobile` | `/` | 390×844 | `ev_785e811eaa0bd659…` | 31 (3) | 2 |
| E4 | `merge-desktop` | `/merge_pdf` | 1440×900 | `ev_4467eef3c204045e…` | 51 (4) | 19 |
| E5 | `merge-mobile` | `/merge_pdf` | 390×844 | `ev_a1f3ae855f79bf38…` | 43 (4) | 14 |
| E6 | `split-desktop` | `/split_pdf` | 1440×900 | `ev_36db2142e917bf18…` | 52 (4) | 19 |
| E7 | `compress-desktop` | `/compress_pdf` | 1440×900 | `ev_61fefc872f650800…` | 51 (4) | 19 |
| E8 | `organize-desktop` | `/organize-pdf` | 1440×900 | `ev_d9c7c6e701b0842b…` | 68 (11) | 22 |
| E9 | `edit-desktop` | `/edit-pdf` | 1440×900 | `ev_5e5e4a53073b6a41…` | 45 (4) | 14 |
| E10 | `jpg2pdf-desktop` | `/jpg_to_pdf` | 1440×900 | `ev_ca7c0409fd3e5f5a…` | 51 (4) | 19 |
| E11 | `pdf2jpg-desktop` | `/pdf_to_jpg` | 1440×900 | `ev_0bcb72fb3f6c301d…` | 51 (4) | 19 |
| E12 | `protect-desktop` | `/protect-pdf` | 1440×900 | `ev_22fa7073cca9d81b…` | 51 (4) | 19 |
| E13 | `unlock-desktop` | `/unlock_pdf` | 1440×900 | `ev_a1ee6be7e5ecb80d…` | 51 (4) | 19 |
| E14 | `docs-desktop` | `/help/documentation` | 1440×900 | `ev_bbc7a36c77b23088…` | 50 (3) | 2 |
| E15 | `faq-desktop` | `/help/faq` | 1440×900 | `ev_29d5d3c39115962c…` | 29 (3) | 2 |

All 15 captures reported `completeness: complete`.

## 3. Findings

### 3.1 Observations

**O-1 · Information architecture and navigation** (E1–E3)
- Header: logo, three promoted tools (Merge, Split, Compress), a **Convert** dropdown, an **All tools**
  mega-menu, sign-in / sign-up, and a secondary "more" menu (other products, solutions, apps, pricing,
  security, help, language).
- The mega-menu is grouped into seven columns: *Organize*, *Optimize*, *Convert to PDF*,
  *Convert from PDF*, *Edit*, *Security*, *Intelligence*. Its markup is present in the DOM even while
  closed (so it was readable without any interaction).
- "Extract pages" is a deep link into the Split tool (`/split_pdf#split,extract`), i.e. one tool with
  several modes; "Remove pages" is a separate page.
- Footer: Product, Resources, Solutions, Legal and Company link groups, a language selector, social links
  and app-store badges.
- Language selector: 26 languages, each a locale-prefixed path (e.g. `/es`, `/fr`, `/zh-cn`).

**O-2 · Home page** (E1)
- One `h1` and one `h2`, followed by a row of eight category filters (*All, Workflows, Organize, Optimize,
  Convert, Edit, Security, Intelligence*) and a grid of **31 tool cards** (icon, title, one-sentence
  description; four carry a "New" badge).
- Below the grid: a workflow-builder call-to-action, three "work your way" cards (desktop app, mobile app,
  business), a premium upsell, a cross-promotion for a sister image product, and trust badges.

**O-3 · Tool catalogue** (E1, E4–E13)
- Observed tools: Merge, Split, Remove pages, Extract pages, Organize, Scan to PDF, Compress, Repair, OCR,
  JPG→PDF, Word→PDF, PowerPoint→PDF, Excel→PDF, HTML→PDF, PDF→JPG, PDF→Word, PDF→PowerPoint, PDF→Excel,
  PDF→PDF/A, Rotate, Page numbers, Watermark, Crop, Edit, Forms, Unlock, Protect, Sign, Redact, Compare,
  AI summarizer, Translate, PDF→Markdown.
- Tool URLs are flat slugs (`/merge_pdf`, `/split_pdf`, `/protect-pdf`, …); slug style is inconsistent
  (underscores and hyphens both occur).

**O-4 · Tool entry screen — the start of the upload workflow** (E4–E13)
- Every tool page captured shows the same minimal first state: an `h1` (the tool name), an `h2` (one
  sentence of what it does), one dominant call-to-action button, a hint "or drop … here", and two extra
  round buttons for cloud-storage import (Google Drive, Dropbox). Nothing else is rendered in the captured
  DOM.
- **Wording differs by tool arity**: tools that take several files say "Select PDF files / drop PDFs
  here"; single-file tools (Split, Protect, Edit, Organize) say "Select PDF file / drop PDF here".
  JPG→PDF says "Select JPG images".
- The hidden file input has `multiple` and `accept=".pdf"` (E4); the DOM also contains an empty
  upload-progress bar element, so progress is shown at the top of the work area.
- The `h2` lines hint at each tool's options: *JPG→PDF* — orientation and margins; *PDF→JPG* — pages as
  images or extract embedded images; *Edit* — text, shapes, comments, highlights; *Organize* — drag
  thumbnails to sort, add and delete pages; *Protect/Unlock* — add / remove a password.

**O-5 · Workflows as publicly documented** (E14) — paraphrased
- *Merge*: pick files, arrange their order, optionally include password-protected files, then process and
  download.
- *Split*: split by ranges or extract every page; ranges can optionally be merged into one PDF.
- *Remove / Extract / Organize pages*: a thumbnail for every page; when several files are loaded their
  thumbnails get differently coloured frames; click a thumbnail to mark it (a red cross for removal);
  extraction can output one merged PDF or a ZIP of single pages; organize adds drag-and-drop reordering.
- *Compress*: three levels ("extreme", "high", "regular"); more compression means smaller and lower
  quality.
- *Edit*: a viewer with a top toolbar (navigation, single/multi-page layout, hand tool, zoom) and Text,
  Image and Shape tools; elements are moved and resized in place; property bars control colour,
  transparency, border colour, rotation, format and line thickness.
- *Page numbers*: all pages or facing pages, a page range, position and typography options.
- *Watermark*: text or image, typography, transparency and position.
- *JPG→PDF*: orientation (portrait/landscape), margin (with/without), option to merge all images into one
  PDF.
- *Word / PowerPoint / Excel → PDF*: upload, convert, download a non-editable PDF.
- *PDF → Word / PowerPoint / Excel*: convert to an editable document; each PDF page becomes a slide.
- *PDF→JPG*: each page as an image, or all embedded images in a ZIP.
- *Unlock / Protect*: remove / add a password.
- Most steps end with "download, or save back to cloud storage".

**O-6 · Responsive behaviour** (E1–E3, E4–E5)
- Desktop 1440: full header nav; **5-column** card grid.
- Tablet 820: the nav collapses into a hamburger; **3-column** grid; filter chips wrap to two rows.
- Mobile 390: hamburger on the left, logo, app-switcher on the right; chips wrap to three rows; cards become a
  **single column**; on a tool page the call-to-action spans the full width and the "or drop here" hint is
  not shown.

**O-7 · Accessibility of the captured markup** (E4–E13, accessibility trees)
- The primary action is exposed as a *link* with an `href` of `javascript:;`, not a button.
- The native file input surfaces as an unlabeled "Choose File" button next to it.
- Card and nav images have no accessible names (`img` with no `alt` in the tree).
- Headings are well formed (`h1` → `h2`), which we keep.

**O-8 · Network and privacy posture** (E1–E15)
- The home and help pages contact 2 third-party origins (tag manager and analytics).
- Tool pages contact **14–22 third-party origins**; by domain name these are advertising and measurement
  networks (Google ad services, Criteo, OpenX, Adform, The Trade Desk, RTB House and similar). Domain-name
  classification is an **inference**.
- The public FAQ (E15) states that uploaded files are stored on the service's servers for at most two hours
  and are then deleted. This is the site's own claim; we did not verify it.

**O-9 · Bot protection** (E4–E13)
- Tool pages embed a hidden reCAPTCHA anchor frame. **No interactive challenge or block page** was shown in
  any capture, and nothing was done to test or bypass it.

**O-10 · Page titles are descriptive and unique per tool** (E4–E13), e.g. "…online. Free service to merge
PDF", which is useful for our own `<title>` and metadata design.

### 3.2 Inferences (lower confidence)

- **I-1** The reference processes documents **server-side** (its own FAQ says files sit on its servers; tool
  pages offer cloud import/export and a progress bar). We did not observe an upload.
- **I-2** The tool entry state is minimal by design to keep attention on one action; marketing content is
  elsewhere.
- **I-3** A page's analytics request carried an A/B-variant flag in its query string, so other visitors may see
  different layouts than the one captured.
- **I-4** Several tools (Merge, Split, Compress, Organize…) accept multiple files and expose per-file
  actions after upload; Split/Protect/Edit take a single file. This follows from the wording in O-4 and O-5.

## 4. What was not examined

| Not examined | Why / consequence |
|---|---|
| **Upload, file list, options panel, processing state, download screen, error states** | REA's browser-scenario actions include navigate/click/fill/press/select/check/wait but **no file upload**, and we deliberately did not submit files to a third-party production service. Our implementations of these screens are **original design decisions**, informed by the public documentation text in O-5. They are *not* observations of the reference UI. |
| JavaScript bundles, source maps, internal/private API endpoints | Not exported or analysed (`export-web-scripts` / `analyze-javascript-application` were not run). Only request *metadata* was captured; no bodies, no header values. **No claim is made about how the reference is built.** |
| Authenticated pages, premium features, account limits, desktop/mobile apps | Out of scope; not accessed. |
| Other locales, other browsers, other geographies | One locale (`en-US`), one engine (Chromium 155), one network location, one day. |
| Below-the-fold pixels | Screenshots are single viewports; the rest of each page is known only from the DOM and accessibility text. |
| Behaviour after interaction (menus opening, filters switching) | No clicks were performed. The mega-menu markup was readable only because it is present in the closed DOM. |
| Why 3–11 requests per page failed | Observed (`request-failed` events) but not investigated; likely blocked or aborted in a headless, clean-profile session. |

REA's own limitations for these captures (verbatim from the Evidence) are listed in the JSON index
(`evidence_limitations_reported_by_rea`).

### Recommended follow-up, if more detail is wanted

Capturing the *interactive* states (upload → options → processing → download → errors) would need either
(a) your explicit authorisation to run a scripted flow against the live service, or, better, (b) a
**user-driven passive capture**: you operate the flow manually in your own browser while REA's
`list-browser-targets` / `observe-web-session` record it. REA states that such observation is passive and does
not click or navigate for you. We have not done either.

## 5. Implementation decisions

| Observation | Decision | Why |
|---|---|---|
| O-4: one-purpose entry screen with a dominant action | Same *pattern* (it is generic UX), built from our own components and tokens, plus a visible privacy line | Familiar and fast; the privacy line states what is actually true for each tool |
| O-4: copy differs for one vs. many files | `multiple` on each tool definition drives labels, validation and list behaviour | Correct grammar and behaviour by tool arity |
| O-4: hidden `accept=".pdf"` input | A real `<button>` that opens a visually-hidden-but-focusable input; the `accept` list comes from the tool; **plus** magic-byte validation | The extension is not proof of content; keyboard and screen-reader users get a real control |
| O-1: seven mega-menu groups | Six categories: Organize, Optimize, Convert to PDF, Convert from PDF, Edit, Security. No "Intelligence", no "Workflows" | We ship no AI/third-party services and no accounts, so those groups would be placeholders |
| O-1: tool + modes (`#split,extract`) | One route per tool, with modes inside the page; separate catalogue entries may open the same tool in a preset mode (e.g. Rotate, Delete pages) | Discoverability without duplicated engines |
| O-2: category filter row + card grid | Search box (required) + category chips + card grid; live filtering; `?q=` and `?category=` in the URL | Searchable catalogue is a requirement |
| O-6: 5 / 3 / 1 columns; hamburger ≤ tablet | `auto-fill` grid (`minmax`), hamburger menu below 900 px, 44 px touch targets | Matches the observed ranges; works on every width, not just three |
| O-5: thumbnails, click to mark, colour frames per file | Page-thumbnail grid with selection, drag reorder, rotate, delete; per-file colour accents when several PDFs are loaded | Proven workflow for Organize / Extract / Delete |
| O-5: Compress levels | Light / Recommended / Strong, plus an explicit "image-based" mode; the **real before/after size** is shown, and "no reduction" is reported as such | Never present a failed reduction as success |
| O-5: Split ranges, extract-all, optional merge | Modes: custom ranges (with *merge into one PDF*), every N pages, every page | Parity of capability |
| O-5: JPG→PDF orientation/margin/merge | Orientation, page size, margin, EXIF orientation handling, one PDF or one per image | Parity, plus correctness for phone photos |
| O-5: Office conversions are server work | Word/Excel/PowerPoint → PDF through **self-hosted LibreOffice**; the UI asks `/api/capabilities` and disables the tool with a clear explanation when the engine is missing | Reliable open-source engine; no pretending |
| O-8, I-1: server-side processing, ad networks on tool pages | **Process in the browser by default; zero third-party requests**; server only for conversions that need LibreOffice, with immediate temp-file deletion, size limits and rate limits | A real privacy differentiator, and a stated requirement |
| O-7: link used as button, unlabeled input, image with no name | Real buttons, labelled inputs, `aria-live` status messages, keyboard-sortable lists, visible focus, `prefers-reduced-motion` | Accessible by construction |
| O-10: unique descriptive titles | Per-route `<title>` and meta description | Navigation clarity and discoverability |
| Originality | Own name (LanternPDF, first called Sheaf), logo, palette (indigo/teal, **not** red), typography, icon set and layout; generic functional tool names only | Brief: original branding, no proprietary assets |

## 6. Originality statement

No proprietary source code, logos, brand names, icons, imagery or copy from the reference are used. Names such as
"Merge PDF" or "Compress PDF" are generic descriptions of functions. The visual identity, component code,
copywriting and information design in this repository are original work.
