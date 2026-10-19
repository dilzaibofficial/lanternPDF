import { type ReactNode, useEffect, useId, useState } from "react";
import { Icon, type IconName } from "../../components/ui/Icon";
import { PALETTE } from "../model/defaults";

/** Small form controls shared by the properties panel. Each commits on blur or Enter (numbers) so typing is not a history step per digit. */

interface NumberFieldProps {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  /** Digits shown after the point. */
  digits?: number;
  testId?: string;
  disabled?: boolean;
}

export function NumberField({ label, value, onCommit, min, max, step = 1, suffix, digits = 1, testId, disabled }: NumberFieldProps) {
  const id = useId();
  const shown = String(Math.round(value * 10 ** digits) / 10 ** digits);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    const parsed = Number(text.replace(",", "."));
    if (!Number.isFinite(parsed)) {
      setText(shown);
      return;
    }
    const clamped = Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, parsed));
    if (clamped !== value) onCommit(clamped);
    setText(String(Math.round(clamped * 10 ** digits) / 10 ** digits));
  };
  return (
    <div className="ed-field ed-field--number">
      <label htmlFor={id}>{label}</label>
      <span className="ed-field__box">
        <input
          id={id}
          className="input"
          type="text"
          inputMode="decimal"
          value={text}
          disabled={disabled}
          data-testid={testId}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              const delta = (event.key === "ArrowUp" ? 1 : -1) * step * (event.shiftKey ? 10 : 1);
              const next = Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, value + delta));
              onCommit(next);
            } else if (event.key === "Escape") {
              setText(shown);
            }
          }}
        />
        {suffix && <span className="ed-field__suffix">{suffix}</span>}
      </span>
    </div>
  );
}

interface SliderFieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  format?: (value: number) => string;
  testId?: string;
}

export function SliderField({ label, value, onChange, min = 0, max = 1, step = 0.01, format = (v) => `${Math.round(v * 100)}%`, testId }: SliderFieldProps) {
  const id = useId();
  return (
    <div className="ed-field ed-field--slider">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} data-testid={testId} onChange={(event) => onChange(Number(event.target.value))} onKeyDown={(event) => event.stopPropagation()} />
      <output htmlFor={id}>{format(value)}</output>
    </div>
  );
}

interface ColorFieldProps {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  /** Allow "none". */
  nullable?: boolean;
  testId?: string;
}

export function ColorField({ label, value, onChange, nullable, testId }: ColorFieldProps) {
  const id = useId();
  return (
    <div className="ed-field ed-field--color" role="group" aria-labelledby={`${id}-l`}>
      <span id={`${id}-l`} className="ed-field__label">
        {label}
      </span>
      <div className="ed-swatches">
        {nullable && (
          <button type="button" className={`ed-swatch ed-swatch--none${value === null ? " ed-swatch--on" : ""}`} aria-label={`${label}: none`} aria-pressed={value === null} onClick={() => onChange(null)} data-testid={testId ? `${testId}-none` : undefined} />
        )}
        {PALETTE.map((color) => (
          <button key={color} type="button" className={`ed-swatch${value?.toLowerCase() === color ? " ed-swatch--on" : ""}`} style={{ background: color }} aria-label={`${label}: ${color}`} aria-pressed={value?.toLowerCase() === color} onClick={() => onChange(color)} />
        ))}
        <label className="ed-swatch ed-swatch--custom" title="Choose another colour">
          <input type="color" value={value ?? "#000000"} aria-label={`${label}: custom colour`} data-testid={testId} onChange={(event) => onChange(event.target.value)} />
        </label>
      </div>
    </div>
  );
}

interface ToggleProps {
  label: string;
  icon: IconName;
  pressed: boolean;
  onChange: (pressed: boolean) => void;
  testId?: string;
}

export function Toggle({ label, icon, pressed, onChange, testId }: ToggleProps) {
  return (
    <button type="button" className={`ed-iconbtn${pressed ? " ed-iconbtn--on" : ""}`} aria-pressed={pressed} aria-label={label} title={label} data-testid={testId} onClick={() => onChange(!pressed)}>
      <Icon name={icon} size={18} />
    </button>
  );
}

interface ChoiceProps<T extends string> {
  label: string;
  value: T;
  options: readonly { value: T; label: ReactNode; title?: string; testId?: string }[];
  onChange: (value: T) => void;
  testId?: string;
}

export function Choice<T extends string>({ label, value, options, onChange, testId }: ChoiceProps<T>) {
  return (
    <div className="ed-field" role="radiogroup" aria-label={label} data-testid={testId}>
      <span className="ed-field__label">{label}</span>
      <div className="ed-choice">
        {options.map((option) => (
          <button key={option.value} type="button" role="radio" aria-checked={value === option.value} title={option.title} data-testid={option.testId} className={`ed-choice__item${value === option.value ? " ed-choice__item--on" : ""}`} onClick={() => onChange(option.value)}>
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <section className="ed-section">
      <h3 className="ed-section__title">{title}</h3>
      {hint && <p className="ed-section__hint">{hint}</p>}
      <div className="ed-section__body">{children}</div>
    </section>
  );
}
