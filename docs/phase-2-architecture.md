# Phase 2 architecture: the editor and the text engine

Written for developers extending LanternPDF. It describes how the editor shows a PDF, how an edit becomes bytes, and
where each piece lives. It was written before the build and is revised as the code lands; where the code differs,
the code wins and this file is corrected.

## 1. Principles

1. **The source is immutable.** The bytes the user opens are never modified or written back. Every export is a new
   download with a name the user chooses.
2. **What you see is what the engine produced.** The canvas shows pdf.js rendering the *real output* of the engine
   for pages that have engine-level edits. There is no separate "preview illusion" that can disagree with the export.
3. **Local first.** Parsing, editing, rendering and export run in the browser. Nothing leaves the device. The only
   server features are the optional Office converters and Ghostscript recompression.
4. **Honest verdicts.** For each piece of existing text the engine says whether it can edit it in place, rebuild it
   or not edit it at all, and why.
5. **No pretend operations.** Every export is re-opened and checked (page count, text, requested changes) before it
   is offered.

## 2. Layers

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ Editor UI (React)           src/editor/**                                           │
│   shell · canvas · thumbnails · toolbar · properties · dialogs · shortcuts          │
├────────────────────────────────────────────────────────────────────────────────────┤
│ Editor state (pure TS)      src/editor/model/**                                     │
│   document model · objects · operations · history · geometry · selection · snapping │
├────────────────────────────────────────────────────────────────────────────────────┤
│ Page engine (pure TS)       src/lib/pdf/engine/**                                   │
│   tokenizer · fonts · interpreter · lines · text edit · redaction · inspection      │
├────────────────────────────────────────────────────────────────────────────────────┤
│ Existing operations         src/lib/pdf/*.ts  (merge, split, crop, forms, security…)│
├────────────────────────────────────────────────────────────────────────────────────┤
│ Libraries                   pdf.js (render, text) · @cantoo/pdf-lib · qpdf-wasm      │
└────────────────────────────────────────────────────────────────────────────────────┘
```

* The **engine** and the **model** have no DOM or React dependency, so they are tested in Node and run unchanged in
  a worker.
* The **UI** never edits PDF bytes. It dispatches model operations; the engine turns the model into bytes.

## 3. Document model

A session holds:

| Part | Meaning |
|---|---|
| `sources` | Immutable input PDFs: the opened one and any added later. Each has an id, a name, its bytes, and (in memory only) a password. |
| `pages` | An ordered list of page references: `{ id, source, index }` or a blank page `{ id, blank: { width, height } }`, plus per-page *view-level* state: rotation delta, crop box, size override. |
| `objects` | The user's added objects (text boxes, images, shapes, markup, comments, form fields, cover boxes, redaction marks). Each belongs to a page and has a z-order. Coordinates are **display points**: origin top-left of the page as first displayed, y down. |
| `textEdits` | Edits of *existing* text, keyed by page id and by the engine's stable line id. |
| `contentEdits` | Other engine-level changes to existing content: deleted images, replaced images, removed annotations, filled form values. |
| `view` | Active page, zoom mode, view mode (single or continuous), tool, selection. Not part of undo. |

All of this is an immutable value. **History** keeps the previous values (structural sharing keeps that cheap) plus a
labelled **operation record** for each step (`{ type, label, pageId, at }`), so there is a visible list of what was
done, and merge keys let a drag or a burst of typing count as one step. Undo and redo swap values.

The unsaved indicator compares the current history position with the position at the last export.

### Why display points?

Rotation, CropBox offsets and `UserUnit` make PDF user space awkward. The model stores what the user sees. One
module, `geometry.ts`, converts between three spaces and is tested at several zooms, rotations and offsets:

* **screen**: CSS pixels relative to the page element
* **display**: points, top-left origin, y down (the model)
* **user**: PDF user space, bottom-left origin, honouring CropBox, `/Rotate` and `UserUnit` (export)

Pages added to the model are never re-based when the user rotates them in the editor: the rotation is a property of
the page that rotates the whole stage (page image and objects together), and is written to `/Rotate` at export.

## 4. Rendering

* One pdf.js document per source (shared cache, already present). Pages that need no engine-level edit render from it
  directly.
* A page **with** engine-level edits renders from a *derived single-page PDF*: the engine copies the page (with its
  resources) into a new document, applies the edits, and returns bytes; pdf.js renders those. The derived document is
  cached by a hash of the page's edit set and thrown away with the rest of the render cache when over budget.
* The user's added objects are drawn in an SVG layer above the canvas. They are not baked into the render, which is
  what makes them selectable and movable.
* Continuous mode keeps placeholders at the right size for every page and renders only pages near the viewport.
  Thumbnails render lazily at low resolution and are cancelled when scrolled away.
* Canvas memory is bounded: a global pixel budget with least-recently-used release, and canvases are zeroed
  (`width = 0`) when released.

## 5. Export pipeline

```
sources ─▶ assemble pages (copyPages, blanks, rotation, crop, size)
         ─▶ engine edits per page (text edits, redactions, content deletions)
         ─▶ draw objects (text boxes, images, shapes) and write real markup annotations
         ─▶ forms (fill, create fields, flatten only if asked)
         ─▶ document options (metadata, compress, protect, print-ready) via existing operations
         ─▶ verify (reopen, page count, text of each edited line, nothing else changed) ─▶ download
```

Each stage is an existing or new function that takes bytes and returns bytes, so stages can be tested alone, and the
whole runs in a worker with progress and cancellation (terminate).

## 6. The text engine

### 6.1 Reading

1. `tokenizer.ts` turns a content stream into operations with **byte offsets** (operands and operator), handling
   strings, hex strings, arrays, dictionaries, inline images and comments.
2. `streams.ts` decodes a page's `/Contents` (one stream or an array) and form XObjects, remembers which stream each
   byte came from, and writes changed streams back (re-encoded with Flate).
3. `fonts/` builds a `FontModel` per font resource:
   * subtype (Type1, TrueType, Type0, Type3, MMType1), base font, subset tag, embedded program kind
   * code → Unicode: `ToUnicode` first, then `Encoding` (base encoding + `Differences` via glyph names), then the
     standard encodings; for composite fonts the CMap (Identity-H or an embedded/predefined one) and `CIDToGIDMap`
   * widths: `Widths`/`FirstChar`/`MissingWidth`, `W`/`DW`, or the standard-14 AFM metrics
   * which characters the font can still draw (see 6.3)
4. `interpret.ts` walks the operations while tracking the CTM, text state (`Tc`, `Tw`, `Tz`, `TL`, `Tf`, `Tr`, `Ts`),
   text matrix and line matrix, marked-content, form XObject recursion (with cycle and depth guards), and emits:
   * **text runs**, one per show operation: operator and byte span, decoded string, glyph boxes, font, size, colour,
     render mode, matrix, rotation, advance, and the enclosing `ActualText` if any
   * **image uses** (XObject images and inline images) with their matrices
   * **path extents** (bounding boxes of painted paths, for inspection and redaction)
5. `lines.ts` groups runs into **lines** (same baseline within tolerance, contiguous, same text object) and infers
   alignment from neighbouring lines. The line is what the user edits and what search matches; the line id is stable
   for a given content stream so edits survive re-analysis.

### 6.2 Verdicts

| | Meaning | Typical cause | What happens |
|---|---|---|---|
| **A** | Edit in place | Every run of the line decodes, uses a simple or composite font we can re-encode, and the new characters exist in that font | The show operation's string is rewritten with the font's own codes. Layout, colour, kerning of untouched parts and `ToUnicode` are untouched. |
| **B** | Rebuild the run | A needed character is not in the embedded subset; the font is Type3 or unsupported but decodes via `ToUnicode`; the user changed family/bold/italic | The old show operations are replaced by operations that draw the new text in a fallback font (base-14 for Latin, bundled DejaVu for the rest) at the same matrix, size and colour. Text stays real and searchable. The result is then checked by re-reading the page. |
| **C** | Not safe to edit | Text only exists as outlines or as part of an image (a scan), invisible OCR layer, vertical writing, shared form XObject used on several pages without consent, text with an unreadable encoding, inside a pattern or an annotation appearance, encrypted content we cannot rewrite | The line is shown as read-only with the specific reason and the alternatives: cover and retype, redact, run OCR first, or edit the shared form for all pages. |

### 6.3 Which characters a font can draw

An embedded **subset** contains only the glyphs the document used. The engine therefore trusts the font program and
the document, not the encoding table: for a subset it collects the codes actually used with that font anywhere in
the document (one scan, cached) and, for TrueType and CFF programs, which glyphs have outlines. For a **full**
embedded font it asks the font program (fontkit). For **non-embedded** standard fonts it asks the encoding. A new
character not in that set sends the affected characters through fallback (a mixed run): the rest of the line keeps
the original font.

### 6.4 Writing

* **Same font** (A): the string operand is replaced by hex bytes of the new codes (`Tj`), or the string elements of
  a `TJ` array are replaced while its numbers are kept for untouched parts.
* **Different font** (B): the show operation is replaced by `/Fx size Tf <…> Tj /Forig size Tf`, with the fallback
  font registered in the resources of the page or form the run came from.
* **Alignment**: left-aligned lines keep their start. For right-aligned and centred lines a leading `TJ` number shifts
  the pen without disturbing the line matrix, so later positioning operators stay correct.
* **Longer text**: the engine measures with the real font widths and looks at free space on the line (next run or page
  margin). It then follows the user's choice: grow, condense with `Tz`, or reduce the size, and it states when the
  result would collide with something or leave the page.
* **Old glyphs** disappear because the old operand is replaced, not covered. A test extracts text, searches the raw
  decoded streams, and compares renders to prove it.
* The changed stream is written back as a new Flate stream; unchanged streams are untouched.

### 6.5 What it will not do

Reflow paragraphs across lines, edit text inside images (OCR is a separate tool), edit Type 3 or vertical text,
or promise visual identity for fonts it had to replace. These show as verdict B with the replacement named, or C.

## 7. Redaction

Cover and redact are different objects with different names, colours and warnings.

**Redact** removes content under the marked rectangle before anything is drawn:

1. Text glyphs whose boxes intersect the rectangle are removed from the show operations; a `TJ` number takes the
   place of each removed glyph's advance so following text keeps its place.
2. Images that intersect are decoded, the covered pixels are filled, and the image is re-encoded as a new XObject
   used only at that placement (the original is not touched for other uses).
3. Annotations whose rectangle intersects are removed.
4. Vector graphics, shadings and patterns under the rectangle cannot be removed surgically. If any intersect, the
   page is **rasterised** (rendered to an image with the black boxes burned in) and the user is told that page loses
   its text layer.
5. Optionally strip metadata, thumbnails, embedded files and previous revisions.
6. **Verification:** the output is re-opened, the text under every rectangle is extracted again, and the export fails
   (with an explanation) if any removed string is still found by extraction or in the decoded streams.

## 8. Privacy and resource safety

* No analytics, no CDN, no third-party requests; a test fails the build if a page makes one.
* Nothing is persisted (no IndexedDB, no localStorage of document data); object URLs are revoked on release;
  passwords are held in memory only and dropped with the session.
* Engine limits (stream size after decompression, operations per stream, form recursion depth, glyph count per page,
  page count for expensive analysis) turn decompression bombs and malformed input into a clear error instead of a
  frozen tab. They are listed in `src/config/limits.ts` with the reason for each.
* The server, where used, keeps files in per-job temp directories, deletes them when the job ends, and never logs
  document content, names or passwords.

## 9. Testing strategy

* **Fixtures** (`npm run fixtures`) are generated, not downloaded: pdf-lib (standard fonts, embedded full TrueType),
  Chromium print-to-PDF (subset TrueType, `ToUnicode`, rotated text, tables, images, links), a hand-written Type 1
  document with a `Differences` encoding and kerning, a scan (image only), a form, rotated and cropped pages, a
  password-protected file and several deliberately malformed ones.
* **Interpreter checks** compare our line positions with pdf.js text items for every fixture.
* **Edit checks** assert, per fixture: new text extracts correctly; old text is gone from extraction and from the raw
  streams; every other text item is unchanged; the output reopens in qpdf (`--check`) and in pdf.js.
* **Visual regression** renders original and edited pages and compares pixels *outside* the edited region (must be
  identical within a small anti-aliasing tolerance) and inside it (must change), and stores the diffs of failures.
* **Editor E2E** covers select, drag, resize, rotate, undo/redo, page operations, form filling, export and reopen.
* **Performance** is measured by script on generated small, medium and large documents; results are copied into
  `docs/performance.md` as measured, with the machine described.
