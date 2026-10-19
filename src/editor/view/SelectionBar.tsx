import { Icon } from "../../components/ui/Icon";
import { baseToSlot, boundsOf, corners, slotSize } from "../model/geometry";
import type { EditorObject, PageEntry } from "../model/types";
import { useStore } from "../state/context";

interface SelectionBarProps {
  page: PageEntry;
  zoom: number;
  /** The selected objects on this page. */
  selected: readonly EditorObject[];
}

/**
 * A small bar next to the selection with the things most often done to it: change its text, put it forward or back, copy
 * it, delete it. It sits above the selection (below it when there is no room) and follows it as the page is zoomed.
 */
export function SelectionBar({ page, zoom, selected }: SelectionBarProps) {
  const store = useStore();
  if (selected.length === 0) return null;
  const crop = page.crop ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const cw = Math.max(1, page.width - crop.left - crop.right);
  const ch = Math.max(1, page.height - crop.top - crop.bottom);
  const slot = slotSize(cw, ch, zoom, page.rotation);

  // Where the selection is on the screen: its four corners go through the page's turn and the zoom.
  const points = selected.flatMap((object) => {
    const box = boundsOf(object);
    return corners(box, 0).map((p) => baseToSlot({ x: p.x - crop.left, y: p.y - crop.top }, cw, ch, zoom, page.rotation));
  });
  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));
  const half = 84;
  const x = Math.min(slot.width - half, Math.max(half, (minX + maxX) / 2));
  const above = minY - 68; // clear of the turning knob, which sits about 22 pixels above the frame
  const y = above >= 4 ? above : Math.min(slot.height - 44, maxY + 10);

  const ids = selected.map((o) => o.id);
  const only = selected.length === 1 ? (selected[0] as EditorObject) : null;
  const editable = only?.kind === "existing" && only.what === "text" ? only : null;
  const firstLine = editable?.lines?.[0] ?? null;
  const added = selected.filter((o) => o.kind !== "existing");
  const reorderable = selected.some((o) => o.kind !== "existing" || o.canReorder);
  const removable = selected.some((o) => !(o.kind === "existing" && !o.canMove));

  return (
    <div className="ed-selbar" style={{ left: x, top: y }} role="toolbar" aria-label="Selection" data-testid="selection-bar">
      {editable && firstLine && (
        <button type="button" className="ed-iconbtn" aria-label="Edit the text" title="Edit the text" data-testid="sel-edit" onClick={() => store.selectLine({ page: editable.page, lineId: firstLine.id })}>
          <Icon name="edit-text" size={18} />
        </button>
      )}
      {reorderable && (
        <>
          <button type="button" className="ed-iconbtn" aria-label="Bring forward" title="Bring forward" data-testid="sel-forward" onClick={() => store.reorder(ids, "forward")}>
            <Icon name="forward" size={18} />
          </button>
          <button type="button" className="ed-iconbtn" aria-label="Send backward" title="Send backward" data-testid="sel-backward" onClick={() => store.reorder(ids, "backward")}>
            <Icon name="backward" size={18} />
          </button>
        </>
      )}
      {added.length > 0 && (
        <button type="button" className="ed-iconbtn" aria-label="Duplicate" title="Duplicate (Ctrl+D)" data-testid="sel-duplicate" onClick={() => store.duplicate(added.map((o) => o.id))}>
          <Icon name="copy" size={18} />
        </button>
      )}
      <button type="button" className="ed-iconbtn" aria-label="Delete" title="Delete (Del)" disabled={!removable} data-testid="sel-delete" onClick={() => store.removeObjects(ids)}>
        <Icon name="trash" size={18} />
      </button>
    </div>
  );
}
