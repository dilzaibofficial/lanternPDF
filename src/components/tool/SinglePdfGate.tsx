import { type ReactNode, useRef } from "react";
import type { ToolDefinition } from "../../config/tools";
import type { PdfItem, usePdfFiles } from "../../hooks/usePdfFiles";
import { formatBytes, plural } from "../../lib/format";
import { Dropzone } from "../files/Dropzone";
import { PdfFileList } from "../files/PdfFileList";
import { PdfThumb } from "../pdf/PdfThumb";
import { Icon } from "../ui/Icon";
import { LocalNote } from "./Panel";

type Files = ReturnType<typeof usePdfFiles>;

interface Props {
  tool: ToolDefinition;
  files: Files;
  /** Rendered once the file is open and readable. */
  children: (item: PdfItem) => ReactNode;
  /** Override the drop zone's privacy line (for server-backed tools). */
  note?: ReactNode;
}

/**
 * Everything a one-PDF tool needs before its own UI: the drop zone, a password prompt, a repair
 * offer for damaged files, and a header showing the loaded file with a way to change it.
 */
export function SinglePdfGate({ tool, files, children, note }: Props) {
  const picker = useRef<HTMLInputElement>(null);
  const item = files.items[0];

  if (!item) {
    return (
      <Dropzone
        extensions={tool.accept}
        multiple={false}
        pickLabel={tool.pickLabel}
        onFiles={files.addFiles}
        rejections={files.rejections}
        onDismissRejections={files.clearRejections}
        note={note ?? <LocalNote />}
      />
    );
  }

  if (item.status !== "ready" || !item.bytes) {
    return (
      <div className="stack">
        <PdfFileList items={[item]} onMove={files.move} onRemove={files.remove} onUnlock={files.unlock} onReplace={files.replace} sortable={false} label="Selected PDF" />
        <Dropzone compact extensions={tool.accept} multiple={false} pickLabel={tool.pickLabel} onFiles={files.addFiles} rejections={files.rejections} onDismissRejections={files.clearRejections} />
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="file-row" data-testid="file-bar" style={{ gridTemplateColumns: "auto minmax(0,1fr) auto", gridTemplateAreas: "'thumb info actions'" }}>
        <span className="file-row__thumb">
          <PdfThumb source={{ key: `${item.id}:${item.revision}`, bytes: item.bytes, password: item.password, name: item.name }} pageNumber={1} width={48} />
        </span>
        <div className="file-row__info">
          <div className="file-row__name" title={item.name}>
            {item.name}
          </div>
          <div className="file-row__meta">
            <span>{plural(item.pageCount ?? 0, "page")}</span>
            <span>{formatBytes(item.size)}</span>
            {item.encrypted && item.password && <span>unlocked</span>}
            {item.encrypted && !item.password && <span title="The author set limits such as printing or editing. They may not carry over to the result.">has usage restrictions</span>}
          </div>
        </div>
        <div className="file-row__actions">
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => picker.current?.click()}>
            <Icon name="refresh" size={16} />
            Change file
          </button>
          <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label={`Remove ${item.name}`} onClick={() => files.remove(item.id)}>
            <Icon name="close" size={18} />
          </button>
          <input
            ref={picker}
            type="file"
            hidden
            accept={tool.accept.join(",")}
            data-testid="file-input-replace"
            onChange={(event) => {
              if (event.target.files?.length) files.addFiles(Array.from(event.target.files));
              event.target.value = "";
            }}
          />
        </div>
      </div>
      {files.rejections.length > 0 && (
        <ul className="notice-list" role="alert">
          {files.rejections.map((rejection, index) => (
            <li key={index} className="alert alert--warning">
              <Icon name="alert" size={18} className="alert__icon" />
              <span style={{ color: "var(--text)" }}>{rejection.reason}</span>
            </li>
          ))}
        </ul>
      )}
      {children(item)}
    </div>
  );
}
