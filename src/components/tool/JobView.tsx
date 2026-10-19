import type { ReactNode } from "react";
import type { useJob } from "../../hooks/useJob";
import { ErrorAlert } from "../ui/Alerts";
import { ProcessPanel } from "./ProcessPanel";

interface JobViewProps<T> {
  job: ReturnType<typeof useJob<T>>;
  /** Heading while the job runs, e.g. "Merging your PDFs…". */
  title: string;
  /** What to show when the job has finished. */
  renderResult: (result: T) => ReactNode;
  /** The options screen, shown when idle or after an error (with the error above it). */
  children: ReactNode;
}

/** Switches the workspace between options, progress, result and error states of one job. */
export function JobView<T>({ job, title, renderResult, children }: JobViewProps<T>) {
  const state = job.state;
  if (state.phase === "running") {
    return <ProcessPanel title={title} fraction={state.fraction} message={state.message} onCancel={job.cancel} />;
  }
  if (state.phase === "done") {
    return <>{renderResult(state.result)}</>;
  }
  return (
    <div className="stack">
      {state.phase === "error" && <ErrorAlert error={state.error} onDismiss={job.reset} />}
      {children}
    </div>
  );
}
