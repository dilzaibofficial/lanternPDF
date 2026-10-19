# Phase 2 research: what people actually struggle with in online PDF editors

Written for the people who will maintain and extend LanternPDF. It records what we looked at, what we could and could
not establish, and the decisions that follow. Phase 1's investigation of the reference site is in
[`../reference-analysis.md`](../reference-analysis.md); this document extends it and does not repeat it.

Access date for every source below: **2026-10-18** unless a different date is shown.

> **What this document does not claim.** We did not see the inside of the reference site's editor: reaching it needs
> an uploaded document, and we deliberately uploaded nothing (see [§2](#2-boundaries-we-kept)). We did not inspect
> its source code, bundles or private APIs. Everything about its editor comes from its own public help text,
> public blog posts and a public store listing, each cited. Where a source is a search-tool summary rather than the
> page itself, it says so.

## 1. Tool verification (REA)

| Check | Result |
|---|---|
| Skill `reverse-engineer-anything` | Present at `~/.claude/skills/reverse-engineer-anything` and loaded in this session. |
| REA package | `rea-agents@6.7.0`, run through `npx`. |
| `rea doctor --client claude_code` (read-only) | `healthy: true`; Node 24.20.0; Claude Code registration present in `~/.claude.json`. Native-analysis engines (Hopper, Ghidra, IDA, JADX, Kuna) are not configured here. They are irrelevant to browser observation, and nothing was installed. |
| REA MCP tools in this session | **Not attached.** The registration exists but the already-running session was not restarted, so the MCP tools never appeared. We did not change any client configuration. |
| Route used instead | The documented CLI fallback: `rea capture-browser-scenario <scenario.json> --format json`, driven by [`scripts/rea-capture.mjs`](../../scripts/rea-capture.mjs). |
| Operation | `capture_browser_scenario`: one bounded browser scenario per page, returned as Evidence (`confidence: observed`). |

The doctor output also lists other clients (Codex, Copilot CLI, VS Code, Claude Desktop) as having configuration
drift. That is about REA's registration in those programs, not about this project, and was left alone.

## 2. Boundaries we kept

Same rules as Phase 1, restated because Phase 2 touches more pages:

- Public pages only; **navigation only**. Every scenario is "load, wait 3.5 s, capture". No click, no typing, no
  upload, no form submission, no scrolling inside an app.
- One page at a time, about 4.5 s apart. Eight loads in total for this phase.
- No attempt to defeat or probe bot protection, consent walls or paywalls. The Play listing was loaded once, as any
  visitor's browser would load it.
- No analysis of the reference's JavaScript bundles or network payloads. REA retained request *metadata* (method,
  URL, resource type, header **names**) and no bodies or header values.
- Nothing from the reference is copied into this repository: no markup, copy, icons, screenshots or code. Raw
  artifacts stay in the git-ignored `docs/evidence/raw/`. The committed index
  ([`../evidence/rea-evidence-index-phase-2.json`](../evidence/rea-evidence-index-phase-2.json)) holds identifiers,
  digests and counts only.
- Reddit and Stack Exchange could not be read by our tools (the fetch tool refused Reddit; the search tool refuses
  the Stack Exchange domains). We did not try to get around either.

## 3. Evidence collected in this phase

All captures: `completeness: complete`, Chromium 155 (Edge, headless, temporary profile), `en-US`, UTC, light mode,
reduced motion, service workers blocked. Full IDs and SHA-256 digests are in the index file.

| # | Scenario | Page | Viewport | Evidence ID (prefix) | Requests | Origins |
|---|---|---|---|---|---|---|
| E16 | `phase2-blog-edit-pdf-text` | ilovepdf.com/blog/edit-pdf-text | 1440×900 | `ev_f1ba660e8f81…` | 30 | 4 |
| E17 | `phase2-blog-advanced-editing` | …/blog/new-advanced-pdf-editing-ilovepdf | 1440×900 | `ev_7dec6d6441f3…` | 29 | 4 |
| E18 | `phase2-blog-mobile-apps` | …/blog/pdf-editor-android-ios | 1440×900 | `ev_a3b840842618…` | 29 | 4 |
| E19 | `phase2-help-documentation` | …/help/documentation | 1440×900 | `ev_db218b662155…` | 50 | 4 |
| E20 | `phase2-pricing` | …/pricing | 1440×900 | `ev_8d97eedf8fec…` | 58 | 4 |
| E21 | `phase2-edit-tablet` | …/edit-pdf | 820×1180 | `ev_c20f47b3f59b…` | 45 | 16 |
| E22 | `phase2-edit-mobile` | …/edit-pdf | 390×844 | `ev_df90e452a9c5…` | 46 | 17 |
| E23 | `phase2-play-listing` | play.google.com/store/apps/details?id=com.ilovepdf.www | 1440×900 | `ev_5f9fde93104f…` | 81 | 9 |

### 3.1 Observations (what the captures show)

**R-1 · The editing features the reference advertises** (E16, E17, E18, E19; its own pages, dated 2025-05-30,
2025-06-27 and 2026-02-27)
- Editing *existing* text "directly", with font, size, colour, alignment and hyperlink control, was added to the
  web editor in 2025 and extended in February 2026. The mobile app calls it a "Content Editor".
- Also advertised: new text, images, links, shapes, emoji, freehand drawing; highlight, underline, strikeout,
  squiggly, freehand highlighter; redaction (mobile); signing; form-field creation (signature, text, checkbox,
  radio, list box); attachments; bookmarks; review of digital-certificate properties.
- Its own help text describes the editor's structure: a top toolbar; a page-setup control for single-page versus
  multi-page view; a hand tool for panning; zoom in and out; Text, Image and Shape tools; per-object property bars
  (colour, transparency, border colour, rotation, format, line thickness); one "Edit PDF" button that processes the
  file. The mobile app lets the user move the toolbar to the top, left or right.
- Its own guidance says to edit directly when the layout must stay identical and to convert when restructuring
  heavily. Same advice we give.
- **Inference, not observation:** the blog posts state formatting is preserved. We could not test that claim, and
  Play reviews below show it is not always reachable for free users.

**R-2 · What is free and what is not, in the reference's own words** (E20, public pricing page)
- The free plan is labelled "limited document processing". The paid plan lists "unlimited document processing",
  "ad-free experience", "priority customer support" and other items.
- A per-task table: on the free plan, **Edit PDF is limited to 1 file per task and 100 MB**, Redact PDF 1 file and
  400 MB, Compare PDF 2 files and 400 MB, PDF Forms 1 file and 15 MB (100 MB paid), Word/Excel/PowerPoint↔PDF and OCR
  15 MB (4 GB paid), Merge 25 files and 100 MB, Split 1 file and 100 MB.
- Observation only: we did not check whether those numbers match what a free user meets in practice.

**R-3 · What the editing page does before the user does anything** (E21, E22)
- On a tablet-size and a phone-size viewport the Edit PDF landing page shows one heading, one sentence, a
  "Select PDF file" link and a "Choose File" button, and nothing else. No editor is present until a file is chosen.
- Merely loading that page made **45 requests to 16 origins (tablet) and 46 to 17 origins (phone)**. About a dozen
  of those origins are advertising or ad-exchange hosts (`doubleclick.net`, `criteo`, `openx`, `adsrvr`, `adform`,
  `creativecdn`, and similar) plus analytics (`google-analytics`, `googletagmanager`). The same loads of the blog
  and pricing pages contact only 4 origins, none of them ad exchanges.
- **Limit of the evidence:** REA retained request metadata only. We know the requests happened. We do **not** know
  what data they carried or whether any of it related to a document; no document existed at that point.

**R-4 · Public store listing** (E23, loaded once; dated 2026-10-18)
- 4.6 stars, about 334 000 reviews, 10M+ downloads, "In-app purchases", last updated 2026-09-15. The developer
  declares "No data shared with third parties" (developer-provided, not verified by us).
- The listing's first load shows three reviews and one developer reply. Paraphrased, with dates:
  - 2026-09-01, positive: free tools saved time; the reviewer "understood the daily limits" and worked around them
    to avoid spending the free allowance early.
  - 2026-08-28, negative: "usage limit"; no way to open one document and do several operations; the user has to
    choose the operation before choosing the file; and the app overwrites the original file without asking.
  - 2026-08-11, negative: could not save an edited PDF without subscribing; objected to a recurring fee for
    occasional edits.
  - 2026-08-28, developer reply to the second complaint above: the content editor is a Premium tool and its icon
    carries a small "Premium" stamp.
- These are the only reviews the first load displays. We did not scroll, expand or page through the rest.

### 3.2 Secondary sources

These were read through search or fetch tools that return summaries, so wording below is our paraphrase of a
tool-produced summary, not a quotation of the page. Treat counts as indicative. Competitor "alternative" pages were
excluded as evidence because they are marketing.

| Source | Date | What it tells us |
|---|---|---|
| Trustpilot, iLovePDF page | rating 4.9 from ~13 900 reviews; 24 cards visible on 2026-10-18 | Visible praise: ease of use (9 of 24), free with no sign-up (8 and 4 of 24), speed (3), output quality (6). One 1-star review on 2026-10-14: an attempt to edit a 197 MB PDF failed. No visible complaints about billing in this sample. A small recent sample, not the whole picture. |
| Capterra / G2 / TrustRadius / Software Advice snippets via search | 2024 to 2026, various | Recurring: advanced or "major" editing and OCR are Premium; free-version limits on file size and daily use; premium pricing seen as high; limits editing pre-existing content (TrustRadius); layout shifts after PDF-to-Word; slow with large files. Capterra itself returned HTTP 403 to our fetch tool and was not read directly. |
| Hacker News, "Show HN: Free, in-browser PDF editor" comments | 2025-05-03/04 | The top complaint: the tool *adds* text but does not *edit* existing text, and its "Edit PDFs" wording oversells. Explanations from commenters: PDF has glyphs at positions, not text blocks; subset fonts may lack the new letters; editing streams can break byte offsets. People want redaction that really removes text. Other tools that edit existing text upload files, which the author wanted to avoid. |
| Hacker News discussion of the article "So you want to modify the text of a PDF by hand" | article dated 2020; discussion date not captured | Content streams are drawing instructions; compression and xref offsets; font subsetting and encodings; the ToUnicode map governs copy and search; font substitution causes overflow. A commenter reports that PDFBox dropped its replace-text example because it suggested replacement is easier than it is (unverified by us). |
| Hacker News, "Ask HN: Open-source alternative to Adobe Acrobat?" | 2026 | People assemble qpdf, Okular, Preview, Stirling-PDF and others because no single free tool does page work, forms, signing and editing. |
| Hopding/pdf-lib issues #827, #564, #177, #581, discussion #1478 | 2021 to 2023 | Repeated requests to find/replace or remove text. pdf-lib cannot read or edit page text outside form fields. #827 (2021-03-16): hiding text under an image does not stop copying; closed by pointing to the README's limitations. |
| Stirling-PDF discussion #5222 | 2025-12-11 to 12-20 | A text editor in alpha: fonts "messed up", random spaces, overlapping paragraphs, saving failed ("No cached document found"), whole-document scrolling missing for a 300-page book. |
| Stirling-PDF PR #8235 | closed unmerged 2026-09-28 | Un-embedded serif text fell back to a sans-serif face; Symbol/ZapfDingbats needed their own fallback; a family missing from an allow-list silently rendered every weight as Regular. Fallback-font choice is a real quality problem. |
| Stirling-PDF issue #8020 | opened 2026-09-15 | Request for character-level editing: mixed fonts/colours in one box and correct character widths. Open. |
| BentoPDF issue #144 | 2025-11-07 to 2026-10-13 | Editing existing text asked for; the owner said PDF was not meant to be an editable format and that an HTML round-trip would break the formatting; LibreOffice Draw in WASM exceeds 150 MB. Closed when an edit-text feature shipped. |
| mozilla/pdf.js issue #22123 | opened and closed 2026-10-09 (PDF.js 6.4.299) | Editing an existing FreeText annotation to text with a character the annotation's font cannot encode updates `/Contents` but keeps the old appearance stream, so the edit appears to vanish. Same lesson as ours: what viewers draw is the appearance or the content stream, not a convenient text field. |
| Redaction failures: Manafort filing (2019-01); NSA redaction guidance (2005–2008) | various | Black boxes are a layer; the text underneath was recovered by copy and paste. NSA guidance, as summarised: black rectangles hide text only on a printed copy; metadata must be removed too. |

### 3.3 Limits of this research

- Reddit, the platform most likely to hold unfiltered complaints, was not readable by our tools; Stack Exchange
  likewise. The picture is therefore biased toward review sites, Hacker News, GitHub and the Play listing.
- The Play listing showed three reviews; Trustpilot showed 24. Neither supports statistics. The same complaints
  recur across independent sources, which is why we rely on them for prioritising, not for percentages.
- Review sites are self-selected. Trustpilot's visible sample is strongly positive about the free tools, and the
  complaints concentrate on editing, Premium gating and large files, which is the territory of this phase.
- Search-tool summaries sometimes describe a page we could not open. Where we could not open the primary page we
  said so above.

## 4. Recurring problems, and what we decided

Ranked by how many independent sources raise it and how directly it hits the editor.

| # | Recurring problem | Where it appears | Decision in LanternPDF |
|---|---|---|---|
| 1 | "Editing" that only overlays new text; existing text cannot really be changed; formatting breaks | HN 2025-05; Play 2026-08; TrustRadius; BentoPDF; Stirling #5222 | Real content-stream editing for existing text, with an honest per-run verdict: **A** in place, **B** rebuilt and verified, **C** not safe (explained, with an alternative). No white rectangle with a text box on top. |
| 2 | The editor or a key feature is Premium; saving or downloading is gated | Play 2026-08-11 and 2026-08-28 (developer confirms the stamp); Capterra/G2 | Nothing is gated. No accounts, no plans, no counters, no export wall, no watermark of ours. The only limits are technical (memory, time), shown in advance with the reason ([`src/config/limits.ts`](../../src/config/limits.ts)). |
| 3 | Daily or per-task usage limits | Play 2026-09-01; Sejda/Smallpdf; pricing page | No usage counting at all. Processing happens in the visitor's browser. The optional self-hosted server has a configurable rate limit that exists to protect the server, and says so. |
| 4 | Must pick the tool before choosing the file; one operation per upload; repeated uploads | Play 2026-08-28 | **One unified editor**: open the document once, then edit text, objects, pages and forms, and hand the result to any other tool without uploading again. |
| 5 | The original gets overwritten | Play 2026-08-28 | The source bytes are immutable for the whole session. Output is only ever a new download, named by the user ("Download as"). The editor never writes back to the file it opened. |
| 6 | Redaction that only covers text | HN 2025-05; pdf-lib #827; Manafort 2019; NSA | Two clearly different tools: **cover** (visual, says so) and **redact** (removes the text, image pixels and vector content underneath, then verifies by re-extracting). Where removal cannot be proven, the page is rasterised and the user is told. |
| 7 | Fonts: missing glyphs in subset fonts, wrong fallbacks, spacing | HN 2020 and 2025; Stirling #5222 and #8235; pdf.js #22123 | Check glyph availability per character against the actual font. Reuse the embedded font when it covers the new text; otherwise a bundled fallback chosen by the original's class (serif, sans, mono, symbol) and style, with the change reported to the user. Searchability kept through ToUnicode. |
| 8 | Large files fail or crawl | Trustpilot 2026-10-14; Software Advice | Work in workers, render visible pages first, cancel stale work, release memory, warn before heavy operations with the technical reason. Benchmarks are recorded, not invented. |
| 9 | Privacy uncertainty; ad-tech around the upload | R-3 above; HN 2025-05 | Local processing is the default for every editor feature. No third-party requests at all (self-hosted fonts and workers; enforced by a test). Clear "where does this run" wording. |
| 10 | Missing page management and image insertion in the same place as editing | Play 2026-08-28 | Page operations (insert, duplicate, delete, reorder, rotate, crop, replace, resize, extract) live in the editor's thumbnail panel, alongside image insertion. |
| 11 | Poor mobile experience; no undo; no real object selection | Phase 1 brief; pdf.js and Stirling issues | Pointer-event canvas with numeric properties, undo/redo over an operation log, touch-friendly page navigation, tested at phone, tablet and desktop widths. |

## 5. Technical research that shaped the engine

- **pdf-lib cannot edit page text** outside form fields (its README says so; confirmed by the issues above). We use it
  for the parts it is good at (documents, pages, forms, drawing, embedding) and write our own content-stream editor
  for text.
- **PDF.js reports where text was drawn, not which operator drew it.** It is the right tool for rendering,
  hit-testing and search. Editing needs the operator and its byte range, so the engine tokenises the content stream
  itself and tracks the text state (font, size, spacing, matrices, render mode) the way a renderer would.
- **Why subset fonts decide everything.** An embedded subset contains only the glyphs the original text used. Replacing
  "Hello" with "Help" works because every letter is in the subset; "Hex" may not. The engine therefore asks the font
  program, per character, before it writes.
- **Searchable text** depends on the font's `ToUnicode` map. Edits written with the original font keep its map;
  edits written with a fallback font carry a new one.
- **Licences considered.** pdf-lib (MIT) and @cantoo/pdf-lib (MIT), PDF.js (Apache-2.0), qpdf (Apache-2.0),
  fontkit (MIT), DejaVu fonts (free licence, redistribution allowed), Tesseract / tesseract.js (Apache-2.0),
  PDFium (BSD-3). **MuPDF is AGPL and was not used.** LibreOffice (MPL/LGPL) stays an optional separate process on
  the self-hosted server and is not bundled. Full list: [`../THIRD_PARTY.md`](../THIRD_PARTY.md) (kept up to date as
  dependencies change).

## 6. How this feeds the build

1. [`../phase-2-gap-analysis.md`](../phase-2-gap-analysis.md): what exists after Phase 1, what the Phase 2 brief
   adds, what we will not claim.
2. [`../phase-2-architecture.md`](../phase-2-architecture.md): rendering and modification architecture, the state
   model and operation log, and the text-editing pipeline with its A/B/C categories.
3. Tests and fixtures are listed against each decision above in the architecture document, and their results are
   reported in the final report. Nothing in this file is a test result.
