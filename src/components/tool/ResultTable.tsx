import { formatBytes } from "../../lib/format";

export interface ResultRow {
  source: string;
  /** What was made. Missing when the file could not be converted. */
  output?: { name: string; size: number };
  /** Set when this file could not be converted. */
  error?: string;
  /** What was done and what was left out, in plain language. Shown behind a disclosure. */
  notes?: readonly string[];
}

/** One line per input file: what it became, how big that is, and what to check. Failures are listed, never hidden. */
export function ResultTable({ rows, caption = "Results" }: { rows: readonly ResultRow[]; caption?: string }) {
  return (
    <div className="table-scroll">
      <table className="savings" data-testid="result-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">File</th>
            <th scope="col">Result</th>
            <th scope="col" className="num">
              Size
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.source}-${index}`} data-testid="result-row">
              <th scope="row" className="savings__name">
                {row.source}
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
              <td>{row.error ? <span className="savings__status savings__status--bad">Failed: {row.error}</span> : <span className="savings__status savings__status--good">{row.output?.name}</span>}</td>
              <td className="num">{row.output ? formatBytes(row.output.size) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
