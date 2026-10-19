import { useState } from "react";
import { Alert } from "../../components/ui/Alerts";
import { Checkbox, Field, PasswordInput, Segmented } from "../../components/ui/Field";
import { Icon } from "../../components/ui/Icon";
import { JobView } from "../../components/tool/JobView";
import { Panel } from "../../components/tool/Panel";
import { ResultPanel } from "../../components/tool/ResultPanel";
import { SinglePdfGate } from "../../components/tool/SinglePdfGate";
import { useAcceptHandoff } from "../../hooks/useHandoff";
import { useJob } from "../../hooks/useJob";
import { type PdfItem, toPdfInput, usePdfFiles } from "../../hooks/usePdfFiles";
import { formatBytes } from "../../lib/format";
import type { OutputFile } from "../../lib/pdf/types";
import { runOperation } from "../../lib/worker/client";
import type { ToolProps } from "../types";

interface Result {
  file: OutputFile;
  password: string;
  keyLength: 128 | 256;
  restricted: string[];
}

export default function ProtectTool({ tool }: ToolProps) {
  const files = usePdfFiles({ multiple: false });
  useAcceptHandoff(files.addBytes);
  const job = useJob<Result>();

  return (
    <JobView
      job={job}
      title="Encrypting your PDF…"
      renderResult={(result) => (
        <ResultPanel
          title="Your protected PDF is ready"
          subtitle="It now asks for a password before it opens."
          files={[result.file]}
          stats={[
            { label: "Encryption", value: `AES-${result.keyLength}` },
            { label: "Pages", value: String(result.file.pageCount ?? "—") },
            { label: "Size", value: formatBytes(result.file.bytes.length) },
          ]}
          notes={
            <>
              <Alert tone="warning" title="Keep the password safe">
                <p>Nobody, including this site, can recover it. If it is lost, the file cannot be opened.</p>
              </Alert>
              {result.restricted.length > 0 && (
                <Alert tone="info">
                  <p>Readers who know only the password cannot: {result.restricted.join(", ")}. Some viewers do not enforce these limits.</p>
                </Alert>
              )}
            </>
          }
          previewPassword={result.password}
          onReset={() => {
            job.reset();
            files.clear();
          }}
          onBack={job.reset}
          nextTools={["metadata", "merge"]}
        />
      )}
    >
      <SinglePdfGate tool={tool} files={files}>
        {(item) => <ProtectForm item={item} run={(work) => job.run(work)} />}
      </SinglePdfGate>
    </JobView>
  );
}

function ProtectForm({ item, run }: { item: PdfItem; run: (work: (c: { signal: AbortSignal; onProgress: (f: number, m?: string) => void }) => Promise<Result>) => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [owner, setOwner] = useState("");
  const [keyLength, setKeyLength] = useState<"256" | "128">("256");
  const [allowPrint, setAllowPrint] = useState(true);
  const [allowCopy, setAllowCopy] = useState(true);
  const [allowEdit, setAllowEdit] = useState(true);
  const [touched, setTouched] = useState(false);

  const max = keyLength === "256" ? 127 : 32;
  const mismatch = confirm !== "" && confirm !== password;
  const tooLong = password.length > max;
  const nonLatin = keyLength === "128" && [...password].some((ch) => (ch.codePointAt(0) ?? 0) > 255);
  const valid = password.length > 0 && !mismatch && confirm === password && !tooLong && !nonLatin;
  const weak = password.length > 0 && password.length < 8;

  const protect = () => {
    setTouched(true);
    if (!valid) return;
    run(async ({ signal, onProgress }) => {
      const options = { userPassword: password, ownerPassword: owner || undefined, keyLength: Number(keyLength) as 128 | 256, allowPrint, allowCopy, allowEdit };
      const file = await runOperation("protect", { input: toPdfInput(item), options }, { signal, onProgress });
      const restricted = [!allowPrint && "print", !allowCopy && "copy text", !allowEdit && "edit"].filter((x): x is string => Boolean(x));
      return { file, password, keyLength: options.keyLength, restricted };
    });
  };

  return (
    <div className="tool-layout tool-layout--side">
      <div className="tool-layout__main">
        <Alert tone="info" title="How the protection works">
          <p>
            The file is encrypted on this device with AES. Opening it needs the password; changing what readers can do needs the owner
            password. Your password never leaves the page.
          </p>
        </Alert>
        {item.encrypted && item.password && <Alert tone="warning">This PDF was already password-protected. Protecting it again replaces the old password.</Alert>}
      </div>
      <aside className="tool-layout__side">
        <Panel title="Set a password">
          <Field label="Password" hint={`Up to ${max} characters.`} error={touched && password.length === 0 ? "Enter a password." : tooLong ? `Use at most ${max} characters.` : nonLatin ? "128-bit encryption cannot store these characters. Choose 256-bit." : null}>
            {({ id, describedBy, invalid }) => <PasswordInput id={id} value={password} onChange={setPassword} describedBy={describedBy} invalid={invalid} autoComplete="new-password" />}
          </Field>
          {weak && <p className="panel__note">Short passwords are easy to guess. Eight or more characters is better.</p>}
          <Field label="Confirm password" error={mismatch ? "The passwords do not match." : null}>
            {({ id, describedBy, invalid }) => <PasswordInput id={id} value={confirm} onChange={setConfirm} describedBy={describedBy} invalid={invalid} autoComplete="new-password" onEnter={protect} />}
          </Field>

          <details>
            <summary style={{ cursor: "pointer", fontWeight: 650 }}>Advanced options</summary>
            <div className="panel__section" style={{ marginTop: "var(--space-3)" }}>
              <Segmented<"256" | "128"> name="key-length" legend="Encryption" value={keyLength} onChange={setKeyLength} options={[{ value: "256", label: "AES-256 (recommended)" }, { value: "128", label: "AES-128 (older readers)" }]} />
              <Field label="Owner password (optional)" hint="Needed to change these permissions later. A random one is used if you leave it empty.">
                {({ id, describedBy }) => <PasswordInput id={id} value={owner} onChange={setOwner} describedBy={describedBy} autoComplete="new-password" />}
              </Field>
              <fieldset>
                <legend>Readers may</legend>
                <div className="stack stack--tight">
                  <Checkbox checked={allowPrint} onChange={setAllowPrint} label="Print" />
                  <Checkbox checked={allowCopy} onChange={setAllowCopy} label="Copy text and images" />
                  <Checkbox checked={allowEdit} onChange={setAllowEdit} label="Edit the document" />
                </div>
              </fieldset>
            </div>
          </details>

          <div className="action-bar">
            <button type="button" className="btn btn--primary btn--lg" disabled={!valid} onClick={protect} data-testid="run-button">
              <Icon name="lock" size={22} />
              Protect PDF
            </button>
          </div>
        </Panel>
      </aside>
    </div>
  );
}
