import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/ui/Icon";
import { useDebounced } from "../../hooks/useDebounced";
import { useSnapshot, useStore } from "../state/context";

/** Find and replace across every page, in the text the editor can edit. */
export function FindBar({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const { view } = useSnapshot();
  const [query, setQuery] = useState(view.find?.query ?? "");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(view.find?.caseSensitive ?? false);
  const [showReplace, setShowReplace] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const debounced = useDebounced(query, 220);
  const find = view.find;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  useEffect(() => {
    void store.find(debounced, caseSensitive);
  }, [debounced, caseSensitive, store]);

  // Closing the bar clears the highlights.
  useEffect(() => () => store.closeFind(), [store]);

  // Bring the current match into view.
  const current = find && find.current >= 0 ? find.matches[find.current] : undefined;
  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => document.querySelector("[data-find-current='true']")?.scrollIntoView({ block: "center", inline: "center" }), 80);
    return () => clearTimeout(timer);
  }, [current]);

  const total = find?.matches.length ?? 0;
  const searching = Boolean(find?.progress);
  const summary = query === "" ? "" : searching ? `Searching… ${find?.progress?.done}/${find?.progress?.total}` : total === 0 ? "No matches" : `${(find?.current ?? 0) + 1} of ${total}`;

  return (
    <div className="ed-find" role="search" aria-label="Find in the document" data-testid="find-bar">
      <div className="ed-find__row">
        <input
          ref={input}
          className="input"
          type="search"
          value={query}
          placeholder="Find in the document"
          aria-label="Find"
          data-testid="find-input"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              store.stepFind(event.shiftKey ? -1 : 1);
            } else if (event.key === "Escape") {
              onClose();
            }
          }}
        />
        <span className="ed-find__count" role="status" data-testid="find-count">
          {summary}
        </span>
        <button type="button" className={`ed-iconbtn${caseSensitive ? " ed-iconbtn--on" : ""}`} aria-pressed={caseSensitive} title="Match case" aria-label="Match case" onClick={() => setCaseSensitive((v) => !v)}>
          Aa
        </button>
        <button type="button" className="ed-iconbtn" title="Previous match (Shift+Enter)" aria-label="Previous match" disabled={total === 0} onClick={() => store.stepFind(-1)} data-testid="find-prev">
          <Icon name="chevron-up" size={18} />
        </button>
        <button type="button" className="ed-iconbtn" title="Next match (Enter)" aria-label="Next match" disabled={total === 0} onClick={() => store.stepFind(1)} data-testid="find-next">
          <Icon name="chevron-down" size={18} />
        </button>
        <button type="button" className={`ed-iconbtn${showReplace ? " ed-iconbtn--on" : ""}`} aria-pressed={showReplace} title="Replace" aria-label="Show replace" onClick={() => setShowReplace((v) => !v)} data-testid="find-replace-toggle">
          <Icon name="edit-text" size={18} />
        </button>
        <button type="button" className="ed-iconbtn" title="Redact every match: boxes are placed over them and the words are removed from the file when you download" aria-label="Redact all matches" disabled={total === 0} onClick={() => store.redactMatches()} data-testid="redact-matches">
          <Icon name="redact" size={18} />
        </button>
        <button type="button" className="ed-iconbtn" title="Close (Escape)" aria-label="Close find" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>
      {showReplace && (
        <div className="ed-find__row">
          <input
            className="input"
            type="text"
            value={replacement}
            placeholder="Replace with"
            aria-label="Replace with"
            data-testid="replace-input"
            onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
          <button type="button" className="btn btn--secondary btn--sm" disabled={total === 0 || (find?.current ?? -1) < 0} data-testid="replace-one" onClick={() => store.replaceMatches("current", replacement)}>
            Replace
          </button>
          <button type="button" className="btn btn--secondary btn--sm" disabled={total === 0} data-testid="replace-all" onClick={() => store.replaceMatches("all", replacement)}>
            Replace all
          </button>
        </div>
      )}
      {showReplace && <p className="ed-find__hint">Replacements are edits of the text in the page, like any other. Lines that cannot be edited are skipped and named.</p>}
    </div>
  );
}
