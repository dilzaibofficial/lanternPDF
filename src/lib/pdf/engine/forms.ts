import {
  PDFArray,
  PDFBool,
  PDFDict,
  type PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFObject,
  type PDFPage,
  PDFString,
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  degrees,
  rgb,
} from "@cantoo/pdf-lib";
import { AppError } from "../../errors";
import type { FormFieldObject } from "../../../editor/model/types";
import { type PageFrame, parseColor } from "../draw";
import { resolveFont } from "../fonts";
import { type DisplayBox, boxToDisplay, userRectOf } from "./space";

/**
 * Forms: reading the fields a page already has, filling them in, and creating new ones.
 *
 * Fields are found through the page's widget annotations and their field dictionaries (names, types, flags and values are
 * inherited down the field tree, which is walked here). Filling and creating go through pdf-lib's form API, which writes
 * the appearance of each field. A signature field made here marks the place for a signature; it is not a digital
 * signature and nothing here signs anything.
 */

export type FieldKind = "text" | "checkbox" | "radio" | "dropdown" | "list" | "button" | "signature";

export interface FieldChoice {
  value: string;
  label: string;
}

export type FormValue = string | boolean | string[];

export interface AnalyzedField {
  /** `field:<index in the page's /Annots>`: stable for a page. */
  id: string;
  /** The field's full name (the names of its parents, joined with dots). */
  name: string;
  kind: FieldKind;
  /** Where its widget is, in display space. */
  box: DisplayBox;
  /** The value it has in the file. Text and choice: the text (or list of chosen values); check box: on or off; radio group: the chosen export value or null. */
  value: FormValue | null;
  /** For a check box or one button of a radio group: the value this widget stands for when it is on. */
  onValue: string | null;
  choices: FieldChoice[];
  multiline: boolean;
  password: boolean;
  readOnly: boolean;
  required: boolean;
  maxLength: number | null;
  /** Size of the type in points (0 means the viewer picks one). */
  fontSize: number;
  tooltip: string | null;
}

// ---- reading ------------------------------------------------------------------------------------------------------------

const N = {
  Annots: PDFName.of("Annots"),
  Subtype: PDFName.of("Subtype"),
  Widget: PDFName.of("Widget"),
  Rect: PDFName.of("Rect"),
  Parent: PDFName.of("Parent"),
  Kids: PDFName.of("Kids"),
  T: PDFName.of("T"),
  TU: PDFName.of("TU"),
  FT: PDFName.of("FT"),
  Ff: PDFName.of("Ff"),
  V: PDFName.of("V"),
  Opt: PDFName.of("Opt"),
  MaxLen: PDFName.of("MaxLen"),
  DA: PDFName.of("DA"),
  AP: PDFName.of("AP"),
  Nrm: PDFName.of("N"),
  F: PDFName.of("F"),
  AcroForm: PDFName.of("AcroForm"),
  Fields: PDFName.of("Fields"),
  NeedAppearances: PDFName.of("NeedAppearances"),
};

const FLAG = { readOnly: 1, required: 2, multiline: 1 << 12, password: 1 << 13, radio: 1 << 15, pushButton: 1 << 16, combo: 1 << 17 };
const HIDDEN = 2;
const NO_VIEW = 32;

function inherited(dict: PDFDict, key: PDFName): PDFObject | undefined {
  let current: PDFDict | undefined = dict;
  for (let i = 0; i < 32 && current; i += 1) {
    const value: PDFObject | undefined = current.lookup(key);
    if (value !== undefined) return value;
    current = current.lookupMaybe(N.Parent, PDFDict);
  }
  return undefined;
}

const textOf = (value: PDFObject | undefined): string | null => (value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : value instanceof PDFName ? value.decodeText() : null);
const numberOf = (value: PDFObject | undefined): number | null => (value instanceof PDFNumber ? value.asNumber() : null);

export function fieldName(dict: PDFDict): string {
  const parts: string[] = [];
  let current: PDFDict | undefined = dict;
  for (let i = 0; i < 32 && current; i += 1) {
    const part = textOf(current.lookup(N.T));
    if (part) parts.unshift(part);
    current = current.lookupMaybe(N.Parent, PDFDict);
  }
  return parts.join(".");
}

function choicesOf(dict: PDFDict): FieldChoice[] {
  const options = inherited(dict, N.Opt);
  if (!(options instanceof PDFArray)) return [];
  const out: FieldChoice[] = [];
  for (let i = 0; i < options.size(); i += 1) {
    const entry = options.lookup(i);
    if (entry instanceof PDFArray) {
      const value = textOf(entry.lookup(0));
      const label = textOf(entry.lookup(1)) ?? value;
      if (value !== null) out.push({ value, label: label ?? value });
    } else {
      const text = textOf(entry);
      if (text !== null) out.push({ value: text, label: text });
    }
  }
  return out;
}

/** The names under which a widget draws its "on" state (anything but Off). */
function onStates(widget: PDFDict): string[] {
  const normal = widget.lookupMaybe(N.AP, PDFDict)?.lookup(N.Nrm);
  if (!(normal instanceof PDFDict)) return [];
  return normal
    .keys()
    .map((key) => key.decodeText())
    .filter((name) => name !== "Off");
}

function fontSizeOf(dict: PDFDict): number {
  const da = textOf(inherited(dict, N.DA)) ?? "";
  const match = /([\d.]+)\s+Tf/.exec(da);
  return match ? Number(match[1]) : 0;
}

function valueOf(dict: PDFDict, kind: FieldKind, onValue: string | null): FormValue | null {
  const raw = inherited(dict, N.V);
  switch (kind) {
    case "text":
      return textOf(raw) ?? "";
    case "dropdown":
      return textOf(raw) ?? "";
    case "list": {
      if (raw instanceof PDFArray) return Array.from({ length: raw.size() }, (_, i) => textOf(raw.lookup(i)) ?? "").filter(Boolean);
      const single = textOf(raw);
      return single ? [single] : [];
    }
    case "checkbox": {
      const state = raw instanceof PDFName ? raw.decodeText() : textOf(raw);
      return Boolean(state) && state !== "Off" && (onValue === null || state === onValue);
    }
    case "radio": {
      const state = raw instanceof PDFName ? raw.decodeText() : textOf(raw);
      return state && state !== "Off" ? state : null;
    }
    default:
      return null;
  }
}

/** The fields a page already has: its form widgets, in display space. Push buttons are left out (they are not filled in). */
export function readFormFields(page: PDFPage, frame: PageFrame): AnalyzedField[] {
  const list = page.node.lookupMaybe(N.Annots, PDFArray);
  if (!list) return [];
  const out: AnalyzedField[] = [];
  for (let i = 0; i < Math.min(list.size(), 5000); i += 1) {
    const widget = list.lookupMaybe(i, PDFDict);
    if (!widget || widget.lookup(N.Subtype) !== N.Widget) continue;
    const flags = numberOf(widget.lookup(N.F)) ?? 0;
    if (flags & (HIDDEN | NO_VIEW)) continue;
    const type = inherited(widget, N.FT);
    const ff = numberOf(inherited(widget, N.Ff)) ?? 0;
    let kind: FieldKind;
    if (type === PDFName.of("Tx")) kind = "text";
    else if (type === PDFName.of("Btn")) kind = ff & FLAG.pushButton ? "button" : ff & FLAG.radio ? "radio" : "checkbox";
    else if (type === PDFName.of("Ch")) kind = ff & FLAG.combo ? "dropdown" : "list";
    else if (type === PDFName.of("Sig")) kind = "signature";
    else continue;
    if (kind === "button") continue;
    const rect = widget.lookupMaybe(N.Rect, PDFArray);
    if (!rect || rect.size() < 4) continue;
    const values = [0, 1, 2, 3].map((k) => numberOf(rect.lookup(k)) ?? Number.NaN);
    if (!values.every(Number.isFinite)) continue;
    const [x1, y1, x2, y2] = values as [number, number, number, number];
    const states = kind === "checkbox" || kind === "radio" ? onStates(widget) : [];
    const onValue = states[0] ?? null;
    out.push({
      id: `field:${i}`,
      name: fieldName(widget),
      kind,
      box: boxToDisplay(frame, { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }),
      value: valueOf(widget, kind, onValue),
      onValue,
      choices: kind === "dropdown" || kind === "list" ? choicesOf(widget) : [],
      multiline: kind === "text" && Boolean(ff & FLAG.multiline),
      password: kind === "text" && Boolean(ff & FLAG.password),
      readOnly: Boolean(ff & FLAG.readOnly),
      required: Boolean(ff & FLAG.required),
      maxLength: kind === "text" ? numberOf(inherited(widget, N.MaxLen)) : null,
      fontSize: fontSizeOf(widget),
      tooltip: textOf(widget.lookup(N.TU)),
    });
  }
  return out;
}

// ---- filling -------------------------------------------------------------------------------------------------------------

export interface FillOutcome {
  name: string;
  status: "applied" | "missing" | "refused";
  reason?: string;
}

/**
 * Sets the values of fields by name. Appearances are regenerated only for fields that changed. A value a field cannot take
 * (too long, not one of its choices, letters its font cannot draw) is refused and reported, never dropped silently.
 */
export async function fillFields(doc: PDFDocument, values: Readonly<Record<string, FormValue>>): Promise<FillOutcome[]> {
  const outcomes: FillOutcome[] = [];
  const names = Object.keys(values);
  if (names.length === 0) return outcomes;
  const form = doc.getForm();
  let needsUnicode = false;
  for (const name of names) {
    const value = values[name] as FormValue;
    const field = form.getFieldMaybe(name);
    if (!field) {
      outcomes.push({ name, status: "missing", reason: "The file no longer has a field with this name." });
      continue;
    }
    try {
      if (field instanceof PDFTextField) {
        const text = typeof value === "string" ? value : String(value);
        field.setText(text === "" ? undefined : text);
        if (/[^ -~\u00A0-ÿ€‘-„•…™]/.test(text)) needsUnicode = true;
      } else if (field instanceof PDFCheckBox) {
        if (value === true) field.check();
        else field.uncheck();
      } else if (field instanceof PDFRadioGroup) {
        if (typeof value === "string" && value !== "") field.select(value);
        else field.clear();
      } else if (field instanceof PDFDropdown) {
        const text = Array.isArray(value) ? (value[0] ?? "") : String(value);
        if (text === "") field.clear();
        else {
          if (!field.getOptions().includes(text)) {
            if (!field.isEditable()) throw new AppError("INVALID_INPUT", `“${text}” is not one of the choices of this list.`);
            field.addOptions(text);
          }
          field.select(text);
        }
      } else if (field instanceof PDFOptionList) {
        const chosen = Array.isArray(value) ? value : value === "" ? [] : [String(value)];
        const options = field.getOptions();
        const unknown = chosen.find((c) => !options.includes(c));
        if (unknown) throw new AppError("INVALID_INPUT", `“${unknown}” is not one of the choices of this list.`);
        if (chosen.length === 0) field.clear();
        else field.select(chosen);
      } else {
        outcomes.push({ name, status: "refused", reason: "This kind of field cannot be filled in here." });
        continue;
      }
      outcomes.push({ name, status: "applied" });
    } catch (error) {
      outcomes.push({ name, status: "refused", reason: error instanceof Error ? error.message : "The value was not accepted." });
    }
  }
  // Appearances: the standard font where it can draw the text, a font with more letters where it cannot.
  try {
    if (needsUnicode) throw new Error("unicode");
    form.updateFieldAppearances(await doc.embedFont("Helvetica"));
  } catch {
    try {
      const font = await resolveFont(doc, { family: "sans", bold: false, italic: false }, names.map((n) => (typeof values[n] === "string" ? (values[n] as string) : "")).join(""));
      form.updateFieldAppearances(font);
    } catch (error) {
      for (const outcome of outcomes) if (outcome.status === "applied") Object.assign(outcome, { status: "refused", reason: error instanceof Error ? error.message : "The field could not be drawn." });
    }
  }
  // Viewers that draw fields themselves should redraw them from the new values.
  doc.getForm().acroForm.dict.set(N.NeedAppearances, PDFBool.True);
  return outcomes;
}

// ---- creating ---------------------------------------------------------------------------------------------------------------

/** Names of every field the document already has. */
export function existingFieldNames(doc: PDFDocument): Set<string> {
  const form = doc.catalog.lookupMaybe(N.AcroForm, PDFDict);
  const names = new Set<string>();
  const roots = form?.lookupMaybe(N.Fields, PDFArray);
  if (!roots) return names;
  const walk = (dict: PDFDict, depth: number) => {
    if (depth > 32) return;
    const name = fieldName(dict);
    if (name) names.add(name);
    const kids = dict.lookupMaybe(N.Kids, PDFArray);
    if (kids) for (let i = 0; i < kids.size(); i += 1) {
      const kid = kids.lookupMaybe(i, PDFDict);
      if (kid) walk(kid, depth + 1);
    }
  };
  for (let i = 0; i < roots.size(); i += 1) {
    const root = roots.lookupMaybe(i, PDFDict);
    if (root) walk(root, 0);
  }
  return names;
}

/**
 * What to give pdf-lib so that the widget's rectangle comes out as `rect` (in user space) on a page turned by `turn`.
 * pdf-lib takes the box as the field would be drawn upright, grows it by the border width and turns it about its corner;
 * this undoes exactly that.
 */
function widgetPlacement(rect: { x: number; y: number; width: number; height: number }, turn: number, borderWidth: number): { x: number; y: number; width: number; height: number } {
  const b = borderWidth / 2;
  const w = Math.max(1, rect.width - borderWidth);
  const h = Math.max(1, rect.height - borderWidth);
  switch (turn) {
    case 90:
      return { x: rect.x + rect.width - b, y: rect.y + b, width: Math.max(1, rect.height - borderWidth), height: w };
    case 180:
      return { x: rect.x + rect.width - b, y: rect.y + rect.height - b, width: w, height: h };
    case 270:
      return { x: rect.x + b, y: rect.y + rect.height - b, width: Math.max(1, rect.height - borderWidth), height: w };
    default:
      return { x: rect.x + b, y: rect.y + b, width: w, height: h };
  }
}

const hexToRgb = (value: string | null) => (value ? (() => { const c = parseColor(value); return rgb(c.red, c.green, c.blue); })() : undefined);

/**
 * Adds the new fields of one page. Names must be unique in the document (the buttons of a radio group share their group's
 * name). A signature field marks the place for a signature; it is a field, not a signature.
 */
export async function createFields(doc: PDFDocument, page: PDFPage, frame: PageFrame, objects: readonly FormFieldObject[], taken: Set<string>): Promise<number> {
  const form = doc.getForm();
  let made = 0;
  const groups = new Map<string, PDFRadioGroup>();
  for (const object of objects) {
    const rect = userRectOf(frame, { x: object.x, y: object.y, width: object.width, height: object.height });
    const borderWidth = object.border.color ? object.border.width : 0;
    const placement = {
      ...widgetPlacement(rect, frame.rotation, borderWidth),
      rotate: degrees(frame.rotation),
      borderWidth,
      borderColor: hexToRgb(object.border.color),
      backgroundColor: hexToRgb(object.fill),
    };
    const name = object.fieldType === "radio" ? object.group || "Group1" : object.name;
    if (!name.trim()) throw new AppError("INVALID_INPUT", "A form field has no name. Give every field a name in the properties panel.");
    if (object.fieldType !== "radio" && taken.has(name)) throw new AppError("INVALID_INPUT", `Two form fields are called “${name}”. Field names must be different from each other and from the fields the document already has.`);

    switch (object.fieldType) {
      case "text": {
        const field = form.createTextField(name);
        if (object.multiline) field.enableMultiline();
        if (object.defaultValue) field.setText(object.defaultValue);
        if (object.fontSize > 0) field.setFontSize(object.fontSize);
        field.addToPage(page, placement);
        decorate(field, object);
        break;
      }
      case "checkbox": {
        const field = form.createCheckBox(name);
        field.addToPage(page, placement);
        if (object.defaultValue === "on" || object.defaultValue === "true") field.check();
        decorate(field, object);
        break;
      }
      case "radio": {
        let group = groups.get(name);
        if (!group) {
          if (taken.has(name)) throw new AppError("INVALID_INPUT", `A radio group called “${name}” already exists in the document.`);
          group = form.createRadioGroup(name);
          groups.set(name, group);
        }
        group.addOptionToPage(object.options[0] || object.label || object.name || `Option${group.getOptions().length + 1}`, page, placement);
        decorate(group, object);
        break;
      }
      case "dropdown": {
        const field = form.createDropdown(name);
        field.addOptions(object.options.length > 0 ? object.options : ["Option 1"]);
        if (object.defaultValue && object.options.includes(object.defaultValue)) field.select(object.defaultValue);
        if (object.fontSize > 0) field.setFontSize(object.fontSize);
        field.addToPage(page, placement);
        decorate(field, object);
        break;
      }
      case "signature":
        addSignatureField(doc, page, name, rect, object);
        break;
    }
    taken.add(name);
    made += 1;
  }
  return made;
}

/** Required, read-only and the tooltip. */
function decorate(field: PDFTextField | PDFCheckBox | PDFRadioGroup | PDFDropdown, object: FormFieldObject): void {
  if (object.required) field.enableRequired();
  if (object.readOnly) field.enableReadOnly();
  if (object.label) field.acroField.dict.set(N.TU, PDFString.of(object.label));
}

/** A signature field: a widget of type /Sig with a dashed outline so it can be seen. Nothing is signed. */
function addSignatureField(doc: PDFDocument, page: PDFPage, name: string, rect: { x: number; y: number; width: number; height: number }, object: FormFieldObject): void {
  const { context } = doc;
  const border = object.border.color ?? "#64748b";
  const c = parseColor(border);
  const appearance = context.register(
    context.stream(`q ${c.red} ${c.green} ${c.blue} RG 1 w [4 3] 0 d 0.5 0.5 ${rect.width - 1} ${rect.height - 1} re S Q`, { Type: "XObject", Subtype: "Form", BBox: [0, 0, rect.width, rect.height] }),
  );
  const field = context.register(
    context.obj({
      Type: "Annot",
      Subtype: "Widget",
      FT: "Sig",
      T: PDFString.of(name),
      TU: PDFString.of(object.label || "Signature"),
      Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
      F: 4,
      Ff: (object.required ? FLAG.required : 0) | (object.readOnly ? FLAG.readOnly : 0),
      P: page.ref,
      AP: { N: appearance },
    }),
  );
  const annots = page.node.lookupMaybe(N.Annots, PDFArray) ?? (context.obj([]) as PDFArray);
  annots.push(field);
  page.node.set(N.Annots, annots);
  const form = doc.getForm();
  const fields = form.acroForm.dict.lookupMaybe(N.Fields, PDFArray) ?? (context.obj([]) as PDFArray);
  fields.push(field);
  form.acroForm.dict.set(N.Fields, fields);
}
