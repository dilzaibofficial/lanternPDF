// The legacy build ships an empty .d.mts; reuse the main build's type declarations.
declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export * from "pdfjs-dist";
}
