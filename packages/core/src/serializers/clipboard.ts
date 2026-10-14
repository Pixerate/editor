import { Slice, type Schema } from "@tiptap/pm/model";

/**
 * Custom clipboard MIME type for content copied from a @pixerate/editor
 * rich-text editor. It carries the ProseMirror slice as JSON so pasting back
 * into a compatible editor is lossless (no HTML round trip).
 */
export const PIXERATE_DOCUMENT_MIME = "application/x.pixerate.document+json";

/** Payload written under {@link PIXERATE_DOCUMENT_MIME}. */
export interface RichClipboardPayload {
  version: 1;
  /** {@link getSchemaSignature} of the source editor's schema. */
  schema: string;
  /** `Slice.toJSON()` of the copied selection. */
  slice: { content?: unknown[]; openStart?: number; openEnd?: number } | null;
}

const signatureCache = new WeakMap<Schema, string>();

/** 32-bit FNV-1a, enough to tell schemas apart without a crypto dependency. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Returns a stable signature for a ProseMirror schema: node names, content
 * expressions, groups, attribute names and mark names. Two editors with the
 * same extensions produce the same signature, so a slice copied from one can
 * be deserialized in the other without losing or rejecting nodes.
 */
export function getSchemaSignature(schema: Schema): string {
  const cached = signatureCache.get(schema);
  if (cached) return cached;
  const parts: string[] = [];
  for (const [name, type] of Object.entries(schema.nodes)) {
    const spec = type.spec;
    parts.push(
      `n:${name}|${spec.content ?? ""}|${spec.group ?? ""}|${spec.marks ?? ""}|${Object.keys(type.spec.attrs ?? {}).sort().join(",")}`,
    );
  }
  for (const [name, type] of Object.entries(schema.marks)) {
    parts.push(`m:${name}|${Object.keys(type.spec.attrs ?? {}).sort().join(",")}`);
  }
  const signature = `pm1-${fnv1a(parts.join(";"))}`;
  signatureCache.set(schema, signature);
  return signature;
}

/** Serializes a slice into the {@link PIXERATE_DOCUMENT_MIME} payload string. */
export function serializeRichClipboardPayload(slice: Slice, schema: Schema): string {
  const payload: RichClipboardPayload = {
    version: 1,
    schema: getSchemaSignature(schema),
    slice: slice.toJSON(),
  };
  return JSON.stringify(payload);
}

/**
 * Parses a {@link PIXERATE_DOCUMENT_MIME} payload into a slice for `schema`.
 * Returns `null` (so callers fall back to HTML / plain text) when the payload
 * is malformed, from another payload version, or from an editor whose schema
 * signature differs.
 */
export function parseRichClipboardPayload(data: string | null | undefined, schema: Schema): Slice | null {
  if (!data) return null;
  try {
    const payload = JSON.parse(data) as Partial<RichClipboardPayload>;
    if (!payload || payload.version !== 1) return null;
    if (payload.schema !== getSchemaSignature(schema)) return null;
    if (!payload.slice) return null;
    return Slice.fromJSON(schema, payload.slice as any);
  } catch {
    return null;
  }
}

/** Minimal clipboard data surface (`DataTransfer`). */
export interface ClipboardDataLike {
  getData(format: string): string;
  setData(format: string, data: string): void;
  clearData?(format?: string): void;
}

/**
 * Returns the `clipboardData` of a native `ClipboardEvent` or of a React
 * synthetic clipboard event (which wraps the native event in `nativeEvent`).
 */
export function getClipboardData(event: unknown): ClipboardDataLike | null {
  if (!event || typeof event !== "object") return null;
  const native = "nativeEvent" in event ? (event as any).nativeEvent : event;
  return ((event as any).clipboardData ?? native?.clipboardData ?? null) as ClipboardDataLike | null;
}

/**
 * Reads a slice from a paste event's {@link PIXERATE_DOCUMENT_MIME} data.
 * Returns `null` when the data is missing or its schema does not match.
 */
export function readRichClipboard(
  event: unknown,
  schema: Schema,
  mimeType: string = PIXERATE_DOCUMENT_MIME,
): Slice | null {
  const data = getClipboardData(event);
  if (!data) return null;
  let raw: string | undefined;
  try {
    raw = data.getData(mimeType);
  } catch {
    return null;
  }
  return parseRichClipboardPayload(raw, schema);
}
