import { describe, expect, it } from "vitest";
import { baseName, extensionOf, formatBytes, percentSaved, plural, sanitizeFileName, uniqueName } from "../../src/lib/format";

describe("formatBytes", () => {
  it("uses 1024-based units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(150 * 1024 * 1024)).toBe("150 MB");
  });

  it("does not print nonsense for bad input", () => {
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("file name helpers", () => {
  it("splits names", () => {
    expect(baseName("report.final.pdf")).toBe("report.final");
    expect(baseName("noext")).toBe("noext");
    expect(baseName(".hidden")).toBe(".hidden");
    expect(extensionOf("Photo.JPEG")).toBe("jpeg");
    expect(extensionOf("noext")).toBe("");
  });

  it("sanitises characters that are illegal in file names", () => {
    expect(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j.pdf')).toBe("a_b_c_d_e_f_g_h_i_j.pdf");
    expect(sanitizeFileName("..hidden")).toBe("hidden");
    expect(sanitizeFileName("   ")).toBe("file");
  });

  it("makes names unique without losing the extension", () => {
    expect(uniqueName("a.pdf", ["b.pdf"])).toBe("a.pdf");
    expect(uniqueName("a.pdf", ["a.pdf"])).toBe("a (2).pdf");
    expect(uniqueName("a.pdf", ["a.pdf", "a (2).pdf"])).toBe("a (3).pdf");
  });
});

describe("plural / percentSaved", () => {
  it("pluralises", () => {
    expect(plural(1, "page")).toBe("1 page");
    expect(plural(2, "page")).toBe("2 pages");
    expect(plural(1234, "page")).toBe("1,234 pages");
    expect(plural(2, "box", "boxes")).toBe("2 boxes");
  });

  it("never reports a negative saving", () => {
    expect(percentSaved(1000, 250)).toBe(75);
    expect(percentSaved(1000, 1000)).toBe(0);
    expect(percentSaved(1000, 1200)).toBe(0);
    expect(percentSaved(0, 0)).toBe(0);
  });
});
