import { type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MAX_ZOOM, MIN_ZOOM, clamp, slotSize } from "../model/geometry";
import { parseExistingId } from "../model/existing";
import type { EditorObject, Id, PageEntry } from "../model/types";
import { useSnapshot, useStore } from "../state/context";
import type { FindMatch } from "../state/store";
import { EMPTY_EDITS, PageSurface } from "./PageSurface";

const EMPTY_OBJECTS: readonly EditorObject[] = [];
const GAP = 18;
const PAD = 24;

/** The page's size once cropped and turned, which is the size it takes on screen at zoom 1. */
function shownSize(page: PageEntry): { width: number; height: number } {
  const crop = page.crop ?? { top: 0, right: 0, bottom: 0, left: 0 };
  return slotSize(Math.max(1, page.width - crop.left - crop.right), Math.max(1, page.height - crop.top - crop.bottom), 1, page.rotation);
}

/** Zoom that fits the current page (or the widest page) into the area. */
function fitFor(mode: "fit-page" | "fit-width", pages: readonly PageEntry[], current: PageEntry | undefined, area: { width: number; height: number }): number {
  if (area.width <= 0 || area.height <= 0) return 1;
  const sizes = (mode === "fit-width" ? pages : current ? [current] : pages).map(shownSize);
  const widest = Math.max(1, ...sizes.map((s) => s.width));
  const tallest = Math.max(1, ...sizes.map((s) => s.height));
  const width = (area.width - PAD * 2) / widest;
  const height = (area.height - PAD * 2) / tallest;
  return clamp(mode === "fit-width" ? width : Math.min(width, height), MIN_ZOOM, MAX_ZOOM);
}

/** The scrolling area: every page (or just the current one), zoom, panning and which page is in view. */
export function Viewport() {
  const store = useStore();
  const { doc, view } = useSnapshot();
  const area = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [near, setNear] = useState<ReadonlySet<Id>>(new Set());
  const [spaceHeld, setSpaceHeld] = useState(false);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const anchor = useRef<{ fx: number; fy: number; px: number; py: number } | null>(null);
  const slots = useRef(new Map<Id, HTMLElement>());

  const pages = doc.pages;
  const currentPage = pages.find((p) => p.id === view.currentPage) ?? pages[0];
  const shown = view.viewMode === "single" && currentPage ? [currentPage] : pages;

  // ---- size and zoom ------------------------------------------------------------------------------------------------------

  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  const fitted = useMemo(() => (view.zoomMode === "custom" ? null : fitFor(view.zoomMode, pages, currentPage, size)), [view.zoomMode, pages, currentPage, size]);
  useEffect(() => {
    if (fitted !== null && Math.abs(fitted - view.zoom) > 0.0005) store.setView({ zoom: fitted });
  }, [fitted, view.zoom, store]);
  const zoom = fitted ?? view.zoom;

  // Keep the point under the cursor still when the zoom changes with the wheel or a pinch.
  useLayoutEffect(() => {
    const element = area.current;
    const a = anchor.current;
    if (!element || !a) return;
    element.scrollLeft = a.fx * element.scrollWidth - a.px;
    element.scrollTop = a.fy * element.scrollHeight - a.py;
    anchor.current = null;
  }, [zoom]);

  const zoomAround = useCallback(
    (next: number, clientX: number, clientY: number) => {
      const element = area.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      anchor.current = { fx: (element.scrollLeft + px) / element.scrollWidth, fy: (element.scrollTop + py) / element.scrollHeight, px, py };
      store.setZoom(next);
    },
    [store],
  );

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoomAround(clamp(zoom * Math.exp(-event.deltaY * 0.002), MIN_ZOOM, MAX_ZOOM), event.clientX, event.clientY);
  };

  // React attaches wheel listeners as passive, so preventDefault above needs a real listener.
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const block = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    };
    element.addEventListener("wheel", block, { passive: false });
    return () => element.removeEventListener("wheel", block);
  }, []);

  // ---- which pages are near the screen -------------------------------------------------------------------------------------

  const shownKey = shown.map((p) => p.id).join(",");
  useEffect(() => {
    const element = area.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNear(new Set(shownKey === "" ? [] : shownKey.split(",")));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        setNear((previous) => {
          const next = new Set(previous);
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.pageId as Id;
            if (entry.isIntersecting) next.add(id);
            else next.delete(id);
          }
          return next.size === previous.size && [...next].every((id) => previous.has(id)) ? previous : next;
        });
      },
      { root: element, rootMargin: "900px 0px" },
    );
    for (const slot of slots.current.values()) observer.observe(slot);
    return () => observer.disconnect();
  }, [shownKey, zoom]);

  // The page most in view becomes the current one.
  const scrollTicking = useRef(false);
  const onScroll = () => {
    if (view.viewMode === "single" || scrollTicking.current) return;
    scrollTicking.current = true;
    requestAnimationFrame(() => {
      scrollTicking.current = false;
      const element = area.current;
      if (!element) return;
      const middle = element.getBoundingClientRect().top + element.clientHeight * 0.38;
      let best: Id | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const [id, slot] of slots.current) {
        if (!near.has(id)) continue;
        const rect = slot.getBoundingClientRect();
        const distance = rect.top <= middle && rect.bottom >= middle ? 0 : Math.min(Math.abs(rect.top - middle), Math.abs(rect.bottom - middle));
        if (distance < bestDistance) {
          bestDistance = distance;
          best = id;
        }
      }
      if (best && best !== store.state.view.currentPage) store.goToPage(best);
    });
  };

  // Moving to a page (from the thumbnails or the page box) scrolls to it.
  const scrolledTo = useRef<Id | null>(null);
  useEffect(() => {
    if (view.viewMode === "single" || !view.currentPage || scrolledTo.current === view.currentPage) return;
    const slot = slots.current.get(view.currentPage);
    const element = area.current;
    if (!slot || !element) return;
    // Only when the page is not already where the scroll left it.
    const top = slot.getBoundingClientRect().top - element.getBoundingClientRect().top;
    if (top < -4 || top > element.clientHeight * 0.6) element.scrollTop += top - PAD / 2;
    scrolledTo.current = view.currentPage;
  }, [view.currentPage, view.viewMode]);
  useEffect(() => {
    scrolledTo.current = null;
  }, [view.currentPage]);

  // ---- panning and pinching ---------------------------------------------------------------------------------------------------

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code === "Space" && !(event.target as HTMLElement).closest("input, textarea, select, [contenteditable='true'], button")) {
        event.preventDefault();
        setSpaceHeld(true);
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const panning = view.tool === "hand" || spaceHeld;
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = area.current;
    if (!element) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (event.pointerType === "touch" && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom };
      return;
    }
    if (panning || event.button === 1) {
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
      pan.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
    }
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = area.current;
    if (!element) return;
    if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAround(clamp(pinch.current.zoom * (distance / Math.max(1, pinch.current.distance)), MIN_ZOOM, MAX_ZOOM), (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    if (pan.current) {
      element.scrollLeft = pan.current.left - (event.clientX - pan.current.x);
      element.scrollTop = pan.current.top - (event.clientY - pan.current.y);
    }
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    pan.current = null;
  };

  // ---- the pages ---------------------------------------------------------------------------------------------------------------

  const selectionByPage = useMemo(() => {
    const map = new Map<Id, Id[]>();
    for (const page of pages) {
      const list = doc.objects[page.id] ?? EMPTY_OBJECTS;
      const chosen = view.selection.filter((id) => list.some((o) => o.id === id) || parseExistingId(id)?.page === page.id);
      if (chosen.length > 0) map.set(page.id, chosen);
    }
    return map;
  }, [pages, doc.objects, view.selection]);
  const findByPage = useMemo(() => {
    const map = new Map<Id, FindMatch[]>();
    for (const match of view.find?.matches ?? []) map.set(match.page, [...(map.get(match.page) ?? []), match]);
    return map;
  }, [view.find?.matches]);
  const currentMatch = view.find && view.find.current >= 0 ? (view.find.matches[view.find.current] ?? null) : null;
  const stableSelection = useRef(new Map<Id, Id[]>());
  const selectionFor = (id: Id): Id[] => {
    const next = selectionByPage.get(id) ?? NO_IDS;
    const previous = stableSelection.current.get(id);
    if (previous && previous.length === next.length && previous.every((v, i) => v === next[i])) return previous;
    stableSelection.current.set(id, next as Id[]);
    return next as Id[];
  };

  return (
    <div
      ref={area}
      className={`ed-viewport${panning ? " ed-viewport--pan" : ""}`}
      data-testid="viewport"
      tabIndex={-1}
      onScroll={onScroll}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{ cursor: pan.current ? "grabbing" : panning ? "grab" : undefined, touchAction: "pan-x pan-y" }}
    >
      <div className="ed-pages" style={{ gap: GAP, padding: PAD }}>
        {shown.map((page) => {
          const number = pages.indexOf(page) + 1;
          return (
            <div
              key={page.id}
              className="ed-row"
              data-page-id={page.id}
              ref={(element) => {
                if (element) slots.current.set(page.id, element);
                else slots.current.delete(page.id);
              }}
            >
              <PageSurface
                page={page}
                number={number}
                zoom={zoom}
                active={view.viewMode === "single" || near.has(page.id)}
                tool={view.tool}
                objects={doc.objects[page.id] ?? EMPTY_OBJECTS}
                edits={doc.textEdits[page.id] ?? EMPTY_EDITS}
                existingEdits={doc.existing[page.id]}
                selection={selectionFor(page.id)}
                lineId={view.line?.page === page.id ? view.line.lineId : null}
                lineEditing={view.lineEditing}
                editing={view.editing && (doc.objects[page.id] ?? EMPTY_OBJECTS).some((o) => o.id === view.editing?.id) ? view.editing : null}
                snap={view.snap}
                matches={findByPage.get(page.id) ?? NO_MATCHES}
                currentMatch={currentMatch}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

const NO_IDS: readonly Id[] = [];
const NO_MATCHES: readonly FindMatch[] = [];
