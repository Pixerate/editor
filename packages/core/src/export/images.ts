/** Image types Word displays without a fallback, by MIME type → file extension. */
export const DOCX_IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/webp": "webp",
  "image/tiff": "tiff",
};

/** Content types of the image extensions above. */
export const DOCX_IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  tiff: "image/tiff",
};

export interface DecodedDataUrl {
  mime: string;
  bytes: Uint8Array;
}

/** Largest data URL decoded (characters), so a huge attribute cannot exhaust memory twice. */
const MAX_DATA_URL = 64 * 1024 * 1024;

/** Decodes a base64 `data:` URL. Returns `null` for anything else or malformed input. */
export function decodeDataUrl(src: string): DecodedDataUrl | null {
  if (src.length > MAX_DATA_URL) return null;
  const comma = src.indexOf(",");
  if (comma === -1) return null;
  const header = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)((?:;[a-z0-9-]+=[^;,]*)*);base64$/i.exec(src.slice(0, comma));
  if (!header) return null;
  const payload = src.slice(comma + 1).replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null;
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { mime: header[1].toLowerCase(), bytes };
  } catch {
    return null;
  }
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const i32le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);

/** Pixel size read from a PNG, GIF, JPEG, BMP or WebP header, or `null`. */
export function imagePixelSize(b: Uint8Array): { width: number; height: number } | null {
  const ok = (width: number, height: number) =>
    width > 0 && height > 0 && width < 1e6 && height < 1e6 ? { width, height } : null;
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return ok(u32be(b, 16), u32be(b, 20));
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return ok(u16le(b, 6), u16le(b, 8));
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) return ok(Math.abs(i32le(b, 18)), Math.abs(i32le(b, 22)));
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === "VP8 ") return ok(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
    if (chunk === "VP8L") {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (chunk === "VP8X") return ok((b[24] | (b[25] << 8) | (b[26] << 16)) + 1, (b[27] | (b[28] << 8) | (b[29] << 16)) + 1);
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the JPEG segments to the first start-of-frame marker.
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const length = u16be(b, i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return ok(u16be(b, i + 7), u16be(b, i + 5));
      }
      if (length < 2) return null;
      i += 2 + length;
    }
  }
  return null;
}

/** A CSS pixel size from a node attribute (`320`, `"320"`, `"320px"`), or `undefined`. */
export function pixelAttr(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/i.exec(value);
  return match ? Number(match[1]) || undefined : undefined;
}
