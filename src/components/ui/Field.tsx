import { type ReactNode, useId, useState } from "react";
import { Icon } from "./Icon";

interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  /** Receives the generated id and the ids of the hint/error, to wire up the control. */
  children: (control: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
  className?: string;
}

/** Label + control + hint/error, with the ARIA wiring done once. */
export function Field({ label, hint, error, children, className }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`field${className ? ` ${className}` : ""}`}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint && (
        <span className="field__hint" id={hintId}>
          {hint}
        </span>
      )}
      {error && (
        <span className="field__error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}

export function Checkbox({ checked, onChange, label, hint, disabled }: CheckboxProps) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="check__text">
        <span className="check__label">{label}</span>
        {hint && <span className="check__hint">{hint}</span>}
      </span>
    </label>
  );
}

interface SegmentedProps<T extends string> {
  name: string;
  legend: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: ReactNode }[];
  hideLegend?: boolean;
}

export function Segmented<T extends string>({ name, legend, value, onChange, options, hideLegend }: SegmentedProps<T>) {
  return (
    <fieldset>
      <legend className={hideLegend ? "sr-only" : undefined}>{legend}</legend>
      <div className="segmented" role="radiogroup" aria-label={legend}>
        {options.map((option) => (
          <label className="segmented__item" key={option.value}>
            <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

interface ChoiceCardsProps<T extends string> {
  name: string;
  legend: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; title: ReactNode; description: ReactNode; tag?: string; testId?: string; disabled?: boolean }[];
}

/** A radio group whose options each carry an explanation: for choices where the consequences matter. */
export function ChoiceCards<T extends string>({ name, legend, value, onChange, options }: ChoiceCardsProps<T>) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      <div className="choices" role="radiogroup" aria-label={legend}>
        {options.map((option) => (
          <label className={`choice${value === option.value ? " choice--on" : ""}${option.disabled ? " choice--disabled" : ""}`} key={option.value}>
            <input type="radio" name={name} value={option.value} checked={value === option.value} disabled={option.disabled} onChange={() => onChange(option.value)} data-testid={option.testId} />
            <span className="choice__body">
              <span className="choice__title">
                {option.title}
                {option.tag && <span className="choice__tag">{option.tag}</span>}
              </span>
              <span className="choice__desc">{option.description}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

interface PasswordInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  describedBy?: string;
  invalid?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  autoComplete?: string;
  onEnter?: () => void;
}

/** Password box with a show/hide toggle. The value never leaves the page. */
export function PasswordInput({ id, value, onChange, describedBy, invalid, placeholder, autoFocus, autoComplete = "off", onEnter }: PasswordInputProps) {
  const [shown, setShown] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <input
        id={id}
        className="input"
        style={{ paddingRight: "3rem" }}
        type={shown ? "text" : "password"}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        spellCheck={false}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && onEnter) {
            event.preventDefault();
            onEnter();
          }
        }}
      />
      <button
        type="button"
        className="btn btn--ghost btn--icon btn--sm"
        style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)" }}
        aria-label={shown ? "Hide password" : "Show password"}
        aria-pressed={shown}
        onClick={() => setShown((s) => !s)}
      >
        <Icon name="eye" size={18} />
      </button>
    </div>
  );
}
