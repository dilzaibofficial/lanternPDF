import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ProcessPanel } from "../../components/tool/ProcessPanel";
import { ErrorAlert } from "../../components/ui/Alerts";
import { Icon } from "../../components/ui/Icon";
import { CATEGORIES, TOOLS } from "../../config/tools";
import { useHandoff } from "../../hooks/useHandoff";
import { useJob } from "../../hooks/useJob";
import type { OutputFile } from "../../lib/pdf/types";
import { runOperation } from "../../lib/worker/client";
import { useSnapshot, useStore } from "../state/context";
import { buildExportPlan, suggestName } from "../state/plan";
import { cleanPdfName } from "./ExportDialog";

/** Tools that take the document as it is and make sense after editing (not the ones that need other kinds of files or several). */
const SKIP = new Set(["edit", "merge", "jpg-to-pdf", "word-to-pdf", "excel-to-pdf", "powerpoint-to-pdf", "repair", "unlock"]);

/**
 * "Use another tool on this document": the current state of the document is created (as a download would) and handed
 * to another tool without being uploaded or saved to disk. The editor closes; the changes travel with the file.
 */
export function OtherToolDialog({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const { name } = useSnapshot();
  const navigate = useNavigate();
  const { offer } = useHandoff();
  const job = useJob<OutputFile>();
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && job.state.phase !== "running") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, job.state.phase]);

  const go = (toolId: string) => {
    setChosen(toolId);
    void job.run(async ({ signal, onProgress }) => {
      const plan = await buildExportPlan(store, cleanPdfName(suggestName(name)), "");
      const result = await runOperation("exportDocument", { plan }, { signal, onProgress });
      offer({ name: result.name, bytes: result.bytes });
      store.markExported();
      navigate(`/tools/${toolId}`);
      return result;
    });
  };

  const tools = TOOLS.filter((tool) => tool.accept.includes(".pdf") && !SKIP.has(tool.id));
  const running = job.state.phase === "running";

  return (
    <div className="ed-modal" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && !running && onClose()}>
      <div className="ed-dialog" role="dialog" aria-modal="true" aria-labelledby="tool-title" data-testid="tool-dialog">
        <header className="ed-dialog__head">
          <h2 id="tool-title">Use another tool on this document</h2>
          <button type="button" className="ed-iconbtn" aria-label="Close" disabled={running} onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="ed-dialog__body">
          {running && job.state.phase === "running" && <ProcessPanel title="Getting your document ready…" fraction={job.state.fraction} message={job.state.message} onCancel={job.cancel} />}
          {job.state.phase === "error" && <ErrorAlert error={job.state.error} onDismiss={job.reset} />}
          {!running && (
            <>
              <p className="ed-note">Your changes so far go with the document. It stays on this device; nothing is uploaded. The editor closes, so download first if you want a copy of the edited file.</p>
              {CATEGORIES.map((category) => {
                const inCategory = tools.filter((tool) => tool.category === category.id);
                if (inCategory.length === 0) return null;
                return (
                  <section key={category.id} className="ed-toolgroup">
                    <h3 className="ed-section__title">{category.name}</h3>
                    <ul className="ed-toollist">
                      {inCategory.map((tool) => (
                        <li key={tool.id}>
                          <button type="button" className="ed-toolitem" data-testid={`other-${tool.id}`} aria-busy={chosen === tool.id} onClick={() => go(tool.id)}>
                            <Icon name={tool.icon} size={20} />
                            <span>
                              <strong>{tool.name}</strong>
                              <small>{tool.short}</small>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
