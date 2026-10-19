import { describe, expect, it } from "vitest";
import { jpegFrame } from "../../src/lib/pdf/jpeg";
import { looksLikePhoto, packComponents, predictRows, resizeArea, unpackToRgba, unpredict } from "../../src/lib/pdf/pixels";
import { graphicPixels, photoPixels, random } from "./helpers/pdfImages";
import { makeImage } from "./helpers/images";

/** Reference PNG row filter, written out independently of the library code. */
function filterRows(raw: Uint8Array, rowBytes: number, rows: number, bpp: number, tags: number[]): Uint8Array {
  const out = new Uint8Array((rowBytes + 1) * rows);
  for (let r = 0; r < rows; r += 1) {
    const tag = tags[r % tags.length] as number;
    out[r * (rowBytes + 1)] = tag;
    for (let i = 0; i < rowBytes; i += 1) {
      const x = raw[r * rowBytes + i] as number;
      const a = i >= bpp ? (raw[r * rowBytes + i - bpp] as number) : 0;
      const b = r > 0 ? (raw[(r - 1) * rowBytes + i] as number) : 0;
      const c = r > 0 && i >= bpp ? (raw[(r - 1) * rowBytes + i - bpp] as number) : 0;
      let predicted = 0;
      if (tag === 1) predicted = a;
      else if (tag === 2) predicted = b;
      else if (tag === 3) predicted = (a + b) >> 1;
      else if (tag === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[r * (rowBytes + 1) + 1 + i] = (x - predicted) & 255;
    }
  }
  return out;
}

const noise = (length: number, seed: number) => {
  const next = random(seed);
  return Uint8Array.from({ length }, () => Math.floor(next() * 256));
};

describe("unpredict", () => {
  const columns = 13;
  const rows = 9;
  for (const colors of [1, 3]) {
    it(`reverses every PNG row filter (${colors} component${colors === 1 ? "" : "s"})`, () => {
      const raw = noise(columns * colors * rows, 7 + colors);
      const filtered = filterRows(raw, columns * colors, rows, colors, [0, 1, 2, 3, 4]);
      expect(unpredict(filtered, 15, columns, colors, 8, rows)).toEqual(raw);
    });
  }

  it("reverses the TIFF predictor", () => {
    const raw = noise(columns * 3 * rows, 3);
    const encoded = raw.slice();
    for (let r = 0; r < rows; r += 1) {
      for (let i = 3 * columns - 1; i >= 3; i -= 1) encoded[r * 3 * columns + i] = ((raw[r * 3 * columns + i] as number) - (raw[r * 3 * columns + i - 3] as number)) & 255;
    }
    expect(unpredict(encoded, 2, columns, 3, 8, rows)).toEqual(raw);
  });

  it("passes data through when there is no predictor, and refuses what it cannot handle", () => {
    const raw = noise(columns * rows, 1);
    expect(unpredict(raw, 1, columns, 1, 8, rows)).toEqual(raw);
    expect(unpredict(raw, 15, columns, 1, 16, rows)).toBeNull(); // 16 bits per component
    expect(unpredict(raw.subarray(0, 20), 15, columns, 1, 8, rows)).toBeNull(); // truncated
    const bad = filterRows(raw, columns, rows, 1, [1]);
    bad[0] = 9; // unknown filter tag
    expect(unpredict(bad, 15, columns, 1, 8, rows)).toBeNull();
  });
});

describe("predictRows", () => {
  it("round-trips through unpredict and shrinks smooth data", () => {
    const width = 64;
    const height = 48;
    const raw = packComponents(photoPixels(width, height, 5), width * height, 3);
    const filtered = predictRows(raw, width * 3, height, 3);
    expect(filtered.length).toBe((width * 3 + 1) * height);
    expect(unpredict(filtered, 15, width, 3, 8, height)).toEqual(raw);
  });

  it("picks filters that make a gradient far easier to compress", () => {
    const width = 100;
    const height = 100;
    const raw = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) raw[y * width + x] = x + y;
    const filtered = predictRows(raw, width, height, 1);
    let unfilteredEnergy = 0;
    let filteredEnergy = 0;
    for (let i = 0; i < raw.length; i += 1) unfilteredEnergy += raw[i] as number;
    for (let r = 0; r < height; r += 1) for (let i = 1; i <= width; i += 1) filteredEnergy += Math.min(filtered[r * (width + 1) + i] as number, 256 - (filtered[r * (width + 1) + i] as number));
    expect(filteredEnergy).toBeLessThan(unfilteredEnergy / 20);
  });
});

describe("resizeArea", () => {
  const solid = (width: number, height: number, rgb: [number, number, number]) => {
    const out = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < width * height; p += 1) out.set([rgb[0], rgb[1], rgb[2], 255], p * 4);
    return out;
  };

  it("averages each block when shrinking by a whole factor", () => {
    // 4x2 image: left 2x2 block is (0,0,0), right 2x2 block is (200,100,50)
    const src = new Uint8ClampedArray(4 * 2 * 4);
    for (let y = 0; y < 2; y += 1) for (let x = 0; x < 4; x += 1) src.set(x < 2 ? [0, 0, 0, 255] : [200, 100, 50, 255], (y * 4 + x) * 4);
    const out = resizeArea(src, 4, 2, 2, 1);
    expect(Array.from(out)).toEqual([0, 0, 0, 255, 200, 100, 50, 255]);

    // a checkerboard of 0 and 100 averages to 50
    const board = new Uint8ClampedArray(2 * 2 * 4);
    [0, 100, 100, 0].forEach((value, p) => board.set([value, value, value, 255], p * 4));
    expect(Array.from(resizeArea(board, 2, 2, 1, 1))).toEqual([50, 50, 50, 255]);
  });

  it("keeps a flat colour flat at fractional scales, and never leaks the edges", () => {
    const out = resizeArea(solid(101, 77, [12, 200, 99]), 101, 77, 37, 29);
    for (let p = 0; p < 37 * 29; p += 1) expect(Array.from(out.subarray(p * 4, p * 4 + 4))).toEqual([12, 200, 99, 255]);
  });

  it("preserves overall brightness of a photograph", () => {
    const width = 300;
    const height = 200;
    const src = photoPixels(width, height, 11);
    const out = resizeArea(src, width, height, 100, 67);
    const mean = (data: Uint8ClampedArray) => {
      let sum = 0;
      for (let p = 0; p < data.length; p += 4) sum += data[p] as number;
      return sum / (data.length / 4);
    };
    expect(Math.abs(mean(out) - mean(src))).toBeLessThan(1);
  });
});

describe("looksLikePhoto", () => {
  it("tells photographs from flat graphics", () => {
    expect(looksLikePhoto(photoPixels(400, 300, 2), 400, 300, 3)).toBe(true);
    expect(looksLikePhoto(graphicPixels(400, 300), 400, 300, 3)).toBe(false);
  });

  it("judges grey images by how many tones they use", () => {
    const flat = new Uint8ClampedArray(200 * 200 * 4).fill(255);
    expect(looksLikePhoto(flat, 200, 200, 1)).toBe(false);
    const ramp = new Uint8ClampedArray(256 * 40 * 4);
    for (let y = 0; y < 40; y += 1) for (let x = 0; x < 256; x += 1) ramp.set([x, x, x, 255], (y * 256 + x) * 4);
    expect(looksLikePhoto(ramp, 256, 40, 1)).toBe(true);
  });
});

describe("packComponents / unpackToRgba", () => {
  it("round-trips grey and RGB", () => {
    const rgba = photoPixels(10, 6, 4);
    expect(Array.from(unpackToRgba(packComponents(rgba, 60, 3), 60, 3))).toEqual(Array.from(rgba));
    const grey = new Uint8Array(60).map((_, i) => i * 4);
    const rebuilt = unpackToRgba(grey, 60, 1);
    expect(Array.from(packComponents(rebuilt, 60, 1))).toEqual(Array.from(grey));
    expect(rebuilt[3]).toBe(255);
  });
});

describe("jpegFrame", () => {
  it("reads size and component count from a JPEG header", () => {
    const frame = jpegFrame(makeImage("jpeg", 37, 21));
    expect(frame).toMatchObject({ width: 37, height: 21, precision: 8 });
    expect([1, 3]).toContain(frame?.components);
  });

  it("returns null for anything that is not a JPEG", () => {
    expect(jpegFrame(new Uint8Array([1, 2, 3, 4, 5, 6]))).toBeNull();
    expect(jpegFrame(makeImage("png", 10, 10))).toBeNull();
    expect(jpegFrame(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull(); // ends before any frame header
  });
});
