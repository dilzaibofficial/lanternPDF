import type { ToolProps } from "../types";
import { PageWorkspaceTool } from "./PageWorkspace";

export default function RotateTool(props: ToolProps) {
  return <PageWorkspaceTool {...props} mode="rotate" />;
}
