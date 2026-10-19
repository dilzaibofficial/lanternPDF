import { describe, expect, it } from "vitest";
import { AppError } from "../../src/lib/errors";
import { complementPages, expandRanges, formatPageList, parsePageRanges } from "../../src/lib/ranges";

const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("INVALID_INPUT");
    return (error as AppError).message;
  }
  throw new Error("expected the call to throw");
};

describe("parsePageRanges", () => {
  it("parses numbers, ranges and open ends", () => {
    expect(parsePageRanges("1-3, 5, 8-", 10)).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 5 },
      { start: 8, end: 10 },
    ]);
  });

  it("treats a leading dash as 'from the first page'", () => {
    expect(parsePageRanges("-3", 10)).toEqual([{ start: 1, end: 3 }]);
  });

  it("understands last/end/odd/even keywords", () => {
    expect(parsePageRanges("last", 7)).toEqual([{ start: 7, end: 7 }]);
    expect(parsePageRanges("2-end", 7)).toEqual([{ start: 2, end: 7 }]);
    expect(expandRanges(parsePageRanges("odd", 7))).toEqual([1, 3, 5, 7]);
    expect(expandRanges(parsePageRanges("even", 7))).toEqual([2, 4, 6]);
  });

  it("tolerates stray whitespace, semicolons and repeated separators", () => {
    expect(parsePageRanges(" 1 - 2 ;; 4 ,", 5)).toEqual([
      { start: 1, end: 2 },
      { start: 4, end: 4 },
    ]);
  });

  it("rejects empty input with an actionable message", () => {
    expect(messageOf(() => parsePageRanges("   ", 5))).toMatch(/at least one page/i);
    expect(messageOf(() => parsePageRanges(" , ; ", 5))).toMatch(/at least one page/i);
  });

  it("rejects pages outside the document and says how many pages it has", () => {
    expect(messageOf(() => parsePageRanges("11", 10))).toMatch(/page 11 is out of range.*10 pages/i);
    expect(messageOf(() => parsePageRanges("1-99", 3))).toMatch(/out of range.*3 pages/i);
    expect(messageOf(() => parsePageRanges("0", 3))).toMatch(/start at 1/i);
  });

  it("rejects garbage and malformed ranges", () => {
    expect(messageOf(() => parsePageRanges("abc", 5))).toMatch(/not a valid page range/i);
    expect(messageOf(() => parsePageRanges("1-2-3", 5))).toMatch(/one dash/i);
    expect(messageOf(() => parsePageRanges("2.5", 5))).toMatch(/not a valid page range/i);
  });

  it("rejects backwards ranges unless descending is allowed", () => {
    expect(messageOf(() => parsePageRanges("5-2", 9))).toMatch(/backwards.*2-5/i);
    expect(expandRanges(parsePageRanges("5-2", 9, { allowDescending: true }))).toEqual([5, 4, 3, 2]);
  });

  it("can forbid overlapping ranges", () => {
    expect(messageOf(() => parsePageRanges("1-3, 3-5", 9, { allowOverlap: false }))).toMatch(/page 3 appears in more than one/i);
    expect(parsePageRanges("1-3, 4-5", 9, { allowOverlap: false })).toHaveLength(2);
  });

  it("refuses a document with no pages", () => {
    expect(messageOf(() => parsePageRanges("1", 0))).toMatch(/no pages/i);
  });
});

describe("expandRanges / formatPageList / complementPages", () => {
  it("expands in the order given, keeping repeats", () => {
    expect(
      expandRanges([
        { start: 3, end: 4 },
        { start: 1, end: 1 },
        { start: 3, end: 3 },
      ]),
    ).toEqual([3, 4, 1, 3]);
  });

  it("collapses ascending runs but never reorders", () => {
    expect(formatPageList([1, 2, 3, 5, 7, 8])).toBe("1-3,5,7-8");
    expect(formatPageList([3, 1, 2])).toBe("3,1-2");
    expect(formatPageList([4, 4, 4])).toBe("4,4,4");
    expect(formatPageList([])).toBe("");
  });

  it("computes the complement of a selection", () => {
    expect(complementPages([2, 4], 5)).toEqual([1, 3, 5]);
    expect(complementPages([1, 2, 3], 3)).toEqual([]);
  });
});
