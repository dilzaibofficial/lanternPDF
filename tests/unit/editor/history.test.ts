import { describe, expect, it } from "vitest";
import { canRedo, canUndo, commit, createHistory, isDirty, jumpTo, markSaved, redo, steps, undo } from "../../../src/editor/model/history";

describe("history", () => {
  it("records steps, and undo and redo move through them", () => {
    let h = createHistory({ n: 0 }, "Open");
    h = commit(h, { n: 1 }, "One");
    h = commit(h, { n: 2 }, "Two");
    expect(h.present.state).toEqual({ n: 2 });
    expect(canUndo(h)).toBe(true);
    expect(canRedo(h)).toBe(false);
    h = undo(h);
    expect(h.present.state).toEqual({ n: 1 });
    expect(canRedo(h)).toBe(true);
    h = undo(h);
    h = undo(h); // nothing further back
    expect(h.present.state).toEqual({ n: 0 });
    expect(canUndo(h)).toBe(false);
    h = redo(h);
    h = redo(h);
    h = redo(h);
    expect(h.present.state).toEqual({ n: 2 });
  });

  it("throws away the redo branch when something new is done", () => {
    let h = createHistory(0, "Open");
    h = commit(h, 1, "a");
    h = commit(h, 2, "b");
    h = undo(h);
    h = commit(h, 9, "c");
    expect(h.future).toHaveLength(0);
    expect(steps(h).map((s) => s.label)).toEqual(["Open", "a", "c"]);
  });

  it("does not record the same state twice", () => {
    const state = { a: 1 };
    let h = createHistory(state, "Open");
    h = commit(h, state, "nothing");
    expect(h.past).toHaveLength(0);
  });

  it("merges steps with the same key that come close together, but not ones that are far apart or differently keyed", () => {
    let h = createHistory(0, "Open", 0);
    h = commit(h, 1, "Move", { key: "move:a", now: 100 });
    h = commit(h, 2, "Move", { key: "move:a", now: 400 });
    h = commit(h, 3, "Move", { key: "move:a", now: 700 });
    expect(h.past).toHaveLength(1); // Open, then one merged step
    expect(h.present.state).toBe(3);
    h = commit(h, 4, "Move", { key: "move:a", now: 5000 });
    expect(h.past).toHaveLength(2);
    h = commit(h, 5, "Resize", { key: "resize:a", now: 5100 });
    expect(h.past).toHaveLength(3);
    h = undo(h);
    expect(h.present.state).toBe(4);
  });

  it("keeps the first state of a merged burst so one undo goes back to before it", () => {
    let h = createHistory("start", "Open", 0);
    for (let i = 1; i <= 5; i += 1) h = commit(h, `typed ${i}`, "Type", { key: "type", now: i * 100 });
    h = undo(h);
    expect(h.present.state).toBe("start");
  });

  it("limits how much it remembers", () => {
    let h = createHistory(0, "Open");
    for (let i = 1; i <= 50; i += 1) h = commit(h, i, `s${i}`, { limit: 10 });
    expect(h.past).toHaveLength(10);
    expect(h.present.state).toBe(50);
  });

  it("knows when the document has unsaved changes, even after undo and redo", () => {
    const a = { v: "a" };
    const b = { v: "b" };
    let h = createHistory(a, "Open");
    expect(isDirty(h)).toBe(false);
    h = commit(h, b, "Edit");
    expect(isDirty(h)).toBe(true);
    h = markSaved(h);
    expect(isDirty(h)).toBe(false);
    h = undo(h);
    expect(isDirty(h)).toBe(true);
    h = redo(h);
    expect(isDirty(h)).toBe(false);
    // saved at b, undo, then do something else: not the saved state any more
    h = undo(h);
    h = commit(h, { v: "c" }, "Other");
    expect(isDirty(h)).toBe(true);
  });

  it("lists what was done and where we are, and can jump to a step", () => {
    let h = createHistory(0, "Open");
    h = commit(h, 1, "A");
    h = commit(h, 2, "B");
    h = commit(h, 3, "C");
    h = undo(h);
    expect(steps(h).map((s) => `${s.current ? "*" : ""}${s.label}`)).toEqual(["Open", "A", "*B", "C"]);
    h = jumpTo(h, 0);
    expect(h.present.state).toBe(0);
    expect(h.future).toHaveLength(3);
    h = jumpTo(h, 3);
    expect(h.present.state).toBe(3);
    expect(jumpTo(h, 99)).toBe(h);
  });
});
