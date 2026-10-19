interface ProcessPanelProps {
  title?: string;
  fraction: number;
  message?: string;
  onCancel?: () => void;
}

/** Shown while a job runs: real progress, what step it is on, and a way out. */
export function ProcessPanel({ title = "Working on it…", fraction, message, onCancel }: ProcessPanelProps) {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  const indeterminate = percent === 0;
  return (
    <div className="process" data-testid="process-panel">
      <span className="spinner" style={{ width: "2.2rem", height: "2.2rem", color: "var(--primary)" }} aria-hidden="true" />
      <h2 className="process__title">{title}</h2>
      <div className="process__bar">
        <div
          className={`progress${indeterminate ? " progress--indeterminate" : ""}`}
          role="progressbar"
          aria-label="Progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={indeterminate ? undefined : percent}
        >
          <div className="progress__bar" style={{ width: `${percent}%` }} />
        </div>
      </div>
      <p className="process__status" role="status" aria-live="polite">
        {message ?? "Starting…"}
        {!indeterminate && ` · ${percent}%`}
      </p>
      {onCancel && (
        <button type="button" className="btn btn--secondary" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}
