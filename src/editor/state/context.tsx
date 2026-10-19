import { type ReactNode, createContext, useContext, useSyncExternalStore } from "react";
import type { Id } from "../model/types";
import type { EditorStore, PageData, Snapshot } from "./store";

const StoreContext = createContext<EditorStore | null>(null);

export function EditorProvider({ store, children }: { store: EditorStore; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- shared helper kept next to the code that uses it
export function useStore(): EditorStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore must be used inside <EditorProvider>");
  return store;
}

/** The document, the view and the history flags. Re-renders on any of them changing. */
// eslint-disable-next-line react-refresh/only-export-components -- shared helper kept next to the code that uses it
export function useSnapshot(): Snapshot {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** The background-computed data of one page: its analysis and the real result of its text edits. */
// eslint-disable-next-line react-refresh/only-export-components -- shared helper kept next to the code that uses it
export function usePageData(id: Id): PageData {
  const store = useStore();
  return useSyncExternalStore(
    (listener) => store.subscribePage(id, listener),
    () => store.getPageData(id),
    () => store.getPageData(id),
  );
}
