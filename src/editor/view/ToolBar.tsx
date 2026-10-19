import { useRef, useState } from "react";
import { Icon, type IconName } from "../../components/ui/Icon";
import { makeImage } from "../model/defaults";
import type { ToolId } from "../model/types";
import { useSnapshot, useStore } from "../state/context";
import { Menu } from "./Menu";
import { readImage } from "./Properties";

export interface ToolEntry {
  id: ToolId | "image";
  /** Full name, for the tooltip and screen readers. */
  label: string;
  /** What is written under the icon. */
  short: string;
  icon: IconName;
  /** Keyboard shortcut (empty for none). */
  key: string;
  /** One line that says what to do with the tool, shown while it is in use. */
  hint: string;
}

// eslint-disable-next-line react-refresh/only-export-components -- shared helper kept next to the code that uses it
export const TOOLS: readonly ToolEntry[] = [
  { id: "select", label: "Select and move", short: "Select", icon: "cursor", key: "v", hint: "Click anything on the page to select it: text, pictures, shapes. Drag to move it, use the handles to resize it, press Delete to remove it. Double-click text to change its words." },
  { id: "hand", label: "Pan the page (or hold Space)", short: "Pan", icon: "hand", key: "g", hint: "Drag the page to move around it." },
  { id: "edit-text", label: "Edit existing text", short: "Edit text", icon: "edit-text", key: "e", hint: "Click a line of text on the page, then type to change it. It is rewritten inside the page." },
  { id: "text", label: "Add a text box", short: "Add text", icon: "type", key: "t", hint: "Click on the page to add a text box, or drag to give it a size." },
  { id: "image", label: "Add an image", short: "Add image", icon: "image", key: "i", hint: "Choose a picture to place on the page." },
  { id: "rect", label: "Rectangle", short: "Rectangle", icon: "square", key: "r", hint: "Drag on the page to draw a rectangle. Hold Shift for a square." },
  { id: "ellipse", label: "Ellipse", short: "Ellipse", icon: "circle", key: "o", hint: "Drag on the page to draw an ellipse. Hold Shift for a circle." },
  { id: "line", label: "Line", short: "Line", icon: "line", key: "l", hint: "Drag from where the line starts to where it ends. Hold Shift for straight angles." },
  { id: "arrow", label: "Arrow", short: "Arrow", icon: "arrow-right", key: "a", hint: "Drag from the tail of the arrow to its point." },
  { id: "draw", label: "Pen", short: "Draw", icon: "draw", key: "p", hint: "Draw freely on the page." },
  { id: "highlight", label: "Highlight text", short: "Highlight", icon: "highlighter", key: "h", hint: "Drag across text to highlight it." },
  { id: "underline", label: "Underline text", short: "Underline", icon: "underline", key: "u", hint: "Drag across text to underline it." },
  { id: "strikeout", label: "Strike out text", short: "Strikeout", icon: "strikeout", key: "s", hint: "Drag across text to strike it out." },
  { id: "squiggly", label: "Squiggly underline", short: "Squiggly", icon: "squiggly", key: "q", hint: "Drag across text to underline it with a wavy line." },
  { id: "comment", label: "Add a note", short: "Note", icon: "note", key: "n", hint: "Click where the note should go, then type it." },
  { id: "cover", label: "Cover with a box (hides, does not remove)", short: "Whiteout", icon: "eraser", key: "c", hint: "Drag over what you want to hide. The hidden content stays in the file: use Redact to remove it for good." },
  { id: "redact", label: "Redact (removes the content for good)", short: "Redact", icon: "redact", key: "x", hint: "Drag over what you want to remove. When you download, the text, pictures and notes under it are taken out of the file." },
  { id: "field-text", label: "Text field", short: "Text field", icon: "textfield", key: "f", hint: "Drag on the page to place a text field people can fill in." },
  { id: "field-checkbox", label: "Checkbox", short: "Checkbox", icon: "checkbox", key: "", hint: "Click on the page to place a checkbox." },
  { id: "field-radio", label: "Radio button", short: "Radio button", icon: "radio", key: "", hint: "Click on the page to place a radio button. Buttons with the same group name allow one choice." },
  { id: "field-dropdown", label: "Drop-down list", short: "Drop-down", icon: "dropdown", key: "", hint: "Drag on the page to place a drop-down list." },
  { id: "field-signature", label: "Signature field", short: "Signature", icon: "signature", key: "", hint: "Drag on the page to place a field for a signature. (It marks the place; it is not a digital signature.)" },
];

const byId = (id: ToolEntry["id"]): ToolEntry => TOOLS.find((tool) => tool.id === id) as ToolEntry;

type BarItem = { type: "tool"; id: ToolEntry["id"] } | { type: "menu"; id: string; label: string; members: ToolEntry["id"][] } | { type: "gap" };

const BAR: readonly BarItem[] = [
  { type: "tool", id: "select" },
  { type: "tool", id: "hand" },
  { type: "gap" },
  { type: "tool", id: "edit-text" },
  { type: "tool", id: "text" },
  { type: "tool", id: "image" },
  { type: "gap" },
  { type: "menu", id: "shapes", label: "Shapes", members: ["rect", "ellipse", "line", "arrow"] },
  { type: "tool", id: "draw" },
  { type: "gap" },
  { type: "menu", id: "markup", label: "Markup", members: ["highlight", "underline", "strikeout", "squiggly"] },
  { type: "tool", id: "comment" },
  { type: "gap" },
  { type: "tool", id: "cover" },
  { type: "tool", id: "redact" },
  { type: "gap" },
  { type: "menu", id: "forms", label: "Form fields", members: ["field-text", "field-checkbox", "field-radio", "field-dropdown", "field-signature"] },
];

/**
 * The tools along the top, each with its name under it. Related tools (the shapes, the ways to mark up text, the kinds of
 * form field) share one button that opens a list. Under the tools, one line says what the chosen tool does.
 */
export function ToolBar() {
  const store = useStore();
  const { view, doc } = useSnapshot();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<Record<string, ToolEntry["id"]>>({});

  const addImage = async (files: FileList | null) => {
    const file = files?.[0];
    if (input.current) input.current.value = "";
    if (!file) return;
    const page = doc.pages.find((p) => p.id === view.currentPage) ?? doc.pages[0];
    if (!page) return;
    setBusy(true);
    try {
      const image = await readImage(file, store.notify.bind(store));
      if (!image) return;
      store.addObjects("Add image", [makeImage(page.id, image, page)]);
      store.setTool("select");
    } finally {
      setBusy(false);
    }
  };

  const choose = (id: ToolEntry["id"]) => {
    if (id === "image") input.current?.click();
    else store.setTool(id);
  };

  const hint = byId(view.tool).hint;

  return (
    <div className="ed-toolbar" data-testid="toolbar">
      <div className="ed-toolbar__tools" role="toolbar" aria-label="Tools" data-testid="toolrail">
        {BAR.map((item, index) => {
          if (item.type === "gap") return <span key={`gap-${index}`} className="ed-toolbar__gap" aria-hidden="true" />;
          if (item.type === "tool") {
            const tool = byId(item.id);
            const pressed = tool.id !== "image" && view.tool === tool.id;
            return (
              <button
                key={tool.id}
                type="button"
                className={`ed-tool${pressed ? " ed-tool--on" : ""}`}
                aria-pressed={tool.id === "image" ? undefined : pressed}
                aria-label={tool.label}
                title={tool.key ? `${tool.label} (${tool.key.toUpperCase()})` : tool.label}
                data-testid={`tool-${tool.id}`}
                disabled={tool.id === "image" && busy}
                onClick={() => choose(tool.id)}
              >
                <Icon name={tool.icon} size={20} />
                <span>{tool.short}</span>
              </button>
            );
          }
          const active = item.members.find((id) => id === view.tool);
          const shown = byId(active ?? recent[item.id] ?? (item.members[0] as ToolEntry["id"]));
          return (
            <Menu
              key={item.id}
              label={item.label}
              testId={`tool-menu-${item.id}`}
              trigger={(props, open) => (
                <button type="button" className={`ed-tool ed-tool--menu${active ? " ed-tool--on" : ""}${open ? " ed-tool--open" : ""}`} aria-label={`${item.label}: ${shown.label}`} title={item.label} data-testid={`tool-group-${item.id}`} {...props}>
                  <Icon name={shown.icon} size={20} />
                  <span>
                    {active ? shown.short : item.label}
                    <Icon name="chevron-down" size={12} />
                  </span>
                </button>
              )}
            >
              {({ close }) =>
                item.members.map((id) => {
                  const tool = byId(id);
                  return (
                    <button
                      key={tool.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={view.tool === tool.id}
                      className="ed-popover__item"
                      data-testid={`tool-${tool.id}`}
                      onClick={() => {
                        setRecent((previous) => ({ ...previous, [item.id]: tool.id }));
                        choose(tool.id);
                        close();
                      }}
                    >
                      <Icon name={tool.icon} size={18} />
                      <span className="ed-popover__grow">{tool.label}</span>
                      {tool.key && <kbd className="ed-popover__key">{tool.key.toUpperCase()}</kbd>}
                    </button>
                  );
                })
              }
            </Menu>
          );
        })}
      </div>
      <p className="ed-toolbar__hint" role="status" data-testid="tool-hint">
        {hint}
      </p>
      <input ref={input} type="file" hidden accept=".png,.jpg,.jpeg,.webp,.gif,.bmp" data-testid="image-input" onChange={(event) => void addImage(event.target.files)} />
    </div>
  );
}
