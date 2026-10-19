import { BRAND } from "../config/brand";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useCapabilities } from "../hooks/useCapabilities";
import { formatBytes } from "../lib/format";

export default function SelfHostingPage() {
  useDocumentTitle("Self-hosting", "Run your own copy: commands, configuration, Docker and optional LibreOffice and Ghostscript.");
  const capabilities = useCapabilities();
  return (
    <div className="container">
      <div className="page-head">
        <h1>Self-hosting</h1>
        <p>
          {BRAND.name} is a standard Node.js project. The browser tools need no server beyond static files; the optional server adds Office
          conversions.
        </p>
      </div>
      <div className="prose" style={{ paddingBottom: "var(--space-16)" }}>
        <h2>This server right now</h2>
        {(capabilities.status === "loading" || capabilities.status === "idle") && <p>Checking…</p>}
        {capabilities.status === "unavailable" && (
          <p>
            No API server answered, so only the on-device tools are available here. That is a valid setup: the browser tools work from any
            static host.
          </p>
        )}
        {capabilities.status === "ready" && (
          <ul>
            <li>Version {capabilities.capabilities.version}</li>
            <li>Upload limit: {formatBytes(capabilities.capabilities.limits.maxUploadBytes)}</li>
            <li>
              LibreOffice:{" "}
              {capabilities.capabilities.engines.libreoffice.available
                ? `available${capabilities.capabilities.engines.libreoffice.version ? ` (${capabilities.capabilities.engines.libreoffice.version})` : ""}`
                : `not found${capabilities.capabilities.engines.libreoffice.reason ? `: ${capabilities.capabilities.engines.libreoffice.reason}` : ""}`}
            </li>
            <li>
              Ghostscript:{" "}
              {capabilities.capabilities.engines.ghostscript.available
                ? `available${capabilities.capabilities.engines.ghostscript.version ? ` (${capabilities.capabilities.engines.ghostscript.version})` : ""}`
                : `not found${capabilities.capabilities.engines.ghostscript.reason ? `: ${capabilities.capabilities.engines.ghostscript.reason}` : ""}`}
            </li>
          </ul>
        )}

        <h2>Run it</h2>
        <pre>
          <code>{`npm install
npm run build
npm start        # http://127.0.0.1:8787`}</code>
        </pre>
        <p>
          Needs Node.js 22.13 or newer. For development use <code>npm run dev</code>, which starts the web app on port 5173 and the API on
          8787.
        </p>

        <h2>Configuration</h2>
        <p>
          Copy <code>.env.example</code> to <code>.env</code>. Every value is optional.
        </p>
        <ul>
          <li>
            <code>PORT</code>, <code>HOST</code>: where the server listens (use <code>0.0.0.0</code> in a container).
          </li>
          <li>
            <code>MAX_UPLOAD_MB</code>: largest accepted server upload (default 50).
          </li>
          <li>
            <code>SOFFICE_PATH</code>, <code>GHOSTSCRIPT_PATH</code>: where to find the optional engines when they are not on the PATH.
          </li>
          <li>
            <code>RATE_LIMIT_PER_MINUTE</code>, <code>MAX_CONCURRENT_JOBS</code>, <code>CONVERSION_TIMEOUT_SECONDS</code>: protection for
            shared servers.
          </li>
          <li>
            <code>TRUST_PROXY</code>, <code>ALLOWED_ORIGINS</code>: set these when running behind a reverse proxy or when the web app is
            hosted on a different origin.
          </li>
        </ul>

        <h2>Optional engines</h2>
        <ul>
          <li>
            <strong>LibreOffice</strong> as an optional second mode for Word, Excel and PowerPoint to PDF (it also opens older .doc, .xls and .ppt files) and for the layout modes of PDF to Word and PowerPoint. Install it
            with your package manager (for example <code>apt install libreoffice-writer libreoffice-calc libreoffice-impress</code>) or
            from libreoffice.org.
          </li>
          <li>
            <strong>Ghostscript</strong> for the optional stronger-compression mode (<code>apt install ghostscript</code>).
          </li>
        </ul>

        <h2>Docker</h2>
        <pre>
          <code>{`docker build -t lanternpdf .
docker run --rm -p 8787:8787 lanternpdf`}</code>
        </pre>
        <p>The image includes LibreOffice and Ghostscript, so every tool works out of the box.</p>
      </div>
    </div>
  );
}
