# Phase 2 gap analysis

Written for the maintainers. It compares what the repository does today (end of Phase 1) with the Phase 2 brief, and
sets the order of work. The **Status** column is updated as work lands and is the source for the final report; a row
is only marked *done* when a test in this repository exercises it.

Legend: **have** = exists and is tested today · **partial** = exists but does not meet the brief · **new** = nothing
exists · **done** / **partly** / **not done** = Phase 2 outcome (filled in at the end, with the reason).

## 1. What exists after Phase 1

23 tools, each a page under `/tools/:id`, all running in the browser except the three Office-to-PDF converters
(optional self-hosted LibreOffice) and the optional Ghostscript recompression:

merge, split, extract, delete, organize, rotate, crop, compress, PDF↔JPG, text/page-number/image watermark, protect,
unlock (password supplied, authorisation ticked), metadata, repair, edit (annotation overlay), Word/Excel/PowerPoint
to and from PDF.

Engines: qpdf (WebAssembly) for structure, @cantoo/pdf-lib for drawing and forms, pdf.js for rendering and text
extraction, per-job Web Workers with cancel-by-terminate, a content-stream *image* scanner used by Compress.

Verified at the end of Phase 1: typecheck, lint, 289+ unit tests, E2E suites for every tool, responsive layouts at
360/412/768/1280 px.

## 2. Gaps against the Phase 2 brief

| # | Brief item | Today | Gap | Plan (slice) | Status |
|---|---|---|---|---|---|
| 1 | REA verification and research, `docs/research/phase-2.md` | Phase 1 reference analysis only | Phase 2 research | Done in [`research/phase-2.md`](research/phase-2.md) | done |
| 2 | Everything free | No gating exists; limits are technical | Make it provable: a test that fails if gating wording or counters appear; document each limit with its reason | S0 | |
| 3 | Full-screen editor: accurate canvas, zoom/fit/pan, thumbnails, single and continuous modes, selection, contextual toolbar, properties panel, shortcuts, undo/redo history, unsaved indicator, responsive | A page-embedded annotation overlay: fit/zoom, a few tools, undo | **new** unified editor (`/editor`) | S2–S3 | |
| 4 | Object manipulation: select, drag, resize, rotate, duplicate/copy/paste/delete, multi-select, align, snapping, z-order, numeric X/Y/W/H, correct transforms at every zoom | Single selection, move, resize, duplicate, front/back | rotation, multi-select, align, snap guides, copy/paste, numeric fields, geometry module with tests | S3 | |
| 5 | Genuine existing-text editing | None. (Phase 1 offered cover-then-retype and said so.) | **new** content-stream engine: interpreter, fonts, A/B/C verdicts, in-place rewrite, overflow handling, search | S1 (engine) then S4 (UI) | |
| 6 | Text boxes (borders, fills, padding, radius, line height, alignment, rotation, opacity); images (insert, crop, rotate, opacity, replace, delete existing); shapes and markup; comments | Basic text, image, rect, ellipse, line, arrow, pen, highlight, cover | Richer properties; underline/strikeout/comment as real annotations; crop and replace for images; delete existing image | S3, S5 | |
| 7 | **True redaction** and a clearly different visual cover | Cover only (and says so) | **new** engine redaction with verification and rasterise fallback | S5 | |
| 8 | Object inspection layer | None | **new** (text runs, images, links, annotations, form fields, vector extents) | S1, S5 | |
| 9 | Page management: insert blank, add pages from another PDF, duplicate, delete, reorder, rotate, crop, extract, replace, resize, preview; keep labels/links/forms | A separate "organize" tool (reorder/rotate/delete); crop tool; extract tool | Move into the editor's page panel; add insert, duplicate, replace, resize; preserve page labels, links, outlines where pdf-lib allows | S4 | |
| 10 | Form editor: detect, fill, create fields, flatten on request, signature-field caveat | Not present | **new** | S5 | |
| 11 | Privacy and security: local processing, validation, malformed-PDF defences, no persistence, object-URL revocation, temp cleanup, no logging of contents | Mostly in place for Phase 1 tools | Extend to the editor (no persistence, revocation, resource caps in the engine, a network-boundary test) | S6 | |
| 12 | Advanced tools: OCR, compare, duplicate-page finder, print-ready output, search/extract text, batch, export selected pages | No OCR, compare, duplicates, batch, search, print-ready | **new** where practical (OCR self-hosted tesseract.js; compare and duplicates by text and render hash; print-ready = flatten + page boxes; batch = queue of existing operations) | S7 | |
| 13 | Office conversion with documented installation and tested quality | Done with test doubles; LibreOffice not installed here | Keep the honest "not verified against a real LibreOffice here" wording unless it can be installed | S7 | |
| 14 | Performance: workers, visible-first, lazy thumbnails, render cache with memory limit, debounce, cancel stale tasks, release resources, progress, large-file warning, **recorded benchmarks** | Workers + per-job cancel; shared document cache; render limiter | Render cache with a byte budget; stale-render cancel; benchmark script and recorded results | S6 | |
| 15 | Unified workflow: open once, many operations; **never overwrite the original; explicit "Download as"** | Tool-per-page; hand-off between tools exists | The editor holds the document; "Use another tool" hands the current result over without re-upload; export always a new download | S2 | |
| 16 | Design: onboarding, empty states, light/dark, mobile page navigation, keyboard access, unsaved warnings, error recovery, no decorative controls | Good base | Apply to the editor; audit for disabled-pretend controls | S2–S4 | |
| 17 | Tests: fixtures for text, fonts, rotated text, tables, images, forms, scans; edit/export/reopen; visual regression; malformed; large-document cancellation; privacy | Unit and E2E for Phase 1 tools | **new** fixtures, engine tests, editor E2E, visual regression harness | every slice | |
| 18 | Docs: README commands, feature matrix, deployment, licences | README is thin; no Docker; no licences file | Write them against what exists | S8 | |

## 3. Order of work and why

1. **S0 Free audit.** Cheap, and it fixes the rules the rest is built under.
2. **S1 Text engine (headless).** The riskiest piece and the one the whole brief turns on. Built and tested without
   any UI first, against fixtures made by different PDF generators, so surprises about real PDFs appear early.
3. **S2 Editor shell.** Route, session model, canvas with accurate transforms, zoom/fit/pan, thumbnails, single and
   continuous views, history, dirty indicator, "Download as".
4. **S3 Objects.** Selection model, text boxes, images, shapes, markup, properties panel, align/snap/z-order.
5. **S4 Text editing and pages in the UI.** Run overlay, verdicts, search; page panel operations.
6. **S5 Forms, redaction, inspection.**
7. **S6 Performance and privacy hardening**, with benchmarks recorded.
8. **S7 Advanced tools** (OCR, compare, duplicates, print-ready, batch, search/extract).
9. **S8 Docs, licences, final verification.**

If time runs out, the later slices are the ones reduced, and the final report says exactly which. The text engine,
the canvas and the redaction are not allowed to be reduced to a demo.

## 4. What we will not claim

- That every PDF can have its text edited. The engine reports a verdict per line (A, B or C) and a supported/
  unsupported matrix by PDF type with measured results.
- That a signature field is a valid digital signature. It is a placeholder for another tool to sign.
- That Office conversions were checked against LibreOffice, if LibreOffice is not installed where the tests ran.
- That any feature is complete without a test that exercises it.
