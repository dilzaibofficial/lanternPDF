import type { ToolProps } from "../types";
import { PageSelectionTool } from "./PageSelectionTool";

export default function ExtractTool(props: ToolProps) {
  return <PageSelectionTool {...props} mode="extract" />;
}
