import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Capabilities } from "../../shared/api";
import { fetchCapabilities } from "../lib/api";

type State = { status: "idle" } | { status: "loading" } | { status: "ready"; capabilities: Capabilities } | { status: "unavailable" };

interface ContextValue {
  state: State;
  request: () => void;
}

const CapabilitiesContext = createContext<ContextValue>({ state: { status: "idle" }, request: () => undefined });

/**
 * Knows what the optional server can do. It asks only when a page that cares (a server-backed tool,
 * or the self-hosting page) first uses it, so visitors of browser-only tools never trigger a request.
 */
export function CapabilitiesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "idle" });
  const started = useRef(false);

  const request = useCallback(() => {
    if (started.current) return;
    started.current = true;
    setState({ status: "loading" });
    void fetchCapabilities().then((capabilities) => setState(capabilities ? { status: "ready", capabilities } : { status: "unavailable" }));
  }, []);

  const value = useMemo(() => ({ state, request }), [state, request]);
  return <CapabilitiesContext.Provider value={value}>{children}</CapabilitiesContext.Provider>;
}

/** Current server capabilities. Using this hook is what triggers the (one-time) request, unless `enabled` is false. */
export function useCapabilities(enabled = true): State {
  const { state, request } = useContext(CapabilitiesContext);
  useEffect(() => {
    if (enabled) request();
  }, [enabled, request]);
  return state;
}

/** True/false once known, `undefined` while loading. */
export function useEngineAvailable(engine: "libreoffice" | "ghostscript"): boolean | undefined {
  const state = useCapabilities();
  if (state.status === "idle" || state.status === "loading") return undefined;
  if (state.status === "unavailable") return false;
  return state.capabilities.engines[engine].available;
}
