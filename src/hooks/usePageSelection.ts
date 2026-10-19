import { useCallback, useMemo, useState } from "react";
import { AppError } from "../lib/errors";
import { expandRanges, formatPageList, parsePageRanges } from "../lib/ranges";

/**
 * A set of selected pages that stays in sync with a text box such as "1-3, 5". Clicking pages
 * rewrites the text; typing rewrites the selection. While the text is invalid the previous
 * selection is kept and `error` explains what is wrong.
 */
export function usePageSelection(pageCount: number) {
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [text, setTextState] = useState("");
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((pages: Iterable<number>) => {
    const sorted = [...new Set(pages)].sort((a, b) => a - b);
    setSelected(new Set(sorted));
    setTextState(formatPageList(sorted));
    setError(null);
  }, []);

  const setText = useCallback(
    (value: string) => {
      setTextState(value);
      if (value.trim() === "") {
        setSelected(new Set());
        setError(null);
        return;
      }
      try {
        setSelected(new Set(expandRanges(parsePageRanges(value, pageCount))));
        setError(null);
      } catch (caught) {
        setError(caught instanceof AppError ? caught.message : "Enter pages like 1-3, 5.");
      }
    },
    [pageCount],
  );

  const toggle = useCallback(
    (page: number) => {
      const next = new Set(selected);
      if (next.has(page)) next.delete(page);
      else next.add(page);
      apply(next);
    },
    [apply, selected],
  );

  const all = useMemo(() => Array.from({ length: pageCount }, (_, i) => i + 1), [pageCount]);

  return {
    selected,
    text,
    error,
    setText,
    toggle,
    selectAll: () => apply(all),
    clear: () => apply([]),
    invert: () => apply(all.filter((page) => !selected.has(page))),
    selectOdd: () => apply(all.filter((page) => page % 2 === 1)),
    selectEven: () => apply(all.filter((page) => page % 2 === 0)),
    /** Selected page numbers, ascending. */
    pages: [...selected].sort((a, b) => a - b),
  };
}

export type PageSelection = ReturnType<typeof usePageSelection>;
