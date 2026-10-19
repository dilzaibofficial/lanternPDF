import { describe, expect, it } from "vitest";
import { type Line, type RawItem, bodyFontSize, buildLines, buildParagraphs, columnBoundaries, findTables, lineText, parseNumber, readingOrder, sanitize } from "../../src/lib/convert/layout";

/** A piece of text at (x, baseline y) with a plausible width (half an em per character). */
const item = (text: string, x: number, y: number, size = 12, extra: Partial<RawItem> = {}): RawItem => ({ text, x, y, width: text.length * size * 0.5, fontSize: size, bold: false, italic: false, font: "sans", ...extra });

/** Words of a line laid out left to right with normal spacing. */
function words(line: string, x: number, y: number, size = 12, extra: Partial<RawItem> = {}): RawItem[] {
  const out: RawItem[] = [];
  let cursor = x;
  for (const word of line.split(" ")) {
    const piece = item(word, cursor, y, size, extra);
    out.push(piece);
    cursor += piece.width + size * 0.28;
  }
  return out;
}

const page = { width: 600, textLeft: 50, textRight: 550 };

describe("buildLines", () => {
  it("groups items that share a baseline, and joins their words with spaces", () => {
    const lines = buildLines([...words("Hello brave new world", 50, 100), ...words("second line here", 50, 114)], { segmentGap: 1.2 });
    expect(lines.map((line) => lineText(line))).toEqual(["Hello brave new world", "second line here"]);
    expect(lines[0]?.segments).toHaveLength(1);
  });

  it("copes with items arriving in any order and with tiny baseline differences", () => {
    const shuffled = [item("world", 100, 100.4), item("Hello", 50, 100), item("again", 50, 114.2), item("there", 100, 113.9)];
    const lines = buildLines(shuffled, { segmentGap: 1.2 });
    expect(lines.map((line) => lineText(line))).toEqual(["Hello world", "again there"]);
  });

  it("cuts a line into segments at wide gaps", () => {
    const lines = buildLines([...words("Item", 50, 100), ...words("Price", 300, 100), ...words("Qty", 450, 100)], { segmentGap: 1.2 });
    expect(lines[0]?.segments.map((segment) => segment.text)).toEqual(["Item", "Price", "Qty"]);
    expect(buildLines([...words("Item", 50, 100), ...words("Price", 100, 100)], { segmentGap: 6 })[0]?.segments).toHaveLength(1); // a larger threshold keeps them together
  });

  it("drops the second copy of text printed twice to fake bold, and ignores blank items", () => {
    const lines = buildLines([item("Title", 50, 100, 20), item("Title", 50.4, 100, 20), item("  ", 120, 100), item("", 130, 100)], { segmentGap: 1.2 });
    expect(lines).toHaveLength(1);
    expect(lineText(lines[0] as Line)).toBe("Title");
  });

  it("keeps the largest font size of a line and merges bold only when every part is bold", () => {
    const [line] = buildLines([item("Big", 50, 100, 20, { bold: true }), item("small", 90, 100, 10, { bold: false })], { segmentGap: 3 });
    expect(line?.fontSize).toBe(20);
    expect(line?.segments[0]?.bold).toBe(false);
  });
});

describe("bodyFontSize", () => {
  it("is the size most of the text is set in, not the biggest", () => {
    const lines = buildLines([...words("A heading", 50, 60, 24), ...words("body text that goes on and on for a while to outweigh it", 50, 100, 11), ...words("more body text of the usual size here", 50, 114, 11)], { segmentGap: 1.2 });
    expect(bodyFontSize(lines)).toBe(11);
  });
});

describe("readingOrder", () => {
  /** Two columns of `rows` lines each, side by side. */
  const twoColumns = (rows: number, startY = 100): RawItem[] =>
    Array.from({ length: rows }, (_, i) => [...words(`left column line ${i + 1} with more text`, 50, startY + i * 14), ...words(`right column line ${i + 1} with more text`, 330, startY + i * 14)]).flat();
  const left = (n: number) => `left column line ${n} with more text`;
  const right = (n: number) => `right column line ${n} with more text`;

  it("reads the left column before the right one", () => {
    const lines = readingOrder(buildLines(twoColumns(6), { segmentGap: 1.2 }), 600);
    expect(lines.map((line) => lineText(line))).toEqual([1, 2, 3, 4, 5, 6].map(left).concat([1, 2, 3, 4, 5, 6].map(right)));
  });

  it("lets a full-width heading come first and a full-width caption end the run", () => {
    const items = [...words("A heading across the whole page width here and more words to be wide enough", 50, 70, 14), ...twoColumns(4), ...words("Figure caption spanning both of the columns on the page for sure yes", 50, 200)];
    const text = readingOrder(buildLines(items, { segmentGap: 1.2 }), 600).map((line) => lineText(line));
    expect(text[0]).toMatch(/^A heading/);
    expect(text.slice(1, 5)).toEqual([1, 2, 3, 4].map(left));
    expect(text.slice(5, 9)).toEqual([1, 2, 3, 4].map(right));
    expect(text[9]).toMatch(/^Figure caption/);
  });

  it("does not mistake the rows of a table for two columns", () => {
    const cells = (y: number, a: string, b: string, c: string) => [...words(a, 72, y, 11), ...words(b, 260, y, 11), ...words(c, 380, y, 11)];
    const table = buildLines([...words("Price list", 72, 90, 16), ...cells(140, "Item", "Qty", "Price"), ...cells(158, "Widget", "4", "$9.99"), ...cells(176, "Gadget", "1,200", "$129.50"), ...cells(194, "Gizmo", "12", "12%"), ...cells(212, "Part", "3", "$5.00"), ...words("Prices exclude tax.", 72, 260, 10)], { segmentGap: 1.2 });
    const ordered = readingOrder(table, 595);
    expect(ordered.map((line) => lineText(line))).toEqual(table.map((line) => lineText(line)));
    expect(ordered.every((line) => line.segments.length === (line.y === 90 || line.y === 260 ? 1 : 3))).toBe(true); // no row was cut in two
  });

  it("leaves a single-column page, and short or lopsided pages, exactly as they are", () => {
    const single = buildLines(Array.from({ length: 8 }, (_, i) => words("one long line of ordinary prose that runs across most of the page width and then some", 50, 100 + i * 14)).flat(), { segmentGap: 1.2 });
    expect(readingOrder(single, 600).map((line) => lineText(line))).toEqual(single.map((line) => lineText(line)));
    // a letter: right-aligned date, then left-aligned lines. No true columns, so no reordering.
    const letter = buildLines([...words("12 May 2025", 440, 80), ...words("Dear Sam,", 50, 110), ...words("Thanks for the note.", 50, 124), ...words("Best,", 50, 138), ...words("Alex", 50, 152), ...words("PS", 50, 166)], { segmentGap: 1.2 });
    expect(readingOrder(letter, 600).map((line) => lineText(line))[0]).toBe("12 May 2025");
  });
});

describe("buildParagraphs", () => {
  const make = (rows: [string, number, number?, Partial<RawItem>?][], gap = 1.2) => buildLines(rows.flatMap(([text, y, size = 12, extra = {}]) => words(text, 50, y, size, extra)), { segmentGap: gap });

  it("joins the lines of a paragraph and starts a new one after a gap", () => {
    const lines = make([
      ["The quick brown fox jumps over the lazy dog and keeps", 100],
      ["running through the forest until it reaches the river.", 114],
      ["A second paragraph begins here after some space.", 142],
    ]);
    const paragraphs = buildParagraphs(lines, page, 12);
    expect(paragraphs.map((p) => p.runs.map((r) => r.text).join(""))).toEqual(["The quick brown fox jumps over the lazy dog and keeps running through the forest until it reaches the river.", "A second paragraph begins here after some space."]);
    expect(paragraphs.every((p) => p.kind === "body")).toBe(true);
  });

  it("recognises headings by size and by bold", () => {
    const lines = make([
      ["Annual Report", 60, 26],
      ["Overview", 100, 15, { bold: true }],
      ["Short bold line", 130, 12, { bold: true }],
      ["Body text that is simply set in the regular weight, at the usual size, and long", 156],
      ["enough to run on to a second and then a third line of the same paragraph here.", 170],
      ["The third line finishes the paragraph and gives the page a normal line pitch.", 184],
    ]);
    const [h1, h2, h3, body, ...rest] = buildParagraphs(lines, page, 12);
    expect(h1).toMatchObject({ kind: "heading", level: 1 });
    expect(h2).toMatchObject({ kind: "heading", level: 2 });
    expect(h3).toMatchObject({ kind: "heading", level: 3 });
    expect(body?.kind).toBe("body");
    expect(rest).toHaveLength(0); // the three body lines are one paragraph
  });

  it("recognises bullet and numbered lists, and removes the bullet character", () => {
    const lines = make([
      ["• first item of the list", 100],
      ["• second item", 114],
      ["1. numbered item", 128],
    ]);
    const paragraphs = buildParagraphs(lines, page, 12);
    expect(paragraphs.map((p) => p.kind)).toEqual(["bullet", "bullet", "body"]);
    expect(paragraphs[0]?.runs[0]?.text).toBe("first item of the list");
    expect(paragraphs[2]?.runs[0]?.text).toBe("1. numbered item"); // numbers stay, as typed
  });

  it("undoes a hyphen that only exists because the line broke, and leaves other hyphens alone", () => {
    const broken = make([
      ["This sentence was set in an inter-", 100],
      ["national journal of physics.", 114],
    ]);
    expect(buildParagraphs(broken, page, 12)[0]?.runs.map((r) => r.text).join("")).toBe("This sentence was set in an international journal of physics.");
    const kept = make([
      ["A well-known author of the Anglo-", 100],
      ["Saxon period, who wrote - at length - about it.", 114],
    ]);
    // inside a line, before a capital, and as a dash between spaces: all stay
    expect(buildParagraphs(kept, page, 12)[0]?.runs.map((r) => r.text).join("")).toBe("A well-known author of the Anglo- Saxon period, who wrote - at length - about it.");
  });

  it("keeps bold and italic inside a line as separate runs", () => {
    const [line] = buildLines([item("Plain", 50, 100), item("bold", 90, 100, 12, { bold: true }), item("italic", 130, 100, 12, { italic: true })], { segmentGap: 10 });
    expect(line?.segments).toHaveLength(1);
    expect(line?.segments[0]?.runs.map((run) => [run.text, run.bold, run.italic])).toEqual([
      ["Plain ", false, false],
      ["bold ", true, false],
      ["italic", false, true],
    ]);
    expect(line?.segments[0]).toMatchObject({ text: "Plain bold italic", bold: false, italic: false });
    const [paragraph] = buildParagraphs(line ? [line] : [], page, 12);
    expect(paragraph?.runs.map((run) => run.bold)).toEqual([false, true, false]);
  });

  it("centres a short centred line and keeps lines with several parts whole, with tab positions", () => {
    const centred = make([["Centered title", 100, 12]]);
    const wide = buildLines([item("Centered title", 240, 100)], { segmentGap: 1.2 });
    expect(buildParagraphs(wide, page, 12)[0]?.align).toBe("center");
    expect(buildParagraphs(centred, page, 12)[0]?.align).toBe("left");

    const tabular = buildLines([...words("Chapter one", 50, 100), ...words("page 5", 400, 100)], { segmentGap: 1.2 });
    const [p] = buildParagraphs(tabular, page, 12);
    expect(p?.kind).toBe("tabular");
    expect(p?.runs.map((r) => r.text).join("")).toBe("Chapter one\tpage 5");
    expect(p?.tabs).toEqual([350]);
  });

  it("indents text that starts further in than the margin", () => {
    const [p] = buildParagraphs(buildLines(words("Quoted passage", 90, 100), { segmentGap: 1.2 }), page, 12);
    expect(p?.indent).toBe(40);
  });
});

describe("tables", () => {
  const row = (y: number, cells: string[], bold = false) => cells.flatMap((text, i) => words(text, 50 + i * 150, y, 11, { bold }));

  it("finds the columns from where text is not, whatever its alignment", () => {
    const lines = buildLines([...row(100, ["Name", "Qty", "Price"], true), ...row(114, ["Widget", "4", "9.99"]), ...row(128, ["Gadget with a long name", "12", "129.50"])], { segmentGap: 0.8 });
    expect(columnBoundaries(lines, 6)).toHaveLength(2);
    const blocks = findTables(lines, 6);
    expect(blocks).toHaveLength(1);
    const table = blocks[0];
    expect(table?.type).toBe("table");
    if (table?.type === "table") {
      expect(table.columns).toBe(3);
      expect(table.rows).toEqual([
        ["Name", "Qty", "Price"],
        ["Widget", "4", "9.99"],
        ["Gadget with a long name", "12", "129.50"],
      ]);
      expect(table.headerBold).toBe(true);
    }
  });

  it("leaves ordinary text lines between tables as text", () => {
    const lines = buildLines([...words("Intro text", 50, 80), ...row(100, ["A", "B"]), ...row(114, ["C", "D"]), ...words("Closing remark", 50, 150)], { segmentGap: 0.8 });
    expect(findTables(lines, 6).map((block) => block.type)).toEqual(["text", "table", "text"]);
  });

  it("does not make a table out of a single multi-part line, or of parts that do not line up", () => {
    const one = buildLines([...words("Left", 50, 100), ...words("Right", 400, 100)], { segmentGap: 0.8 });
    expect(findTables(one, 6).map((block) => block.type)).toEqual(["text"]);
    // two staggered lines whose parts cover each other's gaps leave no common gutter: nothing lines up
    const messy = buildLines([item("aaaaaaaaaaaaaaaa", 50, 100), item("bbbbbbbbbbbbbbbb", 156, 100), item("cccccccccccccccc", 100, 114), item("dddddddddddddddd", 206, 114)], { segmentGap: 0.8 });
    expect(messy.map((line) => line.segments.length)).toEqual([2, 2]);
    expect(columnBoundaries(messy, 6)).toEqual([]);
    expect(findTables(messy, 6).every((block) => block.type === "text")).toBe(true);
  });
});

describe("parseNumber", () => {
  it("reads numbers that are unmistakably numbers", () => {
    expect(parseNumber("42")).toEqual({ value: 42 });
    expect(parseNumber("-7")).toEqual({ value: -7 });
    expect(parseNumber("3.14")).toEqual({ value: 3.14, format: "0.00" });
    expect(parseNumber("1,234")).toEqual({ value: 1234, format: "#,##0" });
    expect(parseNumber("1,234,567.50")).toEqual({ value: 1234567.5, format: "#,##0.00" });
    expect(parseNumber("12%")).toEqual({ value: 0.12, format: "0%" });
    expect(parseNumber("12.5%")).toEqual({ value: 0.125, format: "0.0%" });
    expect(parseNumber("$9.99")).toEqual({ value: 9.99, format: "$#,##0.00" });
    expect(parseNumber("€1,000")).toEqual({ value: 1000, format: "€#,##0" });
    expect(parseNumber("(250)")).toEqual({ value: -250 });
    expect(parseNumber("−5")).toEqual({ value: -5 }); // the typographic minus
    expect(parseNumber(" 0 ")).toEqual({ value: 0 });
  });

  it("leaves everything ambiguous as text", () => {
    for (const text of ["007", "01234", "1.234.567", "12,34", "1,23", "2025-01-31", "555-1234", "+1 555", "abc", "", "1e5", "(12", "12)", "--3", "$", "10 000", "0x10"]) {
      expect(parseNumber(text), text).toBeNull();
    }
  });
});

describe("sanitize", () => {
  const chars = (...codes: number[]) => String.fromCharCode(...codes);

  it("removes characters that are not allowed in Office XML, soft hyphens and odd spaces", () => {
    expect(sanitize(`a${chars(0)}b${chars(8)}c${chars(0xb)}d${chars(0x1f)}e${chars(0xfffe, 0xffff, 0xfffd)}f`)).toBe("abcdef");
    expect(sanitize(`co${chars(0xad)}operate`)).toBe("cooperate");
    expect(sanitize(`a${chars(0xa0)}b${chars(0x202f)}c${chars(0x2007)}d`)).toBe("a b c d");
    expect(sanitize("tab\tstays\nnewline stays")).toBe("tab\tstays\nnewline stays");
  });
});
