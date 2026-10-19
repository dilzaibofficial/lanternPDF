import { Link } from "react-router";
import type { ToolDefinition } from "../../config/tools";
import { Icon } from "../ui/Icon";
import { ProcessingBadge } from "./ProcessingBadge";

export function ToolCard({ tool }: { tool: ToolDefinition }) {
  return (
    <Link to={`/tools/${tool.id}`} className="tool-card" data-cat={tool.category} data-testid={`tool-card-${tool.id}`}>
      <span className="tool-card__icon">
        <Icon name={tool.icon} size={26} />
      </span>
      <span className="tool-card__name">{tool.name}</span>
      <span className="tool-card__short">{tool.short}</span>
      <span className="tool-card__meta">
        <ProcessingBadge mode={tool.processing} />
      </span>
    </Link>
  );
}
