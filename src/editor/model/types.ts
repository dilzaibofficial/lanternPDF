import type { LineStyle, FitMode } from "../../lib/pdf/engine/textEdit";
import type { PageSize } from "../../lib/pdf/engine/session";

/**
 * The editor's document model: plain, immutable data. Positions are **display points**: origin at the top-left
 * corner of the page as it is first shown, y pointing down, one unit = one PDF point. The model never holds
 * anything the screen needs (zoom, scroll, pixels); those belong to the view.
 */

export type Id = string;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Pt {
  x: number;
  y: number;
}

export type Rotation = 0 | 90 | 180 | 270;

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

// ---- objects ---------------------------------------------------------------------------------------------------

interface ObjectBase {
  id: Id;
  /** The page this object is on. */
  page: Id;
  /** Degrees clockwise about the centre of its box. */
  rotation: number;
  /** 0 to 1. */
  opacity: number;
  /** A locked object cannot be moved or resized with the pointer. */
  locked?: boolean;
  /** Drawn behind everything the page itself draws (a background or a watermark), not on top of it. */
  behind?: boolean;
  /** Objects with the same group move, turn and are selected together. */
  group?: Id;
}

export type FontFamilyChoice = "sans" | "serif" | "mono";

export interface Border {
  color: string | null;
  width: number;
  style: "solid" | "dashed";
}

export interface TextBoxObject extends ObjectBase, Box {
  kind: "text";
  text: string;
  family: FontFamilyChoice;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  size: number;
  color: string;
  align: "left" | "center" | "right";
  /** Multiple of the font size. */
  lineHeight: number;
  /** Extra space between characters, in points. */
  letterSpacing: number;
  /** Background; null for none. */
  fill: string | null;
  border: Border;
  padding: number;
  radius: number;
  /** When true the height follows the text. */
  autoHeight: boolean;
}

export interface ImageObject extends ObjectBase, Box {
  kind: "image";
  image: { name: string; mime: string; bytes: Uint8Array; width: number; height: number };
  /** Fractions (0 to 1) of the picture cut away from each side. */
  crop: Margins | null;
  flipX: boolean;
  flipY: boolean;
  border: Border;
}

export interface ShapeObject extends ObjectBase, Box {
  kind: "rect" | "ellipse";
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  strokeStyle: "solid" | "dashed";
  radius: number;
}

export interface LineObject extends ObjectBase {
  kind: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  strokeWidth: number;
  strokeStyle: "solid" | "dashed";
  arrow: "none" | "end" | "both";
}

export interface DrawObject extends ObjectBase {
  kind: "draw";
  points: [number, number][];
  color: string;
  strokeWidth: number;
}

/** Highlight, underline, strikeout and squiggly lines over text: written to the file as real markup annotations. */
export interface MarkupObject extends ObjectBase {
  kind: "highlight" | "underline" | "strikeout" | "squiggly";
  /** One rectangle per line of text covered. */
  quads: Box[];
  color: string;
}

/** A sticky note. */
export interface CommentObject extends ObjectBase {
  kind: "comment";
  x: number;
  y: number;
  text: string;
  author: string;
}

/** A box that hides what is behind it from view. The content stays in the file: this is not redaction. */
export interface CoverObject extends ObjectBase, Box {
  kind: "cover";
  color: string;
}

/** An area to be redacted: the text, image pixels and annotations under it are removed when the file is saved. */
export interface RedactObject extends ObjectBase, Box {
  kind: "redact";
  /** Colour of the box left in its place. */
  color: string;
  /** Text drawn in the box (such as “REDACTED”), or empty. */
  label: string;
}

export interface FormFieldObject extends ObjectBase, Box {
  kind: "field";
  fieldType: "text" | "checkbox" | "radio" | "dropdown" | "signature";
  name: string;
  /** Shown next to the field in the editor and used as the tooltip. */
  label: string;
  required: boolean;
  readOnly: boolean;
  multiline: boolean;
  /** Choices of a dropdown, or the value of a radio button. */
  options: string[];
  /** Radio buttons with the same group form one choice. */
  group: string;
  defaultValue: string;
  fontSize: number;
  border: Border;
  fill: string | null;
}

export interface OrientedPlacement extends Box {
  /** Degrees clockwise about the centre of the box. */
  rotation: number;
}

/** A shape's real outline in base space, so that a click is tested against the shape and not its bounding box. */
export interface Outline {
  points: [number, number][];
  closed: boolean;
}

/**
 * Something the page already draws: an image, a shape (a triangle, a rectangle, a line…), an annotation, or a block of
 * text. It is not stored in the document (the file holds it); the editor builds this from the analysis of the page so
 * that it can be selected, moved, resized, turned, put above or below others, and removed like anything added.
 */
export interface ExistingObject extends ObjectBase, Box {
  kind: "existing";
  what: "image" | "shape" | "text" | "annotation";
  /** Key of its edit in `DocState.existing`. */
  key: string;
  /** What to call it: "Image", "Triangle", "Text block"… */
  label: string;
  /** Position in the page's own stacking order: higher is on top. */
  order: number;
  /** Where it is in the file. */
  origin: OrientedPlacement;
  outline: Outline[] | null;
  filled: boolean;
  stroked: boolean;
  /** For a block of text: the boxes of its lines, for hit-testing and for moving them one by one. */
  lines: { id: string; box: Box }[] | null;
  canMove: boolean;
  canResize: boolean;
  canRotate: boolean;
  canReorder: boolean;
  /** Why it cannot be changed, if it cannot. */
  reason: string | null;
  /** The editor has changed it (moved, resized, turned or reordered). */
  edited: boolean;
  pixelWidth: number | null;
  pixelHeight: number | null;
  contents: string | null;
}

export type EditorObject =
  | ExistingObject
  | TextBoxObject
  | ImageObject
  | ShapeObject
  | LineObject
  | DrawObject
  | MarkupObject
  | CommentObject
  | CoverObject
  | RedactObject
  | FormFieldObject;

export type ObjectKind = EditorObject["kind"];

// ---- pages and the document -----------------------------------------------------------------------------------------

export interface PageEntry {
  id: Id;
  /** The source document, or null for a blank page. */
  source: Id | null;
  /** 0-based page of that source. */
  index: number;
  /** The page's size as first displayed (before any rotation the editor adds). */
  width: number;
  height: number;
  /** Quarter turns the editor has added, clockwise. */
  rotation: Rotation;
  /** Margins cut away on export (and hidden in the view), in the page's own orientation. */
  crop: Margins | null;
}

export interface SourceDoc {
  id: Id;
  name: string;
  pageCount: number;
  sizes: PageSize[];
  signed: boolean;
}

export interface TextEditRecord {
  lineId: string;
  text: string;
  style?: LineStyle;
  fit?: FitMode;
}

/** Where an existing object goes in the stacking order of the page. */
export type OrderTarget = "front" | "back" | { after: string } | { before: string };

/** What the editor has changed about one thing the page already draws. */
export interface ExistingEdit {
  /** Remove it. */
  deleted?: boolean;
  /** Where it should be now (base space); absent when it stays where it is. */
  place?: OrientedPlacement;
  /** Its new place in the stacking order. */
  order?: OrderTarget;
}

export interface DocState {
  sources: Record<Id, SourceDoc>;
  pages: PageEntry[];
  /** Objects by page id, bottom first. */
  objects: Record<Id, EditorObject[]>;
  /** Edits of existing text: page id → line id → edit. */
  textEdits: Record<Id, Record<string, TextEditRecord>>;
  /** Changes to what the page already draws: page id → object key → edit. */
  existing: Record<Id, Record<string, ExistingEdit>>;
}

export const EMPTY_DOC: DocState = { sources: {}, pages: [], objects: {}, textEdits: {}, existing: {} };

// ---- tools ----------------------------------------------------------------------------------------------------

export type ToolId =
  | "select"
  | "edit-text"
  | "text"
  | "image"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "draw"
  | "highlight"
  | "underline"
  | "strikeout"
  | "squiggly"
  | "comment"
  | "cover"
  | "redact"
  | "field-text"
  | "field-checkbox"
  | "field-radio"
  | "field-dropdown"
  | "field-signature"
  | "hand";
