import { Suspense } from "react";
import { Link, useParams } from "react-router";
import { ProcessingBadge } from "../components/catalog/ProcessingBadge";
import { ToolCard } from "../components/catalog/ToolCard";
import { Alert } from "../components/ui/Alerts";
import { Icon } from "../components/ui/Icon";
import { categoryOf, getTool } from "../config/tools";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { TOOL_COMPONENTS } from "../tools/registry";
import NotFoundPage from "./NotFoundPage";

export default function ToolPage() {
  const { toolId } = useParams();
  const tool = getTool(toolId);
  useDocumentTitle(tool?.name, tool?.short);
  if (!tool) return <NotFoundPage />;

  const category = categoryOf(tool);
  const Component = TOOL_COMPONENTS[tool.id];
  const related = tool.related.map((id) => getTool(id)).filter((entry) => entry !== undefined);

  return (
    <div className="container tool-page" data-cat={tool.category}>
      <nav aria-label="Breadcrumb">
        <ol className="breadcrumb">
          <li>
            <Link to="/">Home</Link>
          </li>
          <li>
            <Link to={`/tools?category=${category.id}`}>{category.name}</Link>
          </li>
          <li aria-current="page">{tool.name}</li>
        </ol>
      </nav>

      <header className="tool-head">
        <span className="tool-head__icon">
          <Icon name={tool.icon} size={30} />
        </span>
        <div>
          <h1>{tool.name}</h1>
          <p>{tool.description}</p>
          <div className="tool-head__badges">
            <ProcessingBadge mode={tool.processing} />
          </div>
        </div>
      </header>

      <section className="workspace card" aria-label={`${tool.name} workspace`} data-testid="workspace">
        {Component ? (
          <Suspense
            fallback={
              <div className="viewer__loading" role="status">
                <span className="spinner" aria-hidden="true" /> Loading {tool.name}…
              </div>
            }
          >
            <Component tool={tool} />
          </Suspense>
        ) : (
          <Alert tone="danger" title="This tool is not available in this build.">
            <p>It is listed in the catalog but has no implementation here. Please report this.</p>
          </Alert>
        )}
      </section>

      <div className="tool-extra">
        <section aria-labelledby="howto-title">
          <h2 className="section__title" id="howto-title" style={{ fontSize: "var(--text-2xl)", marginBottom: "var(--space-5)" }}>
            How it works
          </h2>
          <ol className="steps" role="list">
            {tool.howTo.map((step, index) => (
              <li className="step" key={index}>
                <p style={{ color: "var(--text)", fontSize: "var(--text-base)" }}>{step}</p>
              </li>
            ))}
          </ol>
        </section>

        {related.length > 0 && (
          <section aria-labelledby="related-title">
            <h2 className="section__title" id="related-title" style={{ fontSize: "var(--text-2xl)", marginBottom: "var(--space-5)" }}>
              Related tools
            </h2>
            <div className="tool-grid">
              {related.map((entry) => (
                <ToolCard key={entry.id} tool={entry} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
