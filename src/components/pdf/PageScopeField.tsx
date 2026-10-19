import { useMemo, useState } from "react";
import { AppError } from "../../lib/errors";
import { expandRanges, parsePageRanges } from "../../lib/ranges";
import { Field } from "../ui/Field";
import { PageRangeField } from "./PageRangeField";

export type PageScope = "all" | "odd" | "even" | "skip-first" | "range";

export interface ResolvedScope {
  /** 1-based pages, or `null` for every page. */
  pages: number[] | null;
  error: string | null;
  /** True when no page is selected (the tool should not run). */
  empty: boolean;
}

/** "All pages / odd / even / all but the first / a range", resolved against the document's page count. */
export function usePageScope(pageCount: number) {
  const [scope, setScope] = useState<PageScope>("all");
  const [text, setText] = useState("");

  const resolved = useMemo((): ResolvedScope => {
    const every = Array.from({ length: pageCount }, (_, i) => i + 1);
    switch (scope) {
      case "all":
        return { pages: null, error: null, empty: false };
      case "odd":
        return { pages: every.filter((p) => p % 2 === 1), error: null, empty: false };
      case "even": {
        const pages = every.filter((p) => p % 2 === 0);
        return { pages, error: null, empty: pages.length === 0 };
      }
      case "skip-first": {
        const pages = every.slice(1);
        return { pages, error: null, empty: pages.length === 0 };
      }
      case "range": {
        if (text.trim() === "") return { pages: [], error: null, empty: true };
        try {
          const pages = [...new Set(expandRanges(parsePageRanges(text, pageCount)))].sort((a, b) => a - b);
          return { pages, error: null, empty: false };
        } catch (error) {
          return { pages: [], error: error instanceof AppError ? error.message : "Check the page range.", empty: true };
        }
      }
    }
  }, [scope, text, pageCount]);

  return { scope, setScope, text, setText, resolved };
}

interface Props {
  pageCount: number;
  state: ReturnType<typeof usePageScope>;
  label?: string;
}

export function PageScopeField({ pageCount, state, label = "Apply to" }: Props) {
  return (
    <div className="panel__section">
      <Field label={label}>
        {({ id }) => (
          <select id={id} className="select" value={state.scope} onChange={(event) => state.setScope(event.target.value as PageScope)} data-testid="page-scope">
            <option value="all">All pages</option>
            <option value="skip-first">All except the first page</option>
            <option value="odd">Odd pages</option>
            <option value="even">Even pages</option>
            <option value="range">A page range…</option>
          </select>
        )}
      </Field>
      {state.scope === "range" && <PageRangeField value={state.text} onChange={state.setText} pageCount={pageCount} error={state.resolved.error} />}
    </div>
  );
}
