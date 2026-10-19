import type { ProcessingMode } from "../../config/tools";
import { Icon } from "../ui/Icon";

/** States where a file goes. This is the honest answer to "is my document uploaded?". */
export function ProcessingBadge({ mode }: { mode: ProcessingMode }) {
  if (mode === "browser") {
    return (
      <span className="badge badge--success">
        <Icon name="shield" size={14} />
        On your device
      </span>
    );
  }
  if (mode === "optional-server") {
    return (
      <span className="badge badge--info">
        <Icon name="shield" size={14} />
        On your device · optional server mode
      </span>
    );
  }
  return (
    <span className="badge badge--warning">
      <Icon name="server" size={14} />
      Uses the server
    </span>
  );
}
