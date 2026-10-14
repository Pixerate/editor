// Portions ported from wordcraft/crates/docx/src/xml.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Characters XML 1.0 cannot carry (C0 controls other than tab / LF / CR,
 * lone surrogates, U+FFFE / U+FFFF). They are dropped, never escaped:
 * `&#1;` is not well-formed XML 1.0 either.
 */
const INVALID_XML_CHARS = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu;

/** Removes characters that are not allowed in XML 1.0 documents. */
export function stripInvalidXmlChars(value: string): string {
  return value.replace(INVALID_XML_CHARS, "");
}

/** Escapes text for XML element content (`&`, `<`, `>`), dropping invalid characters. */
export function escapeXmlText(value: string): string {
  return stripInvalidXmlChars(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escapes a value for a double- or single-quoted XML attribute. White space
 * other than spaces is written as character references, because attribute
 * value normalisation would otherwise turn tabs and newlines into spaces.
 */
export function escapeXmlAttr(value: string): string {
  return escapeXmlText(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;");
}

export type XmlAttrs = Record<string, string | number | undefined | null | false>;

function attrs(values: XmlAttrs | undefined): string {
  if (!values) return "";
  let out = "";
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === false) continue;
    out += ` ${name}="${escapeXmlAttr(String(value))}"`;
  }
  return out;
}

/**
 * A small string-building XML writer; every attribute value and text node is
 * escaped. Element names are trusted (always literals in this codebase).
 */
export class XmlWriter {
  private parts: string[];

  /** `declaration: false` writes a fragment (e.g. one paragraph). */
  constructor(declaration = true) {
    this.parts = declaration ? ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'] : [];
  }

  open(name: string, values?: XmlAttrs): this {
    this.parts.push(`<${name}${attrs(values)}>`);
    return this;
  }

  empty(name: string, values?: XmlAttrs): this {
    this.parts.push(`<${name}${attrs(values)}/>`);
    return this;
  }

  close(name: string): this {
    this.parts.push(`</${name}>`);
    return this;
  }

  text(value: string): this {
    this.parts.push(escapeXmlText(value));
    return this;
  }

  /** `<name attrs>text</name>`. */
  leaf(name: string, values: XmlAttrs | undefined, text: string): this {
    return this.open(name, values).text(text).close(name);
  }

  /** `<name w:val="value"/>`. */
  val(name: string, value: string | number): this {
    return this.empty(name, { "w:val": value });
  }

  /** Appends markup produced by another writer. */
  raw(markup: string): this {
    this.parts.push(markup);
    return this;
  }

  toString(): string {
    return this.parts.join("");
  }
}
