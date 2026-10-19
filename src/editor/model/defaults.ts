import { newId } from "./ops";
import type { Box, CommentObject, CoverObject, DrawObject, EditorObject, FormFieldObject, Id, ImageObject, LineObject, MarkupObject, Pt, RedactObject, ShapeObject, TextBoxObject, ToolId } from "./types";

/** The look of the next object of each kind. Changing it in the properties panel (with nothing selected) changes it for new ones. */
export interface ToolDefaults {
  text: Pick<TextBoxObject, "family" | "bold" | "italic" | "underline" | "size" | "color" | "align" | "lineHeight" | "letterSpacing" | "fill" | "border" | "padding" | "radius" | "opacity">;
  shape: Pick<ShapeObject, "fill" | "stroke" | "strokeWidth" | "strokeStyle" | "radius" | "opacity">;
  line: Pick<LineObject, "color" | "strokeWidth" | "strokeStyle" | "opacity">;
  draw: Pick<DrawObject, "color" | "strokeWidth" | "opacity">;
  highlight: { color: string; opacity: number };
  underline: { color: string; opacity: number };
  strikeout: { color: string; opacity: number };
  cover: { color: string };
  redact: { color: string; label: string };
  author: string;
}

export const DEFAULT_TOOL_DEFAULTS: ToolDefaults = {
  text: { family: "sans", bold: false, italic: false, underline: false, size: 16, color: "#111827", align: "left", lineHeight: 1.25, letterSpacing: 0, fill: null, border: { color: null, width: 1, style: "solid" }, padding: 2, radius: 0, opacity: 1 },
  shape: { fill: null, stroke: "#dc2626", strokeWidth: 2, strokeStyle: "solid", radius: 0, opacity: 1 },
  line: { color: "#dc2626", strokeWidth: 2, strokeStyle: "solid", opacity: 1 },
  draw: { color: "#2563eb", strokeWidth: 3, opacity: 1 },
  highlight: { color: "#fde047", opacity: 0.45 },
  underline: { color: "#dc2626", opacity: 1 },
  strikeout: { color: "#dc2626", opacity: 1 },
  cover: { color: "#ffffff" },
  redact: { color: "#000000", label: "" },
  author: "",
};

export const PALETTE = ["#111827", "#dc2626", "#ea580c", "#facc15", "#16a34a", "#0891b2", "#2563eb", "#7c3aed", "#db2777", "#ffffff"] as const;

const base = (page: Id) => ({ id: newId(), page, rotation: 0, opacity: 1 });

export function makeTextBox(page: Id, at: Pt, defaults: ToolDefaults, box?: Partial<Box>): TextBoxObject {
  const d = defaults.text;
  const width = box?.width ?? 200;
  return { ...base(page), ...d, kind: "text", text: "", x: box?.x ?? at.x, y: box?.y ?? at.y, width, height: box?.height ?? d.size * d.lineHeight + d.padding * 2, autoHeight: box?.height === undefined };
}

export function makeShape(page: Id, kind: "rect" | "ellipse", box: Box, defaults: ToolDefaults): ShapeObject {
  return { ...base(page), ...defaults.shape, kind, ...box };
}

export function makeLine(page: Id, from: Pt, to: Pt, arrow: boolean, defaults: ToolDefaults): LineObject {
  return { ...base(page), ...defaults.line, kind: "line", x1: from.x, y1: from.y, x2: to.x, y2: to.y, arrow: arrow ? "end" : "none" };
}

export function makeDraw(page: Id, points: [number, number][], defaults: ToolDefaults): DrawObject {
  return { ...base(page), ...defaults.draw, kind: "draw", points };
}

export function makeMarkup(page: Id, kind: MarkupObject["kind"], quads: Box[], defaults: ToolDefaults): MarkupObject {
  const d = kind === "highlight" ? defaults.highlight : kind === "underline" ? defaults.underline : defaults.strikeout;
  return { ...base(page), kind, quads, color: d.color, opacity: d.opacity };
}

export function makeComment(page: Id, at: Pt, defaults: ToolDefaults): CommentObject {
  return { ...base(page), kind: "comment", x: at.x, y: at.y, text: "", author: defaults.author };
}

export function makeCover(page: Id, box: Box, defaults: ToolDefaults): CoverObject {
  return { ...base(page), kind: "cover", ...box, color: defaults.cover.color };
}

export function makeRedaction(page: Id, box: Box, defaults: ToolDefaults): RedactObject {
  return { ...base(page), kind: "redact", ...box, color: defaults.redact.color, label: defaults.redact.label };
}

export function makeImage(page: Id, image: ImageObject["image"], page_: { width: number; height: number }): ImageObject {
  const width = Math.min(page_.width * 0.4, image.width || page_.width * 0.4);
  const height = (width * (image.height || 1)) / Math.max(1, image.width || 1);
  return { ...base(page), kind: "image", image, x: (page_.width - width) / 2, y: (page_.height - height) / 2, width, height, crop: null, flipX: false, flipY: false, border: { color: null, width: 1, style: "solid" } };
}

export function makeField(page: Id, fieldType: FormFieldObject["fieldType"], box: Box, name: string): FormFieldObject {
  return {
    ...base(page),
    kind: "field",
    fieldType,
    name,
    label: "",
    required: false,
    readOnly: false,
    multiline: false,
    options: fieldType === "dropdown" ? ["Option 1", "Option 2"] : [],
    group: fieldType === "radio" ? "Group1" : "",
    defaultValue: "",
    fontSize: 12,
    border: { color: "#475569", width: 1, style: "solid" },
    fill: "#eef2ff",
    ...box,
  };
}

/** Default size of an object created with a click instead of a drag. */
export const CLICK_SIZES: Partial<Record<ToolId, { width: number; height: number }>> = {
  rect: { width: 140, height: 90 },
  ellipse: { width: 140, height: 90 },
  cover: { width: 160, height: 28 },
  redact: { width: 160, height: 28 },
  "field-text": { width: 180, height: 26 },
  "field-checkbox": { width: 18, height: 18 },
  "field-radio": { width: 18, height: 18 },
  "field-dropdown": { width: 180, height: 26 },
  "field-signature": { width: 200, height: 56 },
  text: { width: 200, height: 24 },
};

export type { EditorObject };
