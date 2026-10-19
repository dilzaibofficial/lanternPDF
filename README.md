# LanternPDF

Free online PDF tools and a PDF editor that run in your browser. Merge, split, compress, convert, edit, redact and protect PDFs without signing up and without uploading the file.

Domain: **lanternpdf.com** · Source: [github.com/dilzaibofficial/lanternPDF](https://github.com/dilzaibofficial/lanternPDF) · License: [MIT](./LICENSE)

> Status: the app is built and tested; the public site is being set up. Anything not finished is listed under [Known limits](#known-limits).

## What it does

23 tools in six groups. "Browser" means the file is processed inside your browser tab and never uploaded.

| Group | Tools | Where it runs |
| --- | --- | --- |
| Organize | Merge, Split, Extract pages, Delete pages, Organize pages, Rotate | Browser |
| Optimize | Compress, Repair | Browser (Compress also has an optional stronger mode that needs Ghostscript on a server you run) |
| Convert to PDF | JPG to PDF | Browser |
| | Word (.docx), Excel (.xlsx), CSV and PowerPoint (.pptx) to PDF | Browser. An optional LibreOffice mode on a server you run also accepts older .doc, .xls and .ppt files |
| Convert from PDF | PDF to JPG, PDF to Excel | Browser |
| | PDF to Word, PDF to PowerPoint | Browser (text mode); optional layout mode needs LibreOffice on a server you run |
| Edit | Edit PDF (the editor), Add page numbers, Add watermark, Crop | Browser |
| Security and info | Protect (AES), Unlock (needs the password; it never guesses or cracks), Metadata | Browser |

### The editor (`/editor`)

- Edit the text of an existing line in place, so it is rewritten inside the page instead of being covered by a box.
- Select, move, resize, rotate, delete and re-order objects that are already in the PDF (images, shapes, text blocks, annotations).
- Add text, images, shapes, drawings and notes; align and distribute; use an image as a page background; merge edits into the page.
- **Redaction that removes the content**: text, images and shapes under a redaction box are removed from the file and the result is checked again before you can download it. Where the content cannot be removed safely, the tool says so instead of pretending.
- Your original file is never changed. You download a new copy.

## Privacy model

- Browser tools use WebAssembly and Web Workers; documents stay in memory in the tab.
- The optional server (for the Office conversions and the stronger compression mode) is only used by the tools that say so on their page. Files are written to a private temporary folder, converted, returned, and deleted when the response ends.
- Passwords you type stay in memory and are never stored or sent anywhere.

## Quick start

Needs Node.js 22.13 or newer (see `.nvmrc`).

```sh
npm install          # also copies the PDF.js assets into public/pdfjs
npm run dev          # web app on http://localhost:5173, API on http://127.0.0.1:8787
```

Production build and the Node server (serves the built site and `/api`):

```sh
npm run build        # web app + server
npm start            # http://127.0.0.1:8787
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Web app and API with live reload |
| `npm run build:web` | Builds the web app into `dist/` |
| `npm run build` | Web app and server |
| `npm start` | Runs the built server |
| `npm test` | Unit tests (Vitest) |
| `npm run test:e2e` | Browser tests (Playwright; uses the Microsoft Edge that is installed on the machine) |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript, all projects |
| `npm run fixtures` | Rebuilds the PDF files the tests use |

Configuration for the server is in `.env.example`; every value is optional.

## Optional engines (self-hosting)

- **LibreOffice** is an optional second mode for Word, Excel and PowerPoint to PDF (and opens older .doc, .xls and .ppt files), and enables the layout modes of PDF to Word and PowerPoint.
- **Ghostscript** enables the stronger compression level.

Neither is bundled. The server detects them at start-up, and a tool that needs a missing engine tells the person so before they pick a file. See `/self-hosting` in the app.

## Project layout

```text
src/            web app (React, React Router)
  editor/       the PDF editor: model, state, views, engine worker
  lib/pdf/      PDF engine: content-stream reader and writer, redaction, forms, export
  tools/        one folder per tool
server/         optional Express server (conversions, compression)
shared/         types shared by the app and the server
tests/          unit tests, browser tests and test PDF files
docs/           architecture notes, research, SEO plan and evidence
scripts/        build helpers and SEO tooling (scripts/seo)
```

## Known limits

These are real, and the app says so where it matters.

- PDF to Word and PDF to Excel recover text and simple tables, not the original layout. Scanned pages are not read: there is no OCR yet.
- Word, Excel and PowerPoint to PDF are converted by LanternPDF's own engine, not by Microsoft Office or LibreOffice. Text, fonts (matched to look-alikes with the same letter widths), lists, tables, pictures, headers and footers, number formats and merged cells are kept; PowerPoint slides keep their layouts, themes, backgrounds, bullets, shapes, tables, pictures and SmartArt. Text boxes, charts, SmartArt, equations and multi-column layouts in Word files, and charts, EMF/WMF pictures, effects such as shadows and some rare shapes in PowerPoint files, are not reproduced, and the result says so for each file.
- Form fields can be read, filled and created by the engine and are covered by unit tests, but the editor does not offer them yet.
- Crop has no on-page preview editor yet; OCR, document compare, duplicate-page finder, print-ready export and batch processing are not built.
- Redaction removes text, images and shapes it can remove safely. Partly covered vector art, images in unusual formats and content in shared reusable blocks are handled conservatively (removed whole, or reported), never silently kept.
- A Dockerfile is not included yet.
- Performance numbers have not been published because they have not been measured yet.

## Contributing

Issues and pull requests are welcome. Run `npm run lint`, `npm run typecheck` and `npm test` before opening one.

## License

MIT. Third-party components keep their own licenses; the About page in the app lists them.
