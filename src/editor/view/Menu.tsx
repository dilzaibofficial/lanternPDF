import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** What a menu's trigger button needs; spread it onto the button. */
export interface MenuTriggerProps {
  ref: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  "aria-haspopup": "menu" | "dialog";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
}

export interface MenuApi {
  close: () => void;
}

interface MenuProps {
  /** The accessible name of the open menu. */
  label: string;
  /** Draws the button that opens the menu. */
  trigger: (props: MenuTriggerProps, open: boolean) => ReactNode;
  children: ReactNode | ((api: MenuApi) => ReactNode);
  /** Which edge of the button the menu lines up with. */
  align?: "start" | "end";
  /** "menu" for a list of commands, "dialog" for anything else (a list of steps, a form). */
  role?: "menu" | "dialog";
  className?: string;
  /** Test id of the open panel. */
  testId?: string;
}

const GAP = 6;
const MARGIN = 8;

interface Placement {
  left: number;
  top: number;
  maxHeight: number;
}

/**
 * A menu that opens in front of everything.
 *
 * The panel is drawn through a portal into the page body and positioned from the button's place on screen, so no
 * ancestor can clip it or hide it behind the document, however the editor's panels scroll or overflow. It stays inside
 * the window (opening upwards when there is more room above), scrolls when it is taller than the room, closes on
 * Escape, on a press outside and when an item is chosen, and gives the focus back to its button.
 */
export function Menu({ label, trigger, children, align = "start", role = "menu", className, testId }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const returnFocus = useRef(true);

  const close = useCallback((restoreFocus = true) => {
    returnFocus.current = restoreFocus;
    setOpen(false);
  }, []);

  const place = useCallback(() => {
    const anchor = button.current;
    const box = panel.current;
    if (!anchor || !box) return;
    const rect = anchor.getBoundingClientRect();
    const width = box.offsetWidth;
    const natural = box.scrollHeight;
    const below = window.innerHeight - rect.bottom - GAP - MARGIN;
    const above = rect.top - GAP - MARGIN;
    const openUp = natural > below && above > below;
    const room = Math.max(120, openUp ? above : below);
    const height = Math.min(natural, room);
    const left = Math.max(MARGIN, Math.min(align === "end" ? rect.right - width : rect.left, window.innerWidth - width - MARGIN));
    const top = openUp ? rect.top - GAP - height : rect.bottom + GAP;
    setPlacement((previous) => (previous && previous.left === left && previous.top === top && previous.maxHeight === room ? previous : { left, top, maxHeight: room }));
  }, [align]);

  // Position before the first paint, and again whenever the window or the panel's content changes size.
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    place();
    const onChange = () => place();
    window.addEventListener("resize", onChange);
    window.addEventListener("scroll", onChange, true);
    const observer = typeof ResizeObserver === "undefined" || !panel.current ? null : new ResizeObserver(onChange);
    if (panel.current) observer?.observe(panel.current);
    return () => {
      window.removeEventListener("resize", onChange);
      window.removeEventListener("scroll", onChange, true);
      observer?.disconnect();
    };
  }, [open, place]);

  // Close on a press outside, and on Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panel.current?.contains(target) || button.current?.contains(target)) return;
      close(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, close]);

  // Move the focus in once the panel has its place (a hidden panel cannot take it): for a menu, to its chosen or first
  // item. When the menu has just closed the focus goes back to its button; a menu that was never opened leaves it alone.
  const wasOpen = useRef(false);
  const placed = placement !== null;
  useEffect(() => {
    if (open && placed) {
      wasOpen.current = true;
      const items = panel.current?.querySelectorAll<HTMLElement>("[role^='menuitem']:not(:disabled)");
      const checked = panel.current?.querySelector<HTMLElement>("[role^='menuitem'][aria-checked='true']");
      (checked ?? items?.[0] ?? panel.current)?.focus({ preventScroll: true });
    } else if (!open && wasOpen.current) {
      wasOpen.current = false;
      if (returnFocus.current) button.current?.focus({ preventScroll: true });
      returnFocus.current = true;
    }
  }, [open, placed]);

  const onPanelKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (role !== "menu") return;
    const items = Array.from(panel.current?.querySelectorAll<HTMLElement>("[role^='menuitem']:not(:disabled)") ?? []);
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (event.key === "ArrowDown") next = at < 0 ? 0 : (at + 1) % items.length;
    else if (event.key === "ArrowUp") next = at <= 0 ? items.length - 1 : at - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "Tab") {
      close(false);
      return;
    }
    if (next >= 0) {
      event.preventDefault();
      items[next]?.focus();
    }
  };

  const api: MenuApi = { close: () => close() };
  const triggerProps: MenuTriggerProps = {
    ref: button,
    onClick: () => setOpen((value) => !value),
    onKeyDown: (event) => {
      if (event.key === "ArrowDown" && !open) {
        event.preventDefault();
        setOpen(true);
      }
    },
    "aria-haspopup": role,
    "aria-expanded": open,
    "aria-controls": open ? id : undefined,
  };

  return (
    <>
      {trigger(triggerProps, open)}
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            className={`ed-popover${className ? ` ${className}` : ""}`}
            role={role}
            aria-label={label}
            tabIndex={-1}
            data-testid={testId}
            data-placed={placement ? "true" : "false"}
            style={{ left: placement?.left ?? 0, top: placement?.top ?? 0, maxHeight: placement?.maxHeight, visibility: placement ? "visible" : "hidden" }}
            onKeyDown={onPanelKey}
          >
            {typeof children === "function" ? children(api) : children}
          </div>,
          document.body,
        )}
    </>
  );
}
