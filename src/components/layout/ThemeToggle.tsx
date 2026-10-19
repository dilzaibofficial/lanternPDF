import { type ThemePreference, useTheme } from "../../hooks/useTheme";
import { Icon } from "../ui/Icon";

/** One-click light/dark switch for the header. */
export function ThemeToggle() {
  const { resolved, toggle } = useTheme();
  const next = resolved === "dark" ? "light" : "dark";
  return (
    <button type="button" className="btn btn--ghost btn--icon" onClick={toggle} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}>
      <Icon name={resolved === "dark" ? "sun" : "moon"} />
    </button>
  );
}

const OPTIONS: { value: ThemePreference; label: string; icon: "monitor" | "sun" | "moon" }[] = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

/** Three-way theme choice (follow system / light / dark) for the footer. */
export function ThemeSelect() {
  const { preference, setPreference } = useTheme();
  return (
    <fieldset>
      <legend className="sr-only">Colour theme</legend>
      <div className="segmented" role="radiogroup" aria-label="Colour theme">
        {OPTIONS.map((option) => (
          <label className="segmented__item" key={option.value}>
            <input
              type="radio"
              name="theme"
              value={option.value}
              checked={preference === option.value}
              onChange={() => setPreference(option.value)}
            />
            <span>
              <Icon name={option.icon} size={16} />
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
