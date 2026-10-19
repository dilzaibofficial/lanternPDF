import { describe, expect, it } from "vitest";
import { type Operation, formatName, formatNumber, hexString, numbersOf, parseContentStream } from "../../../src/lib/pdf/engine/tokenizer";

const bytes = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const source = (text: string, op: Operation) => text.slice(op.start, op.end);
const parse = (text: string) => parseContentStream(bytes(text));

describe("content stream tokenizer", () => {
  it("groups operands with their operator and records the exact bytes of each operation", () => {
    const text = "BT\n/F1 12 Tf\n72 700 Td\n(Hello) Tj\nET";
    const { ops, problems } = parse(text);
    expect(problems).toBe(0);
    expect(ops.map((op) => op.op)).toEqual(["BT", "Tf", "Td", "Tj", "ET"]);
    expect(source(text, ops[1] as Operation)).toBe("/F1 12 Tf");
    expect(source(text, ops[2] as Operation)).toBe("72 700 Td");
    expect(source(text, ops[3] as Operation)).toBe("(Hello) Tj");
    expect(text.slice((ops[3] as Operation).opStart, (ops[3] as Operation).end)).toBe("Tj");
    expect(ops[1]?.args.map((a) => a.t)).toEqual(["name", "num"]);
  });

  it("reads literal strings: escapes, octal codes, balanced parentheses and line continuations", () => {
    const text = "(a\\(b\\)c \\101\\102 (nested) \\n\\\\ x\\\ny) Tj";
    const op = parse(text).ops[0] as Operation;
    const arg = op.args[0];
    expect(arg?.t).toBe("str");
    if (arg?.t !== "str") return;
    expect(String.fromCharCode(...arg.bytes)).toBe("a(b)c AB (nested) \n\\ xy");
    expect(arg.hex).toBe(false);
    expect(source(text, op)).toBe(text);
  });

  it("reads hex strings, ignoring whitespace and padding an odd final digit", () => {
    const op = parse("<48 65 6C6c 6F7> Tj").ops[0] as Operation;
    const arg = op.args[0];
    if (arg?.t !== "str") throw new Error("not a string");
    expect([...arg.bytes]).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x70]);
    expect(arg.hex).toBe(true);
  });

  it("reads TJ arrays with strings and spacing numbers", () => {
    const text = "[(W) 120 (orld) -15.5 <0041>] TJ";
    const op = parse(text).ops[0] as Operation;
    const array = op.args[0];
    if (array?.t !== "arr") throw new Error("not an array");
    expect(array.items.map((i) => i.t)).toEqual(["str", "num", "str", "num", "str"]);
    expect(array.items.filter((i) => i.t === "num").map((i) => (i as { v: number }).v)).toEqual([120, -15.5]);
    expect(source(text, op)).toBe(text);
  });

  it("reads inline dictionaries (marked content properties) and names with #-escapes", () => {
    const text = "/Span <</ActualText (Hi) /MCID 3>> BDC /A#20B gs";
    const { ops } = parse(text);
    expect(ops.map((op) => op.op)).toEqual(["BDC", "gs"]);
    const dict = ops[0]?.args[1];
    if (dict?.t !== "dict") throw new Error("not a dict");
    expect([...dict.entries.keys()]).toEqual(["ActualText", "MCID"]);
    const name = ops[1]?.args[0];
    expect(name?.t === "name" && name.v).toBe("A B");
  });

  it("accepts every PDF number form and keeps them apart from operators", () => {
    const text = "+3 -.5 4. .25 0 -0 cm";
    const op = parse(text).ops[0] as Operation;
    expect(op.args.map((a) => (a.t === "num" ? a.v : Number.NaN))).toEqual([3, -0.5, 4, 0.25, 0, -0]);
    expect(numbersOf(op.args, 4)).toEqual([4, 0.25, 0, -0]);
    expect(numbersOf(op.args, 7)).toBeNull();
  });

  it("skips comments", () => {
    const { ops } = parse("q % a comment (with a paren\n1 0 0 1 5 5 cm % trailing\nQ");
    expect(ops.map((op) => op.op)).toEqual(["q", "cm", "Q"]);
  });

  it("skips inline images, including binary data that contains the letters EI", () => {
    const head = "q BI /W 2 /H 2 /BPC 8 /CS /G ID ";
    const binary = [0x01, 0x20, 0x45, 0x49, 0x20, 0xff, 0x00, 0x81];
    const tail = " EI Q (after) Tj";
    const data = Uint8Array.from([...bytes(head), ...binary, ...bytes(tail)]);
    const { ops } = parseContentStream(data);
    expect(ops.map((op) => op.op)).toEqual(["q", "BI", "Q", "Tj"]);
    const image = ops[1] as Operation;
    expect(image.inline?.dataEnd).toBeGreaterThan(image.inline?.dataStart ?? 0);
    expect(image.inline?.dataEnd).toBe((image.inline?.dataStart ?? 0) + binary.length);
    expect(image.inline?.dict.get("W")).toMatchObject({ t: "num", v: 2 });
  });

  it("uses the declared inline image length when there is one", () => {
    const head = "BI /W 1 /H 1 /BPC 8 /CS /G /L 4 ID ";
    const data = Uint8Array.from([...bytes(head), 0x20, 0x45, 0x49, 0x20, ...bytes(" EI Q")]);
    const { ops } = parseContentStream(data);
    expect(ops.map((op) => op.op)).toEqual(["BI", "Q"]);
    expect((ops[0]?.inline?.dataEnd ?? 0) - (ops[0]?.inline?.dataStart ?? 0)).toBe(4);
  });

  it("survives garbage: stray closers, an unterminated string, an unterminated array", () => {
    for (const text of ["> ) ] } q", "(never closed Tj", "[ (a) 1 ", "<< /A", "<414", "\u0000\u0001\u0002 Q"]) {
      const result = parse(text);
      expect(result.ops.length).toBeGreaterThanOrEqual(0);
    }
    const { ops, problems } = parse("> ) ] } q");
    expect(ops.map((op) => op.op)).toEqual(["q"]);
    expect(problems).toBeGreaterThan(0);
  });

  it("bounds nesting and operations so hostile input cannot exhaust memory", () => {
    const deep = `${"[".repeat(5000)}${"]".repeat(5000)} TJ`;
    expect(parse(deep).ops.length).toBe(1);
    const many = "q ".repeat(1000);
    const result = parseContentStream(bytes(many), { maxOps: 100 });
    expect(result.ops).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it("formats numbers, names and hex strings for writing back", () => {
    expect(formatNumber(12)).toBe("12");
    expect(formatNumber(0.5)).toBe("0.5");
    expect(formatNumber(-1.23456789)).toBe("-1.2346");
    expect(formatNumber(1e-9)).toBe("0");
    expect(formatNumber(Number.NaN)).toBe("0");
    expect(formatName("F 1")).toBe("/F#201");
    expect(hexString(Uint8Array.from([0, 255, 16]))).toBe("<00ff10>");
  });
});
