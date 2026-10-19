import type { ToolProps } from "../types";
import { PageWorkspaceTool } from "./PageWorkspace";

export default function OrganizeTool(props: ToolProps) {
  return <PageWorkspaceTool {...props} mode="organize" />;
}
