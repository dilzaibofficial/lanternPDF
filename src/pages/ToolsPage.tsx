import { CategoryChips, SearchBox, ToolGrid, useCatalogState } from "../components/catalog/ToolCatalog";
import { TOOLS } from "../config/tools";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export default function ToolsPage() {
  useDocumentTitle("All PDF tools", "Browse and search every PDF tool: merge, split, compress, convert, edit and protect.");
  const catalog = useCatalogState();
  return (
    <div className="container">
      <div className="page-head">
        <h1>All PDF tools</h1>
        <p>{TOOLS.length} tools. Search by what you want to do, or filter by category.</p>
      </div>
      <div className="catalog__controls">
        <SearchBox value={catalog.query} onChange={catalog.setQuery} />
        <CategoryChips value={catalog.category} onChange={catalog.setCategory} />
        <p className="muted" role="status" aria-live="polite" style={{ fontSize: "var(--text-sm)" }}>
          {catalog.filtered ? `${catalog.results.length} ${catalog.results.length === 1 ? "tool" : "tools"} found` : `${TOOLS.length} tools`}
        </p>
      </div>
      <div style={{ paddingBottom: "var(--space-12)" }}>
        <ToolGrid tools={catalog.results} grouped={!catalog.filtered} onClear={catalog.clear} query={catalog.query} />
      </div>
    </div>
  );
}
