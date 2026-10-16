/**
 * Works out an uploaded photo's real type from its first bytes, so a file
 * isn't trusted on its declared Content-Type. Only the photo types customers'
 * phones and cameras produce: JPEG, PNG, WebP and HEIC/HEIF.
 */
export type SniffedImageType =
  "image/jpeg" | "image/png" | "image/webp" | "image/heic";

const HEIC_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "mif1",
  "msf1",
]);

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

export function sniffImageType(
  data: ArrayBuffer | Uint8Array,
): SniffedImageType | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (b, i) => bytes[i] === b,
    )
  )
    return "image/png";
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  )
    return "image/webp";
  if (
    bytes.length >= 12 &&
    ascii(bytes, 4, 4) === "ftyp" &&
    HEIC_BRANDS.has(ascii(bytes, 8, 4))
  )
    return "image/heic";
  return null;
}
