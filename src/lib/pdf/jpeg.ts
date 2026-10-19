export interface JpegFrame {
  /** Bits per sample (8 for everything a PDF reader decodes). */
  precision: number;
  width: number;
  height: number;
  /** 1 = grey, 3 = colour, 4 = CMYK. */
  components: number;
}

/**
 * Reads a JPEG's frame header: its size and how many colour components it stores. Returns null when
 * the file is not a JPEG or the header cannot be found, so callers can decline to touch it.
 */
export function jpegFrame(bytes: Uint8Array): JpegFrame | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] as number;
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    // Stand-alone markers have no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan: no frame header seen
    const length = ((bytes[offset + 2] as number) << 8) | (bytes[offset + 3] as number);
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 10 > bytes.length) return null;
      return {
        precision: bytes[offset + 4] as number,
        height: ((bytes[offset + 5] as number) << 8) | (bytes[offset + 6] as number),
        width: ((bytes[offset + 7] as number) << 8) | (bytes[offset + 8] as number),
        components: bytes[offset + 9] as number,
      };
    }
    offset += 2 + length;
  }
  return null;
}
