/** Bytes to a string, one char per byte (ISO-8859-1). Safe for any bytes; for ASCII signatures and headers. */
export function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  const stop = Math.min(end, bytes.length);
  let out = "";
  // Chunked so very large inputs cannot overflow the call stack of String.fromCharCode.
  for (let i = start; i < stop; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, stop)));
  }
  return out;
}

/** Standard base64 of any bytes. */
export function toBase64(bytes: Uint8Array): string {
  return btoa(latin1(bytes));
}

/** Index of `needle` (ASCII) in `bytes`, or -1. */
export function indexOfAscii(bytes: Uint8Array, needle: string, from = 0): number {
  const length = needle.length;
  outer: for (let i = from; i <= bytes.length - length; i += 1) {
    for (let j = 0; j < length; j += 1) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}
