import type { ToolProps } from "../types";
import { PageSelectionTool } from "./PageSelectionTool";

export default function DeleteTool(props: ToolProps) {
  return <PageSelectionTool {...props} mode="delete" />;
}
