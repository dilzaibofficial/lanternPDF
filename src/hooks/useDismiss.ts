import { type RefObject, useEffect } from "react";

/** Calls `onDismiss` on Escape or on a pointer press outside every ref in `refs`, while `active`. */
export function useDismiss(refs: RefObject<HTMLElement | null>[], active: boolean, onDismiss: () => void): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && refs.every((ref) => !ref.current?.contains(target))) onDismiss();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
    // `refs` is rebuilt each render by callers; the refs themselves are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, onDismiss]);
}
