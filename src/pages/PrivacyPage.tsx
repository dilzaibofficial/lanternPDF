import { Link } from "react-router";
import { BRAND } from "../config/brand";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export default function PrivacyPage() {
  useDocumentTitle("Privacy and how it works", "What happens to your files, what this site stores, and how to verify it yourself.");
  return (
    <div className="container">
      <div className="page-head">
        <h1>Privacy and how it works</h1>
        <p>PDFs are often private. This page says plainly where your files go, and how you can check.</p>
      </div>

      <div className="prose" style={{ paddingBottom: "var(--space-16)" }}>
        <h2>Where your files are processed</h2>
        <p>
          Almost every tool runs entirely inside your browser tab, using WebAssembly and Web Workers. The document is read from your
          device, changed in memory, and handed back for you to download. It is never sent to a server.
        </p>
        <ul>
          <li>
            <strong>On your device (nothing uploaded):</strong> merge, split, extract and delete pages, organize, rotate, compress, repair,
            JPG to PDF, PDF to JPG, PDF to Excel, page numbers, watermark, crop, edit, protect, unlock and metadata. PDF to Word and PDF to
            PowerPoint also work on your device in their default modes.
          </li>
          <li>
            <strong>On the server (uploaded once, deleted immediately):</strong> Word, Excel and PowerPoint to PDF, and the optional
            “LibreOffice” modes of PDF to Word and PDF to PowerPoint, plus the optional stronger-compression mode. These need LibreOffice or
            Ghostscript, which cannot run in a browser. Each of these tools says so on its page before you choose a file.
          </li>
        </ul>

        <h2>What happens on the server for those tools</h2>
        <ul>
          <li>The file is sent to the server that serves this site, over the connection you are already using.</li>
          <li>It is written to a private temporary folder under a random name, converted, and returned to you.</li>
          <li>It is deleted as soon as the response finishes. A cleanup task also removes anything left behind after a crash.</li>
          <li>The server does not keep copies, and its logs do not contain file names or file contents.</li>
          <li>Size limits and rate limits stop a single user from overloading the server.</li>
        </ul>

        <h2>What this site stores</h2>
        <ul>
          <li>
            Only your colour theme choice (light, dark or system), in your browser’s local storage. It never leaves your device.
          </li>
          <li>No cookies, no accounts, no analytics, no advertising, no third-party scripts, fonts or images.</li>
          <li>Passwords you type to open or protect a PDF stay in memory while the page is open and are never stored or sent.</li>
        </ul>

        <h2>Check it yourself</h2>
        <p>
          Open your browser’s developer tools, choose the <strong>Network</strong> tab, and use any on-device tool. You will see that no
          upload happens: the only requests are the page’s own files. You can even switch your device to airplane mode after the page has
          loaded and the on-device tools keep working.
        </p>

        <h2>Unlocking PDFs</h2>
        <p>
          Unlock PDF removes protection from a file when you give it the password you already have, and asks you to confirm that you are
          allowed to. It does not guess, crack or bypass passwords.
        </p>

        <p>
          Questions about running your own copy? See <Link to="/self-hosting">self-hosting</Link>. {BRAND.name} is built from open-source
          components; the <Link to="/about">about page</Link> lists them.
        </p>
      </div>
    </div>
  );
}
