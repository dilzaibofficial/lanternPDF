import { Link } from "react-router";
import { BRAND } from "../config/brand";
import { TOOLS } from "../config/tools";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

const CREDITS: { name: string; use: string; license: string }[] = [
  { name: "qpdf (WebAssembly build)", use: "Merging, splitting, page selection, rotation, encryption and decryption", license: "Apache-2.0" },
  { name: "pdf-lib (@cantoo fork)", use: "Drawing on pages, images to PDF, crop boxes, metadata, repair", license: "MIT" },
  { name: "PDF.js", use: "Showing pages, thumbnails, PDF to image, text extraction", license: "Apache-2.0" },
  { name: "fflate", use: "Creating ZIP files", license: "MIT" },
  { name: "docx", use: "Writing Word documents", license: "MIT" },
  { name: "ExcelJS", use: "Writing Excel workbooks", license: "MIT" },
  { name: "PptxGenJS", use: "Writing PowerPoint presentations", license: "MIT" },
  { name: "React, React Router, Vite", use: "The interface", license: "MIT" },
  { name: "Plus Jakarta Sans", use: "The typeface (self-hosted)", license: "OFL-1.1" },
  { name: "LibreOffice (optional, server only)", use: "Word, Excel and PowerPoint conversions", license: "MPL-2.0" },
  { name: "Ghostscript (optional, server only)", use: "Stronger compression", license: "AGPL-3.0 (separate program)" },
];

export default function AboutPage() {
  useDocumentTitle(`About ${BRAND.name}`);
  return (
    <div className="container">
      <div className="page-head">
        <h1>About {BRAND.name}</h1>
        <p>
          {TOOLS.length} PDF tools in one place, free to use, built to keep your documents on your own device.
        </p>
      </div>
      <div className="prose" style={{ paddingBottom: "var(--space-16)" }}>
        <h2>Why it exists</h2>
        <p>
          Most online PDF tools make you upload your documents to someone else’s server. For contracts, invoices and identity documents
          that is a poor trade. {BRAND.name} does the work in your browser instead, and only uses a server for the few conversions that
          genuinely need one, which you can run yourself. <Link to="/privacy">Read the details.</Link>
        </p>

        <h2>Built from open source</h2>
        <p>These projects do the heavy lifting. Each keeps its own license.</p>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--text-sm)" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "2px solid var(--border)" }}>
                <th scope="col" style={{ padding: "var(--space-2)" }}>Component</th>
                <th scope="col" style={{ padding: "var(--space-2)" }}>Used for</th>
                <th scope="col" style={{ padding: "var(--space-2)" }}>License</th>
              </tr>
            </thead>
            <tbody>
              {CREDITS.map((credit) => (
                <tr key={credit.name} style={{ borderBottom: "1px solid var(--border)" }}>
                  <th scope="row" style={{ padding: "var(--space-2)", textAlign: "left", fontWeight: 650 }}>{credit.name}</th>
                  <td style={{ padding: "var(--space-2)" }}>{credit.use}</td>
                  <td style={{ padding: "var(--space-2)", whiteSpace: "nowrap" }}>{credit.license}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2>Honest limits</h2>
        <ul>
          <li>
            Converting PDF to Word or Excel recovers text and simple tables, not the original layout. Scanned pages need OCR, which is not
            included.
          </li>
          <li>
            Compression is measured, not promised: the result page shows the real before and after sizes, and says so when a file cannot be
            made smaller.
          </li>
          <li>Cropping and covering content hide it; they do not remove it from the file. Use the PDF itself carefully when sharing.</li>
        </ul>
      </div>
    </div>
  );
}
