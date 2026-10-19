/** Everything about the product's identity lives here, so renaming it is a one-file change. */
export const BRAND = {
  name: "LanternPDF",
  domain: "lanternpdf.com",
  tagline: "Every PDF tool you need. Your files stay on your device.",
  /** The short pitch used in the footer, structured data and as the default meta description. */
  description:
    "Free online PDF editor and tools: merge, split, compress, convert, edit, redact and protect PDFs. No sign-up, no watermarks, and your files stay in your browser.",
  /** Public source code. Shown in the footer and in structured data. */
  repositoryUrl: "https://github.com/dilzaibofficial/lanternPDF",
  /**
   * The public contact address shown on the Contact page. The mailbox has to exist (for example as a forward at the
   * domain registrar) before the site is launched; see docs/seo/production-checklist.md.
   */
  contactEmail: "hello@lanternpdf.com",
} as const;
