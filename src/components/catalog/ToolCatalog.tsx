import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { CATEGORIES, type ToolCategoryId, type ToolDefinition, searchTools, toolsInCategory } from "../../config/tools";
import { Icon } from "../ui/Icon";
import { ToolCard } from "./ToolCard";

export type CategoryFilter = ToolCategoryId | "all";

/** Search text and category live in the URL (?q=…&category=…), so filtered views can be shared. */
export function useCatalogState() {
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const rawCategory = params.get("category");
  const category: CategoryFilter = CATEGORIES.some((c) => c.id === rawCategory) ? (rawCategory as ToolCategoryId) : "all";

  const update = useCallback(
    (next: { q?: string; category?: CategoryFilter }) => {
      setParams(
        (current) => {
          const merged = new URLSearchParams(current);
          if (next.q !== undefined) {
            if (next.q) merged.set("q", next.q);
            else merged.delete("q");
          }
          if (next.category !== undefined) {
            if (next.category !== "all") merged.set("category", next.category);
            else merged.delete("category");
          }
          return merged;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const results = useMemo(() => searchTools(query, category), [query, category]);
  return {
    query,
    category,
    results,
    setQuery: (q: string) => update({ q }),
    setCategory: (c: CategoryFilter) => update({ category: c }),
    clear: () => setParams({}, { replace: true }),
    filtered: query.trim() !== "" || category !== "all",
  };
}

interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  inputId?: string;
  autoFocus?: boolean;
}

export function SearchBox({ value, onChange, inputId = "tool-search", autoFocus }: SearchBoxProps) {
  return (
    <form className="search-box" role="search" onSubmit={(event) => event.preventDefault()}>
      <Icon name="search" size={22} />
      <label htmlFor={inputId} className="sr-only">
        Search PDF tools
      </label>
      <input
        id={inputId}
        type="search"
        placeholder="Search tools: merge, compress, rotate, convert…"
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && (
        <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label="Clear search" onClick={() => onChange("")}>
          <Icon name="close" size={18} />
        </button>
      )}
    </form>
  );
}

export function CategoryChips({ value, onChange }: { value: CategoryFilter; onChange: (value: CategoryFilter) => void }) {
  const items: { id: CategoryFilter; name: string }[] = [{ id: "all", name: "All tools" }, ...CATEGORIES.map((c) => ({ id: c.id, name: c.name }))];
  return (
    <div className="chips" role="group" aria-label="Filter by category">
      {items.map((item) => (
        <button key={item.id} type="button" className="chip" aria-pressed={value === item.id} onClick={() => onChange(item.id)}>
          {item.name}
        </button>
      ))}
    </div>
  );
}

interface GridProps {
  tools: readonly ToolDefinition[];
  /** Show tools under a heading per category (used when nothing is filtered). */
  grouped: boolean;
  onClear: () => void;
  query: string;
}

export function ToolGrid({ tools, grouped, onClear, query }: GridProps) {
  if (tools.length === 0) {
    return (
      <div className="catalog__empty" role="status">
        <p>
          No tool matches <strong>“{query}”</strong>.
        </p>
        <p style={{ marginTop: "var(--space-3)" }}>
          <button type="button" className="btn btn--secondary" onClick={onClear}>
            Show all tools
          </button>
        </p>
      </div>
    );
  }

  if (!grouped) {
    return (
      <div className="tool-grid" data-testid="tool-grid">
        {tools.map((tool) => (
          <ToolCard key={tool.id} tool={tool} />
        ))}
      </div>
    );
  }

  return (
    <div data-testid="tool-grid">
      {CATEGORIES.map((category) => {
        const items = toolsInCategory(category.id);
        if (items.length === 0) return null;
        return (
          <section key={category.id} className="catalog__group" data-cat={category.id} aria-labelledby={`group-${category.id}`}>
            <h3 className="catalog__group-title" id={`group-${category.id}`}>
              {category.name}
              <small>{category.blurb}</small>
            </h3>
            <div className="tool-grid">
              {items.map((tool) => (
                <ToolCard key={tool.id} tool={tool} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
