interface PositionPickerProps<T extends string> {
  legend: string;
  value: T;
  onChange: (value: T) => void;
  /** Cells in reading order (3 per row), each with the text a screen reader announces. */
  cells: readonly { value: T; label: string }[];
  /** An extra full-width option below the grid, such as "Repeat across the page". */
  extra?: { value: T; label: string };
}

/** A tiny page diagram: choose where something goes by clicking a cell. Behaves as a radio group. */
export function PositionPicker<T extends string>({ legend, value, onChange, cells, extra }: PositionPickerProps<T>) {
  const rows = Math.ceil(cells.length / 3) + (extra ? 1 : 0);
  return (
    <fieldset>
      <legend>{legend}</legend>
      <div
        className="position-grid position-grid--cols-3"
        role="radiogroup"
        aria-label={legend}
        style={{ gridTemplateRows: `repeat(${rows}, ${extra ? "minmax(0, 1fr)" : "minmax(0, 1fr)"})`, aspectRatio: extra ? "3 / 4.4" : "3 / 4" }}
      >
        {cells.map((cell) => (
          <button key={cell.value} type="button" role="radio" aria-checked={value === cell.value} aria-label={cell.label} title={cell.label} className="position-cell" onClick={() => onChange(cell.value)} />
        ))}
        {extra && (
          <button type="button" role="radio" aria-checked={value === extra.value} aria-label={extra.label} className="position-cell position-cell--tile" onClick={() => onChange(extra.value)}>
            {extra.label}
          </button>
        )}
      </div>
    </fieldset>
  );
}
