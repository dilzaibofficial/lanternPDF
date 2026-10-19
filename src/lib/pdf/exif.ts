/**
 * Reads the EXIF orientation of a JPEG (1 to 8; 1 means "as stored").
 *
 * Phone cameras store photos in the sensor's orientation and add an EXIF tag saying how to rotate
 * them. Browsers honour the tag, PDF viewers do not, so a JPEG embedded as-is would appear sideways.
 */
export function jpegOrientation(bytes: Uint8Array): number {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) return 1;
    const marker = bytes[offset + 1] as number;
    // Stand-alone markers have no length field.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return 1; // start of scan / end of image: no EXIF before this
    const length = ((bytes[offset + 2] as number) << 8) | (bytes[offset + 3] as number);
    if (marker === 0xe1 && isExif(bytes, offset + 4)) {
      return readOrientation(bytes, offset + 10, offset + 2 + length);
    }
    offset += 2 + length;
  }
  return 1;
}

function isExif(bytes: Uint8Array, at: number): boolean {
  return bytes[at] === 0x45 && bytes[at + 1] === 0x78 && bytes[at + 2] === 0x69 && bytes[at + 3] === 0x66 && bytes[at + 4] === 0 && bytes[at + 5] === 0;
}

function readOrientation(bytes: Uint8Array, tiff: number, end: number): number {
  const little = bytes[tiff] === 0x49; // "II" = little-endian, "MM" = big-endian
  const u16 = (at: number) => (little ? (bytes[at] as number) | ((bytes[at + 1] as number) << 8) : ((bytes[at] as number) << 8) | (bytes[at + 1] as number));
  const u32 = (at: number) =>
    little
      ? ((bytes[at] as number) | ((bytes[at + 1] as number) << 8) | ((bytes[at + 2] as number) << 16) | ((bytes[at + 3] as number) << 24)) >>> 0
      : (((bytes[at] as number) << 24) | ((bytes[at + 1] as number) << 16) | ((bytes[at + 2] as number) << 8) | (bytes[at + 3] as number)) >>> 0;

  if (tiff + 8 > end || u16(tiff + 2) !== 0x2a) return 1;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const entries = u16(ifd);
  for (let i = 0; i < entries; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return 1;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}
