import type { ReactNode } from "react";
import { type AppError, describeError } from "../../lib/errors";
import { Icon } from "./Icon";

type Tone = "info" | "success" | "warning" | "danger";

const TONE_ICON = { info: "info", success: "check", warning: "alert", danger: "alert" } as const;

interface AlertProps {
  tone: Tone;
  title?: string;
  children?: ReactNode;
  actions?: ReactNode;
  /** `alert` interrupts screen readers; use only for errors. */
  live?: "polite" | "assertive" | "off";
  testId?: string;
}

export function Alert({ tone, title, children, actions, live = "off", testId }: AlertProps) {
  return (
    <div
      className={`alert alert--${tone}`}
      role={live === "assertive" ? "alert" : live === "polite" ? "status" : undefined}
      data-testid={testId}
    >
      <Icon name={TONE_ICON[tone]} className="alert__icon" size={20} />
      <div className="alert__body">
        {title && <div className="alert__title">{title}</div>}
        {children}
        {actions && <div className="alert__actions">{actions}</div>}
      </div>
    </div>
  );
}

interface ErrorAlertProps {
  error: AppError;
  onRetry?: () => void;
  onDismiss?: () => void;
}

/** The standard way to show a failure: what happened, what to do, and (collapsed) the technical detail. */
export function ErrorAlert({ error, onRetry, onDismiss }: ErrorAlertProps) {
  const { title, hint } = describeError(error);
  return (
    <div className="alert alert--danger" role="alert" data-testid="error-alert" data-error-code={error.code}>
      <Icon name="alert" className="alert__icon" size={20} />
      <div className="alert__body">
        <div className="alert__title">{title}</div>
        {hint && <p>{hint}</p>}
        {error.details && (
          <details className="alert__details">
            <summary>Technical details</summary>
            <pre>{error.details}</pre>
          </details>
        )}
        {(onRetry || onDismiss) && (
          <div className="alert__actions">
            {onRetry && (
              <button type="button" className="btn btn--sm btn--secondary" onClick={onRetry}>
                Try again
              </button>
            )}
            {onDismiss && (
              <button type="button" className="btn btn--sm btn--ghost" onClick={onDismiss}>
                Dismiss
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
