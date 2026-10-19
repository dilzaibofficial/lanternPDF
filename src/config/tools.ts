import type { IconName } from "../components/ui/Icon";

export type ToolCategoryId = "organize" | "optimize" | "to-pdf" | "from-pdf" | "edit" | "security";

export interface ToolCategory {
  id: ToolCategoryId;
  name: string;
  blurb: string;
}

export const CATEGORIES: readonly ToolCategory[] = [
  { id: "organize", name: "Organize", blurb: "Merge, split, reorder and clean up pages" },
  { id: "optimize", name: "Optimize", blurb: "Make files smaller or fix damaged ones" },
  { id: "to-pdf", name: "Convert to PDF", blurb: "Turn images and Office files into PDFs" },
  { id: "from-pdf", name: "Convert from PDF", blurb: "Turn PDFs into images and Office files" },
  { id: "edit", name: "Edit", blurb: "Annotate, number, watermark and crop" },
  { id: "security", name: "Security & info", blurb: "Protect, unlock and inspect documents" },
];

/**
 * Where the work happens:
 *  - `browser`          entirely on the user's device; the file is never uploaded
 *  - `optional-server`  on the device by default, with an extra mode when the server has the engine
 *  - `server`           needs the self-hosted server (and its LibreOffice install) to work at all
 */
export type ProcessingMode = "browser" | "optional-server" | "server";

export interface ToolDefinition {
  /** URL slug: /tools/<id> */
  id: string;
  name: string;
  /** One sentence for cards and search results. */
  short: string;
  /** Subtitle on the tool's own page. */
  description: string;
  category: ToolCategoryId;
  icon: IconName;
  /** File extensions the drop zone accepts, lower-case, with the dot. */
  accept: readonly string[];
  /** Human label for what the user should pick, e.g. "PDF files". */
  pickLabel: string;
  multiple: boolean;
  processing: ProcessingMode;
  /** Extra words people may search for. */
  keywords: readonly string[];
  /** Three short steps shown under the tool. */
  howTo: readonly [string, string, string];
  related: readonly string[];
}

const PDF = [".pdf"] as const;
const IMAGES = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"] as const;

export const TOOLS: readonly ToolDefinition[] = [
  // ---- Organize -------------------------------------------------------------------------
  {
    id: "merge",
    name: "Merge PDF",
    short: "Combine several PDFs into one, in the order you choose.",
    description: "Add your PDFs, drag them into order, and join them into a single document.",
    category: "organize",
    icon: "merge",
    accept: PDF,
    pickLabel: "PDF files",
    multiple: true,
    processing: "browser",
    keywords: ["combine", "join", "append", "concatenate"],
    howTo: ["Add two or more PDF files.", "Drag them (or use the arrows) into the order you want.", "Merge, then download the combined PDF."],
    related: ["organize", "compress", "split"],
  },
  {
    id: "split",
    name: "Split PDF",
    short: "Cut a PDF into separate files by page range, or every N pages.",
    description: "Split one PDF into several: by page ranges, every N pages, or one file per page.",
    category: "organize",
    icon: "split",
    accept: PDF,
    pickLabel: "a PDF file",
    multiple: false,
    processing: "browser",
    keywords: ["divide", "separate", "cut", "ranges", "burst"],
    howTo: ["Add one PDF.", "Choose how to split it: ranges, every N pages, or each page.", "Download the parts, together as a ZIP."],
    related: ["extract-pages", "delete-pages", "merge"],
  },
  {
    id: "extract-pages",
    name: "Extract pages",
    short: "Pull selected pages out into a new PDF.",
    description: "Pick the pages you want, by number or by clicking thumbnails, and save them as a new PDF.",
    category: "organize",
    icon: "extract",
    accept: PDF,
    pickLabel: "a PDF file",
    multiple: false,
    processing: "browser",
    keywords: ["select pages", "pull out", "take pages", "save pages"],
    howTo: ["Add one PDF.", "Click the pages you want, or type ranges like 1-3, 7.", "Download the new PDF."],
    related: ["split", "delete-pages", "organize"],
  },
  {
    id: "delete-pages",
    name: "Delete pages",
    short: "Remove the pages you do not need.",
    description: "Mark pages for removal, by number or by clicking thumbnails, and save what is left.",
    category: "organize",
    icon: "trash",
    accept: PDF,
    pickLabel: "a PDF file",
    multiple: false,
    processing: "browser",
    keywords: ["remove pages", "erase", "drop pages"],
    howTo: ["Add one PDF.", "Click the pages to remove, or type ranges like 2, 5-6.", "Download the PDF without them."],
    related: ["extract-pages", "organize", "split"],
  },
  {
    id: "organize",
    name: "Organize pages",
    short: "Reorder, rotate, duplicate and delete pages in a thumbnail view.",
    description: "See every page as a thumbnail. Drag to reorder, rotate, duplicate, delete, or insert blank pages.",
    category: "organize",
    icon: "layout",
    accept: PDF,
    pickLabel: "PDF files",
    multiple: true,
    processing: "browser",
    keywords: ["reorder", "rearrange", "sort", "arrange", "blank page", "duplicate page", "thumbnails"],
    howTo: ["Add one or more PDFs.", "Drag, rotate, duplicate or delete pages.", "Apply the changes and download."],
    related: ["rotate", "merge", "delete-pages"],
  },
  {
    id: "rotate",
    name: "Rotate PDF",
    short: "Turn pages 90°, 180° or 270°, all of them or only some.",
    description: "Rotate every page, or just the ones you select, then save a corrected PDF.",
    category: "organize",
    icon: "rotate",
    accept: PDF,
    pickLabel: "a PDF file",
    multiple: false,
    processing: "browser",
    keywords: ["turn", "flip", "sideways", "landscape", "portrait", "orientation"],
    howTo: ["Add one PDF.", "Rotate all pages, or select some and rotate those.", "Download the rotated PDF."],
    related: ["organize", "crop", "page-numbers"],
  },

  // ---- Optimize -------------------------------------------------------------------------
  {
    id: "compress",
    name: "Compress PDF",
    short: "Make a PDF smaller, and see exactly how much was saved.",
    description: "Reduce file size from a lossless clean-up to strong image compression, and see the real before and after sizes. A Ghostscript level is offered when your server has it.",
    category: "optimize",
    icon: "compress",
    accept: PDF,
    pickLabel: "PDF files",
    multiple: true,
    processing: "optional-server",
    keywords: ["reduce size", "shrink", "smaller", "optimize", "email", "file size"],
    howTo: ["Add one or more PDFs.", "Choose a level. A Ghostscript level appears when your server has it.", "Download, with the real before and after sizes shown."],
    related: ["merge", "repair", "protect"],
  },
  {
    id: "repair",
    name: "Repair PDF",
    short: "Try to recover a PDF that will not open.",
    description: "Rebuild the internal index of a damaged PDF so its pages can be read again.",
    category: "optimize",
    icon: "wrench",
    accept: PDF,
    pickLabel: "a PDF file",
    multiple: false,
    processing: "browser",
    keywords: ["fix", "corrupt", "damaged", "broken", "recover", "cannot open"],
    howTo: ["Add the damaged PDF.", "Run the repair.", "Check the recovered pages and download the result."],
    related: ["compress", "merge", "unlock"],
  },

  // ---- Convert to PDF -------------------------------------------------------------------
  {
    id: "jpg-to-pdf",
    name: "JPG to PDF",
    short: "Turn JPG, PNG and other images into one PDF.",
    description: "Combine photos and scans into a PDF. Set page size, orientation and margins. PNG, WebP, GIF and BMP work too.",
    category: "to-pdf",
    icon: "image",
    accept: IMAGES,
    pickLabel: "images",
    multiple: true,
    processing: "browser",
    keywords: ["image", "png", "photo", "picture", "scan", "webp", "convert to pdf"],
    howTo: ["Add your images.", "Put them in order and choose page size, orientation and margin.", "Create the PDF and download it."],
    related: ["merge", "compress", "pdf-to-jpg"],
  },
  {
    id: "word-to-pdf",
    name: "Word to PDF",
    short: "Convert DOC and DOCX documents to PDF.",
    description: "Convert Word documents to PDF using LibreOffice on the server you run.",
    category: "to-pdf",
    icon: "word",
    accept: [".doc", ".docx", ".odt", ".rtf"],
    pickLabel: "Word documents",
    multiple: true,
    processing: "server",
    keywords: ["doc", "docx", "document", "office", "libreoffice"],
    howTo: ["Add Word documents.", "Convert. They are sent to your server and deleted right after.", "Download the PDFs."],
    related: ["excel-to-pdf", "powerpoint-to-pdf", "merge"],
  },
  {
    id: "excel-to-pdf",
    name: "Excel to PDF",
    short: "Convert XLS and XLSX spreadsheets to PDF.",
    description: "Convert spreadsheets to PDF using LibreOffice on the server you run.",
    category: "to-pdf",
    icon: "excel",
    accept: [".xls", ".xlsx", ".ods", ".csv"],
    pickLabel: "spreadsheets",
    multiple: true,
    processing: "server",
    keywords: ["xls", "xlsx", "spreadsheet", "csv", "office", "libreoffice"],
    howTo: ["Add spreadsheets.", "Convert. They are sent to your server and deleted right after.", "Download the PDFs."],
    related: ["word-to-pdf", "powerpoint-to-pdf", "merge"],
  },
  {
    id: "powerpoint-to-pdf",
    name: "PowerPoint to PDF",
    short: "Convert PPT and PPTX presentations to PDF.",
    description: "Convert slide decks to PDF using LibreOffice on the server you run.",
    category: "to-pdf",
    icon: "powerpoint",
    accept: [".ppt", ".pptx", ".odp"],
    pickLabel: "presentations",
    multiple: true,
    processing: "server",
    keywords: ["ppt", "pptx", "slides", "presentation", "deck", "office", "libreoffice"],
    howTo: ["Add presentations.", "Convert. They are sent to your server and deleted right after.", "Download the PDFs."],
    related: ["word-to-pdf", "excel-to-pdf", "merge"],
  },

  // ---- Convert from PDF -----------------------------------------------------------------
  {
    id: "pdf-to-jpg",
    name: "PDF to JPG",
    short: "Save every page as a JPG or PNG image.",
    description: "Render pages to images at the resolution you choose. Several pages download as a ZIP.",
    category: "from-pdf",
    icon: "image",
    accept: PDF,
    pickLabel: "a PDF file",
    multiple: false,
    processing: "browser",
    keywords: ["image", "png", "picture", "export", "screenshot", "render"],
    howTo: ["Add one PDF.", "Pick the pages, format and resolution.", "Download the images, as a ZIP when there are several."],
    related: ["jpg-to-pdf", "extract-pages", "compress"],
  },
  {
    id: "pdf-to-word",
    name: "PDF to Word",
    short: "Turn a PDF's text into an editable Word document.",
    description: "Extracts text, headings and paragraphs into a .docx. Best with text-based PDFs; scanned pages are not read.",
    category: "from-pdf",
    icon: "word",
    accept: PDF,
    pickLabel: "PDF files",
    multiple: true,
    processing: "optional-server",
    keywords: ["doc", "docx", "editable", "text", "convert"],
    howTo: ["Add PDFs.", "Choose the on-device text mode, or the layout mode when your server has LibreOffice.", "Download the .docx."],
    related: ["pdf-to-excel", "pdf-to-powerpoint", "pdf-to-jpg"],
  },
  {
    id: "pdf-to-excel",
    name: "PDF to Excel",
    short: "Pull tables from a PDF into an Excel spreadsheet.",
    description: "Finds text laid out in rows and columns and writes it to .xlsx. Works on PDFs with real text, not scans.",
    category: "from-pdf",
    icon: "excel",
    accept: PDF,
    pickLabel: "PDF files",
    multiple: true,
    processing: "browser",
    keywords: ["xls", "xlsx", "table", "spreadsheet", "data", "csv"],
    howTo: ["Add PDFs.", "Convert. Rows and columns are detected from the text positions.", "Download the .xlsx and check the table."],
    related: ["pdf-to-word", "pdf-to-powerpoint", "extract-pages"],
  },
  {
    id: "pdf-to-powerpoint",
    name: "PDF to PowerPoint",
    short: "Turn each PDF page into a slide.",
    description: "Creates a .pptx with one slide per page. Slides hold the page image on this device; LibreOffice mode makes text editable.",
    category: "from-pdf",
    icon: "powerpoint",
    accept: PDF,
    pickLabel: "PDF files",
    multiple: true,
    processing: "optional-server",
    keywords: ["ppt", "pptx", "slides", "presentation", "deck"],
    howTo: ["Add PDFs.", "Choose slide images (on device) or editable text (needs LibreOffice on the server).", "Download the .pptx."],
    related: ["pdf-to-word", "pdf-to-excel", "pdf-to-jpg"],
  },

  // ---- Edit -----------------------------------------------------------------------------
  {
    id: "edit",
    name: "Edit PDF",
    short: "Add text, shapes, drawings, highlights and images.",
    description: "Annotate a PDF: type text, draw, highlight, add shapes and images, or cover content with a white box.",
    category: "edit",
    icon: "pencil",
    accept: PDF,
    pickLabel: "a PDF file",
    multiple: false,
    processing: "browser",
    keywords: ["annotate", "text", "draw", "highlight", "sign", "signature", "shapes", "comment", "whiteout", "fill"],
    howTo: ["Add one PDF.", "Choose a tool and click on the page to add or move things.", "Save the edited PDF."],
    related: ["watermark", "page-numbers", "crop"],
  },
  {
    id: "page-numbers",
    name: "Add page numbers",
    short: "Number the pages, with the position and style you want.",
    description: "Add page numbers or “Page X of Y” labels. Choose position, size, colour and which pages get one.",
    category: "edit",
    icon: "hash",
    accept: PDF,
    pickLabel: "a PDF file",
    multiple: false,
    processing: "browser",
    keywords: ["numbering", "footer", "header", "pagination", "bates"],
    howTo: ["Add one PDF.", "Choose position, format and page range, and check the preview.", "Download the numbered PDF."],
    related: ["watermark", "edit", "crop"],
  },
  {
    id: "watermark",
    name: "Add watermark",
    short: "Stamp text or an image across your pages.",
    description: "Add a text or image watermark with size, opacity, rotation and position. Place it over or under the content.",
    category: "edit",
    icon: "droplet",
    accept: PDF,
    pickLabel: "a PDF file",
    multiple: false,
    processing: "browser",
    keywords: ["stamp", "confidential", "draft", "logo", "overlay", "background"],
    howTo: ["Add one PDF.", "Type your text or choose an image, then set position and opacity.", "Download the watermarked PDF."],
    related: ["page-numbers", "edit", "protect"],
  },
  {
    id: "crop",
    name: "Crop PDF",
    short: "Trim margins or keep just the area you select.",
    description: "Drag a crop box on a preview, or enter margins, and apply it to all pages or a range.",
    category: "edit",
    icon: "crop",
    accept: PDF,
    pickLabel: "a PDF file",
    multiple: false,
    processing: "browser",
    keywords: ["trim", "margins", "cut", "resize", "page size"],
    howTo: ["Add one PDF.", "Drag the crop box, or enter margins.", "Apply to all pages or a range and download."],
    related: ["rotate", "edit", "page-numbers"],
  },

  // ---- Security & info ------------------------------------------------------------------
  {
    id: "protect",
    name: "Protect PDF",
    short: "Lock a PDF with a password, using AES encryption.",
    description: "Require a password to open the PDF, and optionally restrict printing, copying and editing.",
    category: "security",
    icon: "lock",
    accept: PDF,
    pickLabel: "a PDF file",
    multiple: false,
    processing: "browser",
    keywords: ["password", "encrypt", "secure", "aes", "restrict", "permissions"],
    howTo: ["Add one PDF.", "Choose a password and what readers may do.", "Download the protected PDF."],
    related: ["unlock", "watermark", "metadata"],
  },
  {
    id: "unlock",
    name: "Unlock PDF",
    short: "Remove a password from a PDF you are allowed to open.",
    description: "Enter the password you already have to save an unprotected copy. This tool does not guess or crack passwords.",
    category: "security",
    icon: "unlock",
    accept: PDF,
    pickLabel: "a PDF file",
    multiple: false,
    processing: "browser",
    keywords: ["remove password", "decrypt", "open", "restrictions"],
    howTo: ["Add the protected PDF.", "Enter its password and confirm you are allowed to unlock it.", "Download the unlocked copy."],
    related: ["protect", "repair", "merge"],
  },
  {
    id: "metadata",
    name: "PDF metadata",
    short: "See a PDF's properties, and edit or remove its details.",
    description: "View title, author, dates, page sizes, encryption and more. Edit the details or clear them before sharing.",
    category: "security",
    icon: "info",
    accept: PDF,
    pickLabel: "a PDF file",
    multiple: false,
    processing: "browser",
    keywords: ["properties", "info", "author", "title", "privacy", "scrub", "document info"],
    howTo: ["Add one PDF.", "Read its properties, and edit or clear any of them.", "Download the updated PDF if you changed something."],
    related: ["protect", "compress", "unlock"],
  },
];

const BY_ID = new Map(TOOLS.map((tool) => [tool.id, tool]));

export function getTool(id: string | undefined): ToolDefinition | undefined {
  return id ? BY_ID.get(id) : undefined;
}

export function toolsInCategory(category: ToolCategoryId): ToolDefinition[] {
  return TOOLS.filter((tool) => tool.category === category);
}

export function categoryOf(tool: ToolDefinition): ToolCategory {
  return CATEGORIES.find((c) => c.id === tool.category) as ToolCategory;
}

/** Case-insensitive search across name, description, category and keywords. Empty query matches all. */
export function searchTools(query: string, category?: ToolCategoryId | "all"): ToolDefinition[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return TOOLS.filter((tool) => {
    if (category && category !== "all" && tool.category !== category) return false;
    if (terms.length === 0) return true;
    const haystack = [tool.name, tool.short, tool.description, categoryOf(tool).name, ...tool.keywords, ...tool.accept]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
