import { useState } from "react";
import type { PdfItem } from "../../hooks/usePdfFiles";
import { formatBytes, plural } from "../../lib/format";
import { toAppError } from "../../lib/errors";
import { hasPdfHeader } from "../../lib/pdf/inspect";
import { runOperation } from "../../lib/worker/client";
import { PdfThumb } from "../pdf/PdfThumb";
import { Field, PasswordInput } from "../ui/Field";
import { Icon } from "../ui/Icon";
import { FileList, type FileRowModel } from "./FileList";

interface Props {
  items: readonly PdfItem[];
  onMove: (from: number, to: number) => void;
  onRemove: (id: string) => void;
  onUnlock: (id: string, password: string) => Promise<void>;
  onReplace: (id: string, bytes: Uint8Array, name?: string) => Promise<void>;
  sortable?: boolean;
  label?: string;
  /** Offer "Try to repair this file" on damaged PDFs. Off for the Repair tool, which has its own button. */
  offerRepair?: boolean;
}

function UnlockForm({ item, onUnlock }: { item: PdfItem; onUnlock: Props["onUnlock"] }) {
  const [password, setPassword] = useState("");
  const wrong = item.status === "wrong-password";
  const submit = () => {
    if (password) void onUnlock(item.id, password);
  };
  return (
    <div className="file-row__unlock">
      <Field label="Password" error={wrong ? "That password is incorrect." : null} hint="Used only to open this file in your browser.">
        {({ id, describedBy, invalid }) => (
          <PasswordInput id={id} value={password} onChange={setPassword} describedBy={describedBy} invalid={invalid} onEnter={submit} autoFocus />
        )}
      </Field>
      <button type="button" className="btn btn--primary" disabled={!password} onClick={submit}>
        <Icon name="unlock" size={18} />
        Open file
      </button>
    </div>
  );
}

function RepairPrompt({ item, onReplace }: { item: PdfItem; onReplace: Props["onReplace"] }) {
  const [state, setState] = useState<"idle" | "working" | "failed">("idle");
  const [notice, setNotice] = useState<string | null>(null);
  if (!item.bytes || !hasPdfHeader(item.bytes)) return null;

  const run = async () => {
    setState("working");
    try {
      const { file, notes } = await runOperation("repair", { input: { name: item.name, bytes: item.bytes as Uint8Array } });
      setNotice(notes.join(" "));
      await onReplace(item.id, file.bytes, file.name);
      setState("idle");
    } catch (error) {
      setNotice(toAppError(error).message);
      setState("failed");
    }
  };

  return (
    <div className="cluster">
      <button type="button" className="btn btn--secondary btn--sm" disabled={state === "working"} onClick={run}>
        {state === "working" ? <span className="spinner" aria-hidden="true" /> : <Icon name="wrench" size={16} />}
        {state === "working" ? "Repairing…" : "Try to repair this file"}
      </button>
      {notice && (
        <span className="muted" style={{ fontSize: "var(--text-xs)" }} role="status">
          {notice}
        </span>
      )}
    </div>
  );
}

/** The file list for PDF tools: thumbnails, page counts, password prompts, and a repair offer. */
export function PdfFileList({ items, onMove, onRemove, onUnlock, onReplace, sortable = true, label = "Selected PDF files", offerRepair = true }: Props) {
  const rows: FileRowModel[] = items.map((item) => {
    const base = { id: item.id, name: item.name };
    const size = formatBytes(item.size);
    const restricted = item.encrypted && !item.password;

    if (item.status === "reading") {
      return { ...base, subtitle: size, status: { tone: "muted", text: "Reading…" }, thumb: <span className="spinner" aria-hidden="true" /> };
    }
    if (item.status === "needs-password" || item.status === "wrong-password") {
      return {
        ...base,
        subtitle: size,
        status: { tone: "error", text: item.status === "wrong-password" ? "Incorrect password" : "Password required" },
        thumb: <Icon name="lock" size={22} />,
        extra: <UnlockForm item={item} onUnlock={onUnlock} />,
      };
    }
    if (item.status === "damaged") {
      return {
        ...base,
        subtitle: size,
        status: { tone: "error", text: item.message ?? "This file cannot be read." },
        thumb: <Icon name="alert" size={22} />,
        extra: offerRepair ? <RepairPrompt item={item} onReplace={onReplace} /> : undefined,
      };
    }
    return {
      ...base,
      subtitle: (
        <>
          <span>{plural(item.pageCount ?? 0, "page")}</span>
          <span>{size}</span>
          {item.encrypted && item.password && <span>unlocked</span>}
          {restricted && <span title="The author set limits such as printing or editing. They may not carry over to the result.">has usage restrictions</span>}
        </>
      ),
      thumb: item.bytes ? (
        <PdfThumb
          source={{ key: `${item.id}:${item.revision}`, bytes: item.bytes, password: item.password, name: item.name }}
          pageNumber={1}
          width={48}
        />
      ) : null,
    };
  });

  return <FileList rows={rows} onMove={onMove} onRemove={onRemove} sortable={sortable} label={label} />;
}
