import { formatBytes, percentSaved } from "../../lib/format";

export interface SavingsRow {
  name: string;
  /** Size of the original file, in bytes. */
  before: number;
  /** Size of the new file, or `null` when no smaller file was made and the original is kept. */
  after: number | null;
  /** Set when this file could not be processed. */
  error?: string;
  /** What was done, in plain language. Shown behind a disclosure. */
  notes?: readonly string[];
}

/** The real before/after sizes of every file, so nothing about the saving is taken on trust. */
export function SavingsTable({ rows, caption = "Results" }: { rows: readonly SavingsRow[]; caption?: string }) {
  return (
    <div className="table-scroll">
      <table className="savings" data-testid="savings-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">File</th>
            <th scope="col" className="num">
              Before
            </th>
            <th scope="col" className="num">
              After
            </th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const saved = row.after === null ? 0 : percentSaved(row.before, row.after);
            return (
              <tr key={`${row.name}-${index}`} data-testid="savings-row">
                <th scope="row" className="savings__name">
                  {row.name}
                  {row.notes && row.notes.length > 0 && (
                    <details>
                      <summary>What was done</summary>
                      <ul className="note-list">
                        {row.notes.map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </th>
                <td className="num">{formatBytes(row.before)}</td>
                <td className="num">{row.after === null ? "—" : formatBytes(row.after)}</td>
                <td>
                  {row.error ? (
                    <span className="savings__status savings__status--bad">Failed: {row.error}</span>
                  ) : row.after === null ? (
                    <span className="savings__status">No reduction. Your original is kept.</span>
                  ) : (
                    <>
                      <span className="savings__status savings__status--good">{saved}% smaller</span>
                      <span className="savings__bar" aria-hidden="true">
                        <span style={{ width: `${saved}%` }} />
                      </span>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
