import { Link } from "react-router";
import { useCapabilities } from "../../hooks/useCapabilities";
import { Alert } from "../ui/Alerts";
import { Icon } from "../ui/Icon";

type Engine = "libreoffice" | "ghostscript";

const ENGINE_NAME: Record<Engine, string> = { libreoffice: "LibreOffice", ghostscript: "Ghostscript" };

/**
 * Says what is missing when a tool needs the optional server: it is not reachable, or it is running but the
 * engine is not installed. Renders nothing when the engine is available (or while that is still being checked).
 */
export function ServerNotice({ engine, what }: { engine: Engine; what: string }) {
  const state = useCapabilities();
  if (state.status === "idle" || state.status === "loading") {
    return (
      <div className="viewer__loading" role="status">
        <span className="spinner" aria-hidden="true" /> Checking the conversion server…
      </div>
    );
  }
  if (state.status === "unavailable") {
    return (
      <Alert tone="warning" title="This needs the optional server" testId="server-notice">
        <p>
          {what} runs on a server you host, and this page could not reach one. The other tools on this site work without it, entirely in your browser.
        </p>
        <p>
          <Link to="/self-hosting">How to run the server</Link>
        </p>
      </Alert>
    );
  }
  const status = state.capabilities.engines[engine];
  if (status.available) return null;
  return (
    <Alert tone="warning" title={`${ENGINE_NAME[engine]} is not installed on the server`} testId="server-notice">
      <p>
        {what} needs {ENGINE_NAME[engine]}. {status.reason ?? ""}
      </p>
      <p>
        <Icon name="server" size={16} /> <Link to="/self-hosting">How to install it and point the server at it</Link>
      </p>
    </Alert>
  );
}
