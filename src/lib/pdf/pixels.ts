/** Pixel-level helpers for re-encoding images inside PDFs. Pure functions on typed arrays. */

/**
 * Undoes a PDF/PNG predictor on decoded Flate data. `predictor` 2 is the TIFF predictor, 10 to 15 are the
 * PNG row filters (the tag in each row says which one was used). Only 8 bits per component are handled;
 * anything else returns null so the caller leaves the image alone.
 */
export function unpredict(data: Uint8Array, predictor: number, columns: number, colors: number, bits: number, rows: number): Uint8Array | null {
  if (bits !== 8 || columns < 1 || colors < 1) return null;
  const rowBytes = columns * colors;
  if (predictor === 1) return data.length >= rowBytes * rows ? data : null;

  if (predictor === 2) {
    if (data.length < rowBytes * rows) return null;
    const out = data.slice(0, rowBytes * rows);
    for (let r = 0; r < rows; r += 1) {
      const start = r * rowBytes;
      for (let i = colors; i < rowBytes; i += 1) out[start + i] = ((out[start + i] as number) + (out[start + i - colors] as number)) & 255;
    }
    return out;
  }

  if (predictor < 10 || predictor > 15) return null;
  const stride = rowBytes + 1;
  if (data.length < stride * rows) return null;
  const bpp = colors; // bytes per pixel at 8 bits
  const out = new Uint8Array(rowBytes * rows);
  for (let r = 0; r < rows; r += 1) {
    const tag = data[r * stride] as number;
    const src = r * stride + 1;
    const dst = r * rowBytes;
    const prev = dst - rowBytes;
    for (let i = 0; i < rowBytes; i += 1) {
      const raw = data[src + i] as number;
      const left = i >= bpp ? (out[dst + i - bpp] as number) : 0;
      const up = r > 0 ? (out[prev + i] as number) : 0;
      let value: number;
      switch (tag) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + ((left + up) >> 1);
          break;
        case 4:
          value = raw + paeth(left, up, r > 0 && i >= bpp ? (out[prev + i - bpp] as number) : 0);
          break;
        default:
          return null;
      }
      out[dst + i] = value & 255;
    }
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Applies PNG row filters to raw pixel rows, choosing for each row the filter whose output has the
 * smallest sum of absolute values (the usual heuristic, which makes the Flate stream much smaller than
 * the unfiltered rows). The result is for use with `/Predictor 15`.
 */
export function predictRows(raw: Uint8Array, rowBytes: number, rows: number, bpp: number): Uint8Array {
  const out = new Uint8Array((rowBytes + 1) * rows);
  const candidates = [0, 1, 2, 3, 4].map(() => new Uint8Array(rowBytes));
  for (let r = 0; r < rows; r += 1) {
    const start = r * rowBytes;
    const prevStart = start - rowBytes;
    let best = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let filter = 0; filter < 5; filter += 1) {
      const candidate = candidates[filter] as Uint8Array;
      let score = 0;
      for (let i = 0; i < rowBytes; i += 1) {
        const left = i >= bpp ? (raw[start + i - bpp] as number) : 0;
        const up = r > 0 ? (raw[prevStart + i] as number) : 0;
        let predicted: number;
        switch (filter) {
          case 0:
            predicted = 0;
            break;
          case 1:
            predicted = left;
            break;
          case 2:
            predicted = up;
            break;
          case 3:
            predicted = (left + up) >> 1;
            break;
          default:
            predicted = paeth(left, up, r > 0 && i >= bpp ? (raw[prevStart + i - bpp] as number) : 0);
        }
        const value = ((raw[start + i] as number) - predicted) & 255;
        candidate[i] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        best = filter;
      }
    }
    out[r * (rowBytes + 1)] = best;
    out.set(candidates[best] as Uint8Array, r * (rowBytes + 1) + 1);
  }
  return out;
}

/**
 * Shrinks an RGBA image by averaging every source pixel that falls inside each destination pixel
 * (a box filter with fractional coverage). That is the right filter for reducing a scan or a photo:
 * it keeps thin lines and text legible where simply dropping pixels would shatter them.
 */
export function resizeArea(rgba: Uint8ClampedArray, width: number, height: number, newWidth: number, newHeight: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(newWidth * newHeight * 4);
  const xScale = width / newWidth;
  const yScale = height / newHeight;
  const norm = 1 / (xScale * yScale);
  const acc = new Float64Array(newWidth * 4);

  // Source column span and weights for each destination column, worked out once.
  const first = new Int32Array(newWidth);
  const last = new Int32Array(newWidth);
  for (let dx = 0; dx < newWidth; dx += 1) {
    first[dx] = Math.floor(dx * xScale);
    last[dx] = Math.min(width, Math.ceil((dx + 1) * xScale));
  }

  for (let dy = 0; dy < newHeight; dy += 1) {
    acc.fill(0);
    const y0 = dy * yScale;
    const y1 = Math.min(height, (dy + 1) * yScale);
    for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy += 1) {
      const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
      if (wy <= 0) continue;
      const row = sy * width * 4;
      for (let dx = 0; dx < newWidth; dx += 1) {
        const x0 = dx * xScale;
        const x1 = Math.min(width, (dx + 1) * xScale);
        let r = 0;
        let g = 0;
        let b = 0;
        for (let sx = first[dx] as number; sx < (last[dx] as number); sx += 1) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (wx <= 0) continue;
          const i = row + sx * 4;
          r += (rgba[i] as number) * wx;
          g += (rgba[i + 1] as number) * wx;
          b += (rgba[i + 2] as number) * wx;
        }
        const a = dx * 4;
        acc[a] = (acc[a] as number) + r * wy;
        acc[a + 1] = (acc[a + 1] as number) + g * wy;
        acc[a + 2] = (acc[a + 2] as number) + b * wy;
      }
    }
    const rowOut = dy * newWidth * 4;
    for (let dx = 0; dx < newWidth; dx += 1) {
      const a = dx * 4;
      out[rowOut + a] = Math.round((acc[a] as number) * norm);
      out[rowOut + a + 1] = Math.round((acc[a + 1] as number) * norm);
      out[rowOut + a + 2] = Math.round((acc[a + 2] as number) * norm);
      out[rowOut + a + 3] = 255;
    }
  }
  return out;
}

/**
 * Guesses whether an image is a photograph or scan (many different tones: JPEG suits it) rather than
 * flat graphics (few tones: lossless Flate suits it better, and JPEG would blur the edges).
 * Looks at about 16,000 evenly spread pixels.
 */
export function looksLikePhoto(rgba: Uint8ClampedArray, width: number, height: number, components: 1 | 3): boolean {
  const total = width * height;
  const step = Math.max(1, Math.floor(total / 16384));
  const seen = new Set<number>();
  let samples = 0;
  for (let pixel = 0; pixel < total; pixel += step) {
    const i = pixel * 4;
    seen.add(components === 1 ? (rgba[i] as number) : ((rgba[i] as number) << 16) | ((rgba[i + 1] as number) << 8) | (rgba[i + 2] as number));
    samples += 1;
  }
  // A grey image has at most 256 tones, so count them; colour is judged by how varied the sample is.
  return components === 1 ? seen.size >= 48 : seen.size / samples > 0.12;
}

/** Packs RGBA down to `components` bytes per pixel (grey takes the red channel, which equals the others). */
export function packComponents(rgba: Uint8ClampedArray, pixels: number, components: 1 | 3): Uint8Array {
  const out = new Uint8Array(pixels * components);
  if (components === 1) {
    for (let p = 0; p < pixels; p += 1) out[p] = rgba[p * 4] as number;
  } else {
    for (let p = 0; p < pixels; p += 1) {
      out[p * 3] = rgba[p * 4] as number;
      out[p * 3 + 1] = rgba[p * 4 + 1] as number;
      out[p * 3 + 2] = rgba[p * 4 + 2] as number;
    }
  }
  return out;
}

/** Expands `components` bytes per pixel into opaque RGBA. */
export function unpackToRgba(data: Uint8Array, pixels: number, components: 1 | 3): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels * 4);
  for (let p = 0; p < pixels; p += 1) {
    if (components === 1) {
      const v = data[p] as number;
      out[p * 4] = v;
      out[p * 4 + 1] = v;
      out[p * 4 + 2] = v;
    } else {
      out[p * 4] = data[p * 3] as number;
      out[p * 4 + 1] = data[p * 3 + 1] as number;
      out[p * 4 + 2] = data[p * 3 + 2] as number;
    }
    out[p * 4 + 3] = 255;
  }
  return out;
}
