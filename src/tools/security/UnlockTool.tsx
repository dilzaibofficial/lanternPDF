import { useState } from "react";
import { Alert } from "../../components/ui/Alerts";
import { Checkbox } from "../../components/ui/Field";
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

export default function UnlockTool({ tool }: ToolProps) {
  const files = usePdfFiles({ multiple: false });
  useAcceptHandoff(files.addBytes);
  const job = useJob<OutputFile>();

  return (
    <JobView
      job={job}
      title="Removing the protection…"
      renderResult={(file) => (
        <ResultPanel
          title="Your unlocked PDF is ready"
          subtitle="It opens without a password."
          files={[file]}
          stats={[
            { label: "Pages", value: String(file.pageCount ?? "—") },
            { label: "Size", value: formatBytes(file.bytes.length) },
          ]}
          onReset={() => {
            job.reset();
            files.clear();
          }}
          onBack={job.reset}
          nextTools={["merge", "compress", "organize", "edit"]}
        />
      )}
    >
      <SinglePdfGate tool={tool} files={files}>
        {(item) => <UnlockForm item={item} run={(work) => job.run(work)} />}
      </SinglePdfGate>
    </JobView>
  );
}

function UnlockForm({ item, run }: { item: PdfItem; run: (work: (c: { signal: AbortSignal; onProgress: (f: number, m?: string) => void }) => Promise<OutputFile>) => void }) {
  const [authorized, setAuthorized] = useState(false);
  const protectedFile = item.encrypted;

  if (!protectedFile) {
    return (
      <Alert tone="info" title="This PDF is not protected">
        <p>It has no password and no usage restrictions, so there is nothing to unlock. You can use it with any other tool.</p>
      </Alert>
    );
  }

  const unlock = () =>
    run(({ signal, onProgress }) =>
      runOperation("unlock", { input: toPdfInput(item), options: { password: item.password, authorized: true } }, { signal, onProgress }),
    );

  return (
    <div className="tool-layout tool-layout--side">
      <div className="tool-layout__main">
        <Alert tone="success" title={item.password ? "The password worked" : "This PDF opens without a password"}>
          <p>
            {item.password
              ? "Your PDF is open in this browser tab. Unlocking saves a copy without the password."
              : "It only carries usage restrictions set by its author, such as limits on printing or editing. Unlocking saves a copy without them."}
          </p>
        </Alert>
        <Alert tone="info" title="What this tool does not do">
          <p>It cannot guess, crack or bypass a password. It only removes protection from files you can already open.</p>
        </Alert>
      </div>
      <aside className="tool-layout__side">
        <Panel title="Unlock">
          <Checkbox
            checked={authorized}
            onChange={setAuthorized}
            label="I own this file or have permission to remove its protection"
            hint="Removing protection from documents you are not entitled to open may be unlawful."
          />
          <div className="action-bar">
            <button type="button" className="btn btn--primary btn--lg" disabled={!authorized} onClick={unlock} data-testid="run-button">
              <Icon name="unlock" size={22} />
              Unlock PDF
            </button>
          </div>
        </Panel>
      </aside>
    </div>
  );
}
