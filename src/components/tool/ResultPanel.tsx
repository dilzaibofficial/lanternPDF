import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { getTool } from "../../config/tools";
import { useHandoff } from "../../hooks/useHandoff";
import { downloadBlob, downloadOutputs, toBlob } from "../../lib/download";
import { formatBytes } from "../../lib/format";
import type { OutputFile } from "../../lib/pdf/types";
import { MIME } from "../../lib/pdf/types";
import { PdfViewer } from "../pdf/PdfViewer";
import { Icon } from "../ui/Icon";

export interface ResultStat {
  label: string;
  value: string;
  /** Highlights a good outcome (for example, space saved). */
  good?: boolean;
}

interface ResultPanelProps {
  title: string;
  subtitle?: ReactNode;
  files: readonly OutputFile[];
  stats?: readonly ResultStat[];
  /** Extra alerts or explanations shown above the preview. */
  notes?: ReactNode;
  zipName?: string;
  onReset: () => void;
  resetLabel?: string;
  /** Returns to the options with the files still loaded. */
  onBack?: () => void;
  /** Tool ids offered as "Continue with…" when there is exactly one PDF result. */
  nextTools?: readonly string[];
  /** Hide the preview (for results that are not viewable, such as a ZIP of Office files). */
  noPreview?: boolean;
  /** Password for previewing a protected result. It is only used locally, to draw the preview. */
  previewPassword?: string;
}

let resultCounter = 0;

/** Success screen: what was made, real numbers, a preview, downloads, and what to do next. */
export function ResultPanel({ title, subtitle, files, stats, notes, zipName = "lanternpdf-files.zip", onReset, resetLabel = "Start over", onBack, nextTools, noPreview, previewPassword }: ResultPanelProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const navigate = useNavigate();
  const { offer } = useHandoff();
  const [previewIndex, setPreviewIndex] = useState(0);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  const pdfs = useMemo(() => files.filter((file) => file.mime === MIME.pdf), [files]);
  const images = useMemo(() => files.filter((file) => file.mime.startsWith("image/")), [files]);
  // A new result is a new document for the preview, even when its name and size match the last one's.
  const keyed = useRef<{ files: readonly OutputFile[]; key: string } | null>(null);
  if (keyed.current?.files !== files) keyed.current = { files, key: `result-${(resultCounter += 1)}` };
  const previewKey = keyed.current.key;
  const previewPdf = pdfs[Math.min(previewIndex, pdfs.length - 1)];

  const imageUrls = useMemo(() => images.slice(0, 12).map((file) => ({ name: file.name, url: URL.createObjectURL(toBlob(file)) })), [images]);
  useEffect(() => () => imageUrls.forEach((entry) => URL.revokeObjectURL(entry.url)), [imageUrls]);

  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  const single = files.length === 1 ? files[0] : undefined;
  const continuable = single && single.mime === MIME.pdf ? (nextTools ?? []).map((id) => getTool(id)).filter((tool) => tool !== undefined) : [];

  const continueWith = (toolId: string) => {
    if (!single) return;
    offer({ name: single.name, bytes: single.bytes });
    navigate(`/tools/${toolId}`);
  };

  return (
    <div className="result" data-testid="result-panel">
      <div className="result__head">
        <span className="result__check">
          <Icon name="check" size={28} strokeWidth={2.5} />
        </span>
        <div>
          <h2 className="result__title" ref={heading} tabIndex={-1}>
            {title}
          </h2>
          {subtitle && <p className="result__sub">{subtitle}</p>}
        </div>
      </div>

      {stats && stats.length > 0 && (
        <div className="result__stats" data-testid="result-stats">
          {stats.map((stat) => (
            <div className={`stat${stat.good ? " stat--good" : ""}`} key={stat.label}>
              <div className="stat__label">{stat.label}</div>
              <div className="stat__value">{stat.value}</div>
            </div>
          ))}
        </div>
      )}

      {notes}

      <div className="result__actions">
        <button type="button" className="btn btn--primary btn--lg" data-testid="download-all" onClick={() => downloadOutputs(files, zipName)}>
          <Icon name="download" size={22} />
          {single ? `Download ${single.name}` : `Download all (${files.length} files, ZIP)`}
        </button>
        {onBack && (
          <button type="button" className="btn btn--secondary btn--lg" onClick={onBack}>
            Change options
          </button>
        )}
        <button type="button" className="btn btn--ghost btn--lg" onClick={onReset}>
          {resetLabel}
        </button>
      </div>

      {files.length > 1 && (
        <ul className="result__files" aria-label="Result files">
          {files.map((file) => (
            <li className="result-file" key={file.name}>
              <Icon name={file.mime.startsWith("image/") ? "image" : "file"} size={20} />
              <span className="result-file__name" title={file.name}>
                {file.name}
              </span>
              <span className="result-file__meta">
                {file.pageCount ? `${file.pageCount} ${file.pageCount === 1 ? "page" : "pages"} · ` : ""}
                {formatBytes(file.bytes.length)}
              </span>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => downloadBlob(file.name, toBlob(file))} aria-label={`Download ${file.name}`}>
                <Icon name="download" size={16} />
              </button>
            </li>
          ))}
          <li className="result-file__meta" style={{ textAlign: "right" }}>
            Total {formatBytes(total)}
          </li>
        </ul>
      )}

      {!noPreview && previewPdf && (
        <div className="stack">
          {pdfs.length > 1 && (
            <div className="field" style={{ maxWidth: "22rem" }}>
              <label className="field__label" htmlFor="preview-file">
                Preview file
              </label>
              <select id="preview-file" className="select" value={previewIndex} onChange={(event) => setPreviewIndex(Number(event.target.value))}>
                {pdfs.map((file, index) => (
                  <option key={file.name} value={index}>
                    {file.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <PdfViewer source={{ key: `${previewKey}-${previewIndex}`, bytes: previewPdf.bytes, name: previewPdf.name, password: previewPassword }} label={`Preview of ${previewPdf.name}`} />
        </div>
      )}

      {!noPreview && images.length > 0 && (
        <div className="result__previews" aria-label="Image previews">
          {imageUrls.map((entry) => (
            <img key={entry.name} src={entry.url} alt={entry.name} loading="lazy" />
          ))}
        </div>
      )}

      {continuable.length > 0 && (
        <div className="result__next">
          <h3>Continue with this file</h3>
          <div className="chips">
            {continuable.map((tool) => (
              <button key={tool.id} type="button" className="chip" onClick={() => continueWith(tool.id)}>
                {tool.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
