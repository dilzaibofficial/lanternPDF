import type { OfficePackage } from "./package";
import { kid } from "./xml";

export interface Theme {
  /** Colour scheme entries by name: dk1, lt1, dk2, lt2, accent1..6, hlink, folHlink. Hex like "#1f2937". */
  colors: Record<string, string>;
  /** Heading and body fonts (the theme's Latin typefaces). */
  major?: string;
  minor?: string;
}

/** Reads the document theme (colours and fonts) from the first theme part under `prefix`, e.g. "word/theme/". */
export function readTheme(pack: OfficePackage, prefix: string): Theme {
  const theme: Theme = { colors: {} };
  const part = pack.list(prefix).find((name) => name.endsWith(".xml"));
  const root = part ? pack.xml(part) : undefined;
  const elements = kid(root, "a:themeElements");
  const scheme = kid(elements, "a:clrScheme");
  for (const child of scheme?.children ?? []) {
    if (typeof child === "string") continue;
    const key = child.name.replace("a:", "");
    const value = kid(child, "a:srgbClr")?.attrs.val ?? kid(child, "a:sysClr")?.attrs.lastClr;
    if (value && /^[0-9a-fA-F]{6}$/.test(value)) theme.colors[key] = `#${value.toLowerCase()}`;
  }
  const fonts = kid(elements, "a:fontScheme");
  theme.major = kid(kid(fonts, "a:majorFont"), "a:latin")?.attrs.typeface || undefined;
  theme.minor = kid(kid(fonts, "a:minorFont"), "a:latin")?.attrs.typeface || undefined;
  return theme;
}

function channel(hex: string, start: number): number {
  return Number.parseInt(hex.slice(start, start + 2), 16);
}

const toHex = (value: number): string => Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, "0");

/**
 * Lightens (tint > 0) or darkens (tint < 0) a colour by a fraction, the way spreadsheets apply a theme "tint". The
 * adjustment is made in HSL lightness, which is what Excel does.
 */
export function tintColor(hex: string, tint: number): string {
  const clean = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean) || tint === 0) return `#${clean}`;
  const r = channel(clean, 0) / 255;
  const g = channel(clean, 2) / 255;
  const b = channel(clean, 4) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const hue = (p: number, q: number, t0: number) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let out: [number, number, number];
  if (s === 0) {
    out = [l, l, l];
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    out = [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
  }
  return `#${out.map((v) => toHex(v * 255)).join("")}`;
}
