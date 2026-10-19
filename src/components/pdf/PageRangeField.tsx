import { Field } from "../ui/Field";

interface Props {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  pageCount: number;
  error?: string | null;
  placeholder?: string;
  hint?: string;
}

/** A text box for page ranges such as "1-3, 5, 8-", with the document's page count as context. */
export function PageRangeField({ label = "Pages", value, onChange, pageCount, error, placeholder = "e.g. 1-3, 5, 8-", hint }: Props) {
  return (
    <Field label={label} error={error} hint={hint ?? `This document has ${pageCount} ${pageCount === 1 ? "page" : "pages"}. Use commas and dashes; “8-” means page 8 to the end.`}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          className="input input--mono"
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={value}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}
