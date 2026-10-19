import { useState } from "react";
import { Icon, type IconName } from "../../components/ui/Icon";
import type { Alignment } from "../model/geometry";
import type { EditorObject, Id } from "../model/types";
import { useStore } from "../state/context";
import { Choice, Section } from "./controls";

/**
 * Everything that arranges the selection: lining it up with the page or with each other, stacking order, drawing it
 * behind the page, grouping and merging into the page. It works the same for things the person added and for things the
 * page already had; what a particular object cannot do is greyed out, with the reason as the tooltip.
 */

interface ActionProps {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  testId?: string;
}

/** A button with an icon and a short label: easier to recognise than an icon alone. */
export function Action({ icon, label, onClick, disabled, title, testId }: ActionProps) {
  return (
    <button type="button" className="ed-action" disabled={disabled} title={title ?? label} aria-label={title ?? label} data-testid={testId} onClick={onClick}>
      <Icon name={icon} size={18} />
      <span>{label}</span>
    </button>
  );
}

const ALIGNMENTS: { how: Alignment; icon: IconName; label: string }[] = [
  { how: "left", icon: "align-left", label: "Left" },
  { how: "centre", icon: "align-center", label: "Centre" },
  { how: "right", icon: "align-right", label: "Right" },
  { how: "top", icon: "align-top", label: "Top" },
  { how: "middle", icon: "align-middle", label: "Middle" },
  { how: "bottom", icon: "align-bottom", label: "Bottom" },
];

export function AlignSection({ objects }: { objects: readonly EditorObject[] }) {
  const store = useStore();
  const [within, setWithin] = useState<"page" | "selection">("page");
  const ids = objects.map((o) => o.id);
  const several = objects.length > 1;
  const effective = several ? within : "page";
  const nothingMovable = objects.every((o) => o.locked);
  return (
    <Section title="Align" hint={several ? undefined : "Lines it up with the edges and middle of the page."}>
      {several && (
        <Choice
          label="Align to"
          value={within}
          onChange={setWithin}
          testId="align-to"
          options={[
            { value: "page", label: "The page", title: "The selection moves as one, keeping its shape", testId: "align-to-page" },
            { value: "selection", label: "Each other", title: "Lines the objects up with the box that holds them all", testId: "align-to-selection" },
          ]}
        />
      )}
      <div className="ed-actions ed-actions--3" role="toolbar" aria-label="Align">
        {ALIGNMENTS.map(({ how, icon, label }) => (
          <Action key={how} icon={icon} label={label} disabled={nothingMovable} title={effective === "page" ? `Align ${label.toLowerCase()} on the page` : `Align ${label.toLowerCase()}`} testId={`align-${how}`} onClick={() => store.alignObjects(ids, how, effective)} />
        ))}
      </div>
      <div className="ed-actions ed-actions--1">
        <Action icon="center" label="Centre on the page" title="Put it in the middle of the page, both ways" disabled={nothingMovable} testId="align-page-centre" onClick={() => store.centreOnPage(ids)} />
      </div>
      {objects.length >= 3 && (
        <div className="ed-actions ed-actions--2">
          <Action icon="distribute-h" label="Space across" title="Space the objects evenly from left to right" testId="distribute-x" onClick={() => store.distributeObjects(ids, "x")} />
          <Action icon="distribute-v" label="Space down" title="Space the objects evenly from top to bottom" testId="distribute-y" onClick={() => store.distributeObjects(ids, "y")} />
        </div>
      )}
    </Section>
  );
}

export function OrderSection({ objects }: { objects: readonly EditorObject[] }) {
  const store = useStore();
  const ids = objects.map((o) => o.id);
  const blocked = objects.filter((o) => o.kind === "existing" && !o.canReorder);
  const nothing = blocked.length === objects.length && objects.length > 0;
  const why = nothing ? (objects[0]?.kind === "existing" && objects[0].what === "text" ? "Text can be moved or removed, but not placed above or below other things." : ((objects[0] as { reason?: string | null }).reason ?? "Its place cannot be changed.")) : undefined;
  return (
    <Section title="Order" hint="Which object is on top when they overlap.">
      <div className="ed-actions ed-actions--2" role="toolbar" aria-label="Order">
        <Action icon="bring-front" label="To front" title={why ?? "Bring to front"} disabled={nothing} testId="z-front" onClick={() => store.reorder(ids, "front")} />
        <Action icon="forward" label="Forward" title={why ?? "Bring forward one step"} disabled={nothing} testId="z-forward" onClick={() => store.reorder(ids, "forward")} />
        <Action icon="backward" label="Backward" title={why ?? "Send backward one step"} disabled={nothing} testId="z-backward" onClick={() => store.reorder(ids, "backward")} />
        <Action icon="send-back" label="To back" title={why ?? "Send to back"} disabled={nothing} testId="z-back" onClick={() => store.reorder(ids, "back")} />
      </div>
    </Section>
  );
}

/** For things that were added: in front of the page, or behind its text and graphics (a background, a watermark). */
export function LayerSection({ objects }: { objects: readonly EditorObject[] }) {
  const store = useStore();
  const added = objects.filter((o) => o.kind !== "existing");
  if (added.length === 0) return null;
  const ids = added.map((o) => o.id);
  const behind = added.every((o) => o.behind);
  const mixed = !behind && added.some((o) => o.behind);
  return (
    <Section title="Layer" hint="Behind the page puts it under the page’s own text and graphics, like a letterhead or a watermark.">
      <Choice
        label="Draw"
        value={behind ? "behind" : "front"}
        onChange={(value) => store.setLayer(ids, value === "behind")}
        testId="layer"
        options={[
          { value: "front", label: mixed ? "In front (mixed)" : "In front", title: "On top of the page", testId: "layer-front" },
          { value: "behind", label: "Behind the page", title: "Under the page’s own content", testId: "layer-behind" },
        ]}
      />
    </Section>
  );
}

/** For one added picture: make it the page's background, or fit it to the page. */
export function PictureSection({ object }: { object: EditorObject }) {
  const store = useStore();
  if (object.kind !== "image") return null;
  return (
    <Section title="Picture" hint="Make it the background of the page: it fills the page without being stretched and sits behind the page’s own content.">
      <div className="ed-actions ed-actions--2">
        <Action icon="background" label="Use as background" testId="bg-set" onClick={() => store.setAsBackground(object.id)} />
        <Action icon="fit-page" label="Fit to page" title="Make it as large as the page allows, keeping its shape, and centre it" testId="fit-to-page" onClick={() => store.fitToPage(object.id)} />
      </div>
    </Section>
  );
}

export function GroupSection({ objects }: { objects: readonly EditorObject[] }) {
  const store = useStore();
  const added = objects.filter((o) => o.kind !== "existing");
  const ids = added.map((o) => o.id);
  const grouped = added.some((o) => o.group);
  if (added.length < 2 && !grouped) return null;
  return (
    <Section title="Group" hint="Objects in a group move, turn and are selected together.">
      <div className="ed-actions ed-actions--2">
        <Action icon="group" label="Group" disabled={added.length < 2} testId="group" onClick={() => store.group(ids)} />
        <Action icon="ungroup" label="Ungroup" disabled={!grouped} testId="ungroup" onClick={() => store.ungroup(ids)} />
      </div>
    </Section>
  );
}

/** Objects that can become part of the page itself. */
const MERGEABLE = new Set<EditorObject["kind"]>(["text", "image", "rect", "ellipse", "line", "draw", "cover"]);

export function MergeSection({ objects }: { objects: readonly EditorObject[] }) {
  const store = useStore();
  const mergeable = objects.filter((o) => MERGEABLE.has(o.kind));
  if (mergeable.length === 0) return null;
  return (
    <Section title="Merge" hint="Make the selection part of the page itself, so it no longer sits on top as a separate object. You can still select and move it afterwards as part of the page.">
      <div className="ed-actions ed-actions--1">
        <Action icon="layers" label="Merge into page" testId="merge-into-page" onClick={() => void store.mergeIntoPage(mergeable.map((o) => o.id))} />
      </div>
    </Section>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- shared helper kept next to the code that uses it
export function removable(objects: readonly EditorObject[]): Id[] {
  return objects.filter((o) => !(o.kind === "existing" && !o.canMove)).map((o) => o.id);
}
