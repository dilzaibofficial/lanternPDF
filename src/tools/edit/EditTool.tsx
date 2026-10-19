import { Navigate } from "react-router";

/**
 * "Edit PDF" is the full editor, which has its own screen. Anything handed over from another tool is still waiting
 * in the hand-off slot, so the editor opens with it.
 */
export default function EditTool() {
  return <Navigate to="/editor" replace />;
}
