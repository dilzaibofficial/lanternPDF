import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";

export interface HandoffFile {
  name: string;
  bytes: Uint8Array;
}

interface HandoffContextValue {
  /** Leave a file for the next tool page to pick up. */
  offer: (file: HandoffFile) => void;
  /** Takes the offered file, if any. It is handed over once. */
  take: () => HandoffFile | null;
}

const HandoffContext = createContext<HandoffContextValue | null>(null);

/**
 * Lets "Continue with…" pass a result to another tool without a download and re-upload. The file only
 * ever lives in this tab's memory.
 */
export function HandoffProvider({ children }: { children: ReactNode }) {
  const slot = useRef<HandoffFile | null>(null);
  const offer = useCallback((file: HandoffFile) => {
    slot.current = file;
  }, []);
  const take = useCallback(() => {
    const file = slot.current;
    slot.current = null;
    return file;
  }, []);
  const value = useMemo(() => ({ offer, take }), [offer, take]);
  return <HandoffContext.Provider value={value}>{children}</HandoffContext.Provider>;
}

export function useHandoff(): HandoffContextValue {
  const context = useContext(HandoffContext);
  if (!context) throw new Error("useHandoff must be used inside <HandoffProvider>");
  return context;
}

/** Call once in a tool: if another tool handed over a file, it is added to the list on mount. */
export function useAcceptHandoff(addBytes: (name: string, bytes: Uint8Array) => void): void {
  const { take } = useHandoff();
  const added = useRef(false);
  useEffect(() => {
    if (added.current) return;
    const file = take();
    if (file) {
      added.current = true;
      addBytes(file.name, file.bytes);
    }
    // Only on mount: later changes to addBytes must not re-add the file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
