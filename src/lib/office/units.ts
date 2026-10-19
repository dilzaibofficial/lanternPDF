/** Unit conversions for Office files. Everything in the PDF is in points (1/72 inch). */

/** Word measures lengths in twips (twentieths of a point). */
export const twipsToPt = (twips: number): number => twips / 20;

/** DrawingML measures lengths in EMU (English Metric Units): 12,700 per point. */
export const emuToPt = (emu: number): number => emu / 12700;

/** Font sizes in Word are in half-points. */
export const halfPointsToPt = (value: number): number => value / 2;

/** Border widths in Word are in eighths of a point. */
export const eighthsToPt = (value: number): number => value / 8;

/** DrawingML font sizes are in hundredths of a point. */
export const hundredthsToPt = (value: number): number => value / 100;

/** Excel column widths count "characters of the default font"; one character is about 7 pixels, plus 5 pixels of padding. */
export const excelColumnWidthToPt = (characters: number, maxDigitWidthPx = 7): number => {
  const pixels = Math.trunc(((256 * characters + Math.trunc(128 / maxDigitWidthPx)) / 256) * maxDigitWidthPx);
  return (pixels * 72) / 96;
};

export const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
