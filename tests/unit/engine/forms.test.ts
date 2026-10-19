import { type PDFCheckBox, PDFDocument, type PDFDropdown, type PDFRadioGroup, type PDFTextField } from "@cantoo/pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { createFields, existingFieldNames, fillFields } from "../../../src/lib/pdf/engine/forms";
import { EngineSession } from "../../../src/lib/pdf/engine/session";
import { frameOf } from "../../../src/lib/pdf/draw";
import type { FormFieldObject } from "../../../src/editor/model/types";
import { setUnicodeFontLoader } from "../../../src/lib/pdf/fonts";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fixtureBytes } from "../../fixtures/build";

const require = createRequire(import.meta.url);
setUnicodeFontLoader(async (file) => new Uint8Array(readFileSync(require.resolve(`dejavu-fonts-ttf/ttf/${file}`))));

const field = (overrides: Partial<FormFieldObject> & Pick<FormFieldObject, "fieldType" | "name">): FormFieldObject => ({
  id: overrides.name,
  page: "p",
  kind: "field",
  rotation: 0,
  opacity: 1,
  x: 50,
  y: 50,
  width: 120,
  height: 24,
  label: "",
  required: false,
  readOnly: false,
  multiline: false,
  options: [],
  group: "",
  defaultValue: "",
  fontSize: 0,
  border: { color: "#334155", width: 1, style: "solid" },
  fill: null,
  ...overrides,
});

async function annotationsOf(bytes: Uint8Array) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    return await page.getAnnotations();
  } finally {
    await task.destroy();
  }
}

describe("reading the fields of a page", () => {
  it("finds every field with its kind, value, choices and place", async () => {
    const analysis = (await EngineSession.open({ name: "f.pdf", bytes: fixtureBytes("pdfkit-form.pdf") })).analyze(0);
    expect(analysis.fields.map((f) => `${f.kind}:${f.name}`)).toEqual(["text:fullName", "text:email", "checkbox:agree", "dropdown:country", "text:comments"]);
    const byName = Object.fromEntries(analysis.fields.map((f) => [f.name, f]));
    expect(byName.fullName).toMatchObject({ value: "Jane Doe", multiline: false });
    expect(byName.email?.value).toBe("");
    expect(byName.agree).toMatchObject({ value: false });
    expect(byName.country).toMatchObject({ value: "India" });
    expect(byName.country?.choices.map((c) => c.value)).toEqual(["Norway", "India", "Brazil"]);
    expect(byName.comments?.multiline).toBe(true);
    // Display space: the full-name box is 160 from the left and 124 from the top of the A4 page.
    expect(byName.fullName?.box).toMatchObject({ x: 160, width: 240, height: 22 });
    expect(byName.fullName?.box.y).toBeCloseTo(124, 0);
  });

  it("finds nothing on a page without fields", async () => {
    expect((await EngineSession.open({ name: "o.pdf", bytes: fixtureBytes("objects.pdf") })).analyze(0).fields).toEqual([]);
  });
});

describe("filling the fields in", () => {
  it("sets text, a check box and a choice, and the file reads back with them", async () => {
    const doc = await PDFDocument.load(fixtureBytes("pdfkit-form.pdf"));
    const outcomes = await fillFields(doc, { fullName: "Alex Example", email: "alex@example.org", agree: true, country: "Norway", comments: "First line\nSecond line" });
    expect(outcomes.every((o) => o.status === "applied")).toBe(true);
    const saved = await doc.save();
    const form = (await PDFDocument.load(saved)).getForm();
    expect((form.getField("fullName") as PDFTextField).getText()).toBe("Alex Example");
    expect((form.getField("email") as PDFTextField).getText()).toBe("alex@example.org");
    expect((form.getField("agree") as PDFCheckBox).isChecked()).toBe(true);
    expect((form.getField("country") as PDFDropdown).getSelected()).toEqual(["Norway"]);
    expect((form.getField("comments") as PDFTextField).getText()).toBe("First line\nSecond line");
    // A viewer sees the same: pdf.js reads the values from the file.
    const values = Object.fromEntries((await annotationsOf(saved)).filter((a) => a.fieldName).map((a) => [a.fieldName, a.fieldValue ?? a.buttonValue]));
    expect(values.fullName).toBe("Alex Example");
    expect(values.country).toEqual(["Norway"]);
  });

  it("can clear a value and untick a box", async () => {
    const doc = await PDFDocument.load(fixtureBytes("pdfkit-form.pdf"));
    await fillFields(doc, { agree: true });
    const again = await PDFDocument.load(await doc.save());
    await fillFields(again, { agree: false, fullName: "" });
    const form = (await PDFDocument.load(await again.save())).getForm();
    expect((form.getField("agree") as PDFCheckBox).isChecked()).toBe(false);
    expect((form.getField("fullName") as PDFTextField).getText() ?? "").toBe("");
  });

  it("refuses a value a field cannot take, says why, and still fills the rest", async () => {
    const doc = await PDFDocument.load(fixtureBytes("pdfkit-form.pdf"));
    const outcomes = await fillFields(doc, { country: "Atlantis", fullName: "Fine", ghost: "x" });
    expect(outcomes.find((o) => o.name === "country")).toMatchObject({ status: "refused" });
    expect(outcomes.find((o) => o.name === "country")?.reason).toMatch(/not one of the choices/);
    expect(outcomes.find((o) => o.name === "ghost")).toMatchObject({ status: "missing" });
    expect(outcomes.find((o) => o.name === "fullName")?.status).toBe("applied");
  });

  it("draws letters the standard font lacks with a font that has them", async () => {
    const doc = await PDFDocument.load(fixtureBytes("pdfkit-form.pdf"));
    const outcomes = await fillFields(doc, { fullName: "Ελένη Παπά" });
    expect(outcomes[0]?.status).toBe("applied");
    const form = (await PDFDocument.load(await doc.save())).getForm();
    expect((form.getField("fullName") as PDFTextField).getText()).toBe("Ελένη Παπά");
  });
});

describe("creating fields", () => {
  const fresh = async (width = 300, height = 200) => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([width, height]);
    return { doc, page, frame: frameOf(page) };
  };

  it("adds text, check box, radio, drop-down and signature fields where the boxes are", async () => {
    const { doc, page, frame } = await fresh();
    const made = await createFields(
      doc,
      page,
      frame,
      [
        field({ fieldType: "text", name: "fullName", x: 20, y: 20, width: 140, height: 22, multiline: false, defaultValue: "Ada", required: true, label: "Your name" }),
        field({ fieldType: "checkbox", name: "agree", x: 20, y: 60, width: 14, height: 14, defaultValue: "on" }),
        field({ fieldType: "radio", name: "r1", group: "size", options: ["small"], x: 20, y: 90, width: 14, height: 14 }),
        field({ fieldType: "radio", name: "r2", group: "size", options: ["large"], x: 60, y: 90, width: 14, height: 14 }),
        field({ fieldType: "dropdown", name: "country", options: ["Norway", "India"], defaultValue: "India", x: 20, y: 120, width: 120, height: 22 }),
        field({ fieldType: "signature", name: "sign", x: 160, y: 120, width: 120, height: 40, label: "Sign here" }),
      ],
      new Set(),
    );
    expect(made).toBe(6);
    const saved = await doc.save();
    const form = (await PDFDocument.load(saved)).getForm();
    expect(form.getFields().map((f) => `${f.constructor.name}:${f.getName()}`).sort()).toEqual(["PDFCheckBox:agree", "PDFDropdown:country", "PDFRadioGroup:size", "PDFTextField:fullName", "PDFSignature:sign"].sort());
    expect((form.getField("fullName") as PDFTextField).getText()).toBe("Ada");
    expect((form.getField("fullName") as PDFTextField).isRequired()).toBe(true);
    expect((form.getField("agree") as PDFCheckBox).isChecked()).toBe(true);
    expect((form.getField("size") as PDFRadioGroup).getOptions()).toEqual(["small", "large"]);
    expect((form.getField("country") as PDFDropdown).getSelected()).toEqual(["India"]);
    // And the editor reads them back where they were drawn (display space, from the top).
    const analysis = (await EngineSession.open({ name: "n.pdf", bytes: saved })).analyze(0);
    expect(analysis.fields.find((f) => f.name === "fullName")?.box).toMatchObject({ x: 20, y: 20, width: 140, height: 22 });
    expect(analysis.fields.find((f) => f.name === "sign")).toMatchObject({ kind: "signature" });
    expect(analysis.fields.filter((f) => f.kind === "radio")).toHaveLength(2);
  });

  it("puts fields where the viewer shows them on a page with a turn", async () => {
    const doc = await PDFDocument.load(fixtureBytes("pdflib-rotated.pdf"));
    const page = doc.getPage(0);
    await createFields(doc, page, frameOf(page), [field({ fieldType: "text", name: "note", x: 10, y: 10, width: 100, height: 20 })], new Set());
    const analysis = (await EngineSession.open({ name: "r.pdf", bytes: await doc.save() })).analyze(0);
    expect(analysis.fields.find((f) => f.name === "note")?.box).toMatchObject({ x: 10, y: 10, width: 100, height: 20 });
  });

  it("refuses duplicate names and nameless fields instead of making a broken form", async () => {
    const { doc, page, frame } = await fresh();
    await expect(createFields(doc, page, frame, [field({ fieldType: "text", name: "a" }), field({ fieldType: "text", name: "a", y: 90 })], new Set())).rejects.toThrow(/Two form fields are called “a”/);
    const again = await fresh();
    await expect(createFields(again.doc, again.page, again.frame, [field({ fieldType: "text", name: "  " })], new Set())).rejects.toThrow(/has no name/);
    const existing = await PDFDocument.load(fixtureBytes("pdfkit-form.pdf"));
    expect(existingFieldNames(existing)).toEqual(new Set(["fullName", "email", "agree", "country", "comments"]));
    await expect(createFields(existing, existing.getPage(0), frameOf(existing.getPage(0)), [field({ fieldType: "text", name: "email" })], existingFieldNames(existing))).rejects.toThrow(/Two form fields/);
  });
});
