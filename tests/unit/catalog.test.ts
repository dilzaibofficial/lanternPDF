import { describe, expect, it, vi } from "vitest";
import { CATEGORIES, TOOLS, getTool, searchTools } from "../../src/config/tools";
import { TOOL_COMPONENTS } from "../../src/tools/registry";

// The tool pages are heavy to load and need a browser; only their shape matters here.
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument: () => ({}), Util: {}, version: "test" }));

describe("the tool catalog", () => {
  it("has exactly one working page for every tool, and no page without a catalog entry", () => {
    const listed = TOOLS.map((tool) => tool.id).sort();
    const built = Object.keys(TOOL_COMPONENTS).sort();
    expect(built).toEqual(listed);
  });

  it("every tool page module loads and provides a component (no placeholder tools)", async () => {
    for (const [id, component] of Object.entries(TOOL_COMPONENTS)) {
      // React.lazy keeps its loader on the `_payload`; calling the same import again is the portable way to check it.
      const payload = (component as unknown as { _payload: { _result: () => Promise<{ default: unknown }> } })._payload;
      const loaded = await payload._result();
      expect(typeof loaded.default, `the module for “${id}” has no default export`).toBe("function");
    }
  }, 120_000);

  it("ids are unique and safe in a URL", () => {
    const ids = TOOLS.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("every tool is in a known category, with a name, a description and three steps", () => {
    const categories = new Set(CATEGORIES.map((category) => category.id));
    for (const tool of TOOLS) {
      expect(categories.has(tool.category), tool.id).toBe(true);
      expect(tool.name.trim(), tool.id).not.toBe("");
      expect(tool.short.endsWith("."), `${tool.id}: the card text is a sentence`).toBe(true);
      expect(tool.description.length, tool.id).toBeGreaterThan(30);
      expect(tool.howTo, tool.id).toHaveLength(3);
      expect(tool.accept.length, tool.id).toBeGreaterThan(0);
      for (const extension of tool.accept) expect(extension, tool.id).toMatch(/^\.[a-z0-9]+$/);
    }
    for (const category of CATEGORIES) expect(TOOLS.some((tool) => tool.category === category.id), category.id).toBe(true);
  });

  it("related tools exist, are not the tool itself, and are not repeated", () => {
    for (const tool of TOOLS) {
      expect(new Set(tool.related).size, tool.id).toBe(tool.related.length);
      for (const other of tool.related) {
        expect(other, `${tool.id} relates to itself`).not.toBe(tool.id);
        expect(getTool(other), `${tool.id} relates to “${other}”, which does not exist`).toBeDefined();
      }
    }
  });

  it("says honestly where the work happens", () => {
    for (const tool of TOOLS) {
      if (tool.processing === "server") expect(tool.description.toLowerCase(), tool.id).toMatch(/server/);
      if (tool.processing === "optional-server") expect(tool.howTo.join(" ").toLowerCase(), tool.id).toMatch(/server|libreoffice/);
    }
    // Word, Excel and PowerPoint convert on the device (with an optional server mode); no tool needs the server any more
    expect(TOOLS.filter((tool) => tool.processing === "server").map((tool) => tool.id)).toEqual([]);
    expect(TOOLS.filter((tool) => tool.processing === "optional-server").map((tool) => tool.id)).toEqual(expect.arrayContaining(["word-to-pdf", "excel-to-pdf", "powerpoint-to-pdf"]));
  });

  it("finds tools by name, by what people call them, and by typos in the middle", () => {
    expect(searchTools("merge")[0]?.id).toBe("merge");
    expect(searchTools("shrink")[0]?.id).toBe("compress");
    expect(searchTools("password").map((tool) => tool.id)).toEqual(expect.arrayContaining(["protect", "unlock"]));
    expect(searchTools("docx").map((tool) => tool.id)).toEqual(expect.arrayContaining(["word-to-pdf", "pdf-to-word"]));
    expect(searchTools("signature").map((tool) => tool.id)).toContain("edit");
    expect(searchTools("zzzzqqq")).toEqual([]);
    expect(searchTools("").length).toBe(TOOLS.length);
  });
});
