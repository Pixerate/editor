// Portions ported from wordcraft/crates/doc/src/styles.rs and wordcraft/crates/doc/src/resolve.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/** Paragraph styles format whole blocks; character styles format runs of text. */
export type StyleKind = "paragraph" | "character";

/** Character formatting of a style (CSS values). */
export interface CharacterFormat {
  fontFamily?: string;
  /** CSS length, e.g. `"1.5em"` or `"18px"`. */
  fontSize?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  backgroundColor?: string;
  letterSpacing?: string;
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
  smallCaps?: boolean;
}

/** Paragraph formatting of a style (CSS values). */
export interface ParagraphFormat {
  textAlign?: "left" | "center" | "right" | "justify";
  lineHeight?: string;
  spaceBefore?: string;
  spaceAfter?: string;
  indentLeft?: string;
  indentRight?: string;
  indentFirstLine?: string;
  /** CSS border shorthand, e.g. `"3px solid currentColor"`. */
  borderLeft?: string;
  paddingLeft?: string;
  backgroundColor?: string;
}

/** The block node a paragraph style uses (`heading` with `level` for Heading N). */
export interface StyleBlock {
  type: string;
  attrs?: Record<string, any>;
}

export interface StyleDefinition {
  /** Stable id (`Heading1`): letters, digits, `_` and `-`, starting with a letter. */
  id: string;
  /** Display name (`Heading 1`). */
  name: string;
  kind: StyleKind;
  /** Style this one inherits from; what it sets wins over its base. */
  basedOn?: string | null;
  /** Style of the paragraph after this one when Enter is pressed at its end (paragraph styles). */
  next?: string | null;
  /** Linked style: a paragraph style's character style, or a character style's paragraph style. */
  linked?: string | null;
  paragraph?: ParagraphFormat;
  character?: CharacterFormat;
  /** Block node of a paragraph style. Inherited along `basedOn`; `paragraph` by default. */
  block?: StyleBlock | null;
  /** Gallery order (lower first). */
  priority?: number;
  /** Shown in the styles gallery. */
  quick?: boolean;
  hidden?: boolean;
  /** Built in (cannot be removed). */
  builtin?: boolean;
}

/** A style with its `basedOn` chain and the defaults merged. */
export interface ResolvedStyle {
  id: string;
  paragraph: ParagraphFormat;
  character: CharacterFormat;
  block: StyleBlock;
  /** Id of the style after Enter at the end of a paragraph. */
  next: string;
}

export interface StyleDefaults {
  paragraph?: ParagraphFormat;
  character?: CharacterFormat;
}

export interface StyleRegistryOptions {
  /** Styles added to (or replacing) the built-in ones. */
  styles?: readonly StyleDefinition[];
  /** Include the built-in styles. Default `true`. */
  builtins?: boolean;
  /** Document defaults, applied below every style. */
  defaults?: StyleDefaults;
}

export interface StyleRegistrySnapshot {
  styles: readonly StyleDefinition[];
  defaults: StyleDefaults;
  /** Increases on every change. */
  version: number;
}

/** Serializable registry content (`registry.toJSON()`). */
export interface StyleRegistryJSON {
  styles: StyleDefinition[];
  defaults: StyleDefaults;
}

export interface StyleCSSOptions {
  /** Selector the rules are scoped to. Default `.ProseMirror`. */
  scope?: string;
  /**
   * Element selector of blocks that use a style without naming it
   * (`data-style` absent), e.g. `h2` for Heading 2. Return `null` for none.
   */
  tagFor?: (block: StyleBlock) => string | null;
}

/** Longest `basedOn` chain followed (cycle and depth guard). */
const MAX_CHAIN = 32;
const STYLE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** CSS values that could escape a declaration or load resources are dropped. */
const UNSAFE_CSS = /[;{}<>\\]|\/\*|url\s*\(|expression\s*\(|@import|javascript:/i;

export const NORMAL_STYLE_ID = "Normal";

const PREVIEW_PROPERTIES = new Set([
  "font-family",
  "font-weight",
  "font-style",
  "color",
  "text-decoration-line",
  "text-transform",
  "letter-spacing",
  "font-variant-caps",
]);

/** Whether `id` is a valid style id. */
export function isValidStyleId(id: unknown): id is string {
  return typeof id === "string" && STYLE_ID.test(id);
}

const MUTED = "var(--pixerate-style-muted, #6b7280)";
const HEADING_SIZES = ["2em", "1.5em", "1.25em", "1.1em", "1em", "0.9em"];

function builtinStyles(): StyleDefinition[] {
  const styles: StyleDefinition[] = [
    {
      id: NORMAL_STYLE_ID,
      name: "Normal",
      kind: "paragraph",
      block: { type: "paragraph" },
      priority: 0,
      quick: true,
      builtin: true,
    },
    {
      id: "Title",
      name: "Title",
      kind: "paragraph",
      basedOn: NORMAL_STYLE_ID,
      next: NORMAL_STYLE_ID,
      linked: "TitleChar",
      paragraph: { spaceAfter: "0.25em", lineHeight: "1.15" },
      character: { fontSize: "2.5em", bold: true, letterSpacing: "-0.01em" },
      priority: 10,
      quick: true,
      builtin: true,
    },
    {
      id: "Subtitle",
      name: "Subtitle",
      kind: "paragraph",
      basedOn: NORMAL_STYLE_ID,
      next: NORMAL_STYLE_ID,
      linked: "SubtitleChar",
      paragraph: { spaceAfter: "0.75em" },
      character: { fontSize: "1.25em", color: MUTED },
      priority: 11,
      quick: true,
      builtin: true,
    },
  ];
  HEADING_SIZES.forEach((fontSize, i) => {
    const level = i + 1;
    styles.push({
      id: `Heading${level}`,
      name: `Heading ${level}`,
      kind: "paragraph",
      basedOn: NORMAL_STYLE_ID,
      next: NORMAL_STYLE_ID,
      linked: `Heading${level}Char`,
      block: { type: "heading", attrs: { level } },
      paragraph: { spaceBefore: level <= 2 ? "1em" : "0.75em", spaceAfter: "0.25em" },
      character: { fontSize, bold: true },
      priority: 11 + level,
      quick: level <= 3,
      builtin: true,
    });
  });
  styles.push(
    {
      id: "Quote",
      name: "Quote",
      kind: "paragraph",
      basedOn: NORMAL_STYLE_ID,
      next: NORMAL_STYLE_ID,
      linked: "QuoteChar",
      paragraph: { indentLeft: "1em", paddingLeft: "0.75em", borderLeft: "3px solid currentColor" },
      character: { italic: true, color: MUTED },
      priority: 29,
      quick: true,
      builtin: true,
    },
    {
      id: "Code",
      name: "Code",
      kind: "paragraph",
      basedOn: NORMAL_STYLE_ID,
      next: NORMAL_STYLE_ID,
      block: { type: "codeBlock" },
      character: {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: "0.9em",
      },
      priority: 30,
      quick: true,
      builtin: true,
    },
    {
      id: "ListParagraph",
      name: "List Paragraph",
      kind: "paragraph",
      basedOn: NORMAL_STYLE_ID,
      paragraph: { indentLeft: "2em" },
      priority: 34,
      quick: true,
      builtin: true,
    },
  );
  // Linked character styles: their formatting is the paragraph style's.
  const linked = ["Title", "Subtitle", "Quote", ...HEADING_SIZES.map((_, i) => `Heading${i + 1}`)];
  linked.forEach((paragraphId) => {
    const name = styles.find((s) => s.id === paragraphId)!.name;
    styles.push({
      id: `${paragraphId}Char`,
      name: `${name} Char`,
      kind: "character",
      linked: paragraphId,
      priority: 99,
      hidden: true,
      builtin: true,
    });
  });
  styles.push(
    {
      id: "Emphasis",
      name: "Emphasis",
      kind: "character",
      character: { italic: true },
      priority: 20,
      quick: true,
      builtin: true,
    },
    {
      id: "Strong",
      name: "Strong",
      kind: "character",
      character: { bold: true },
      priority: 22,
      quick: true,
      builtin: true,
    },
  );
  return styles;
}

/** The built-in styles: Normal, Title, Subtitle, Heading 1–6, Quote, Code, List Paragraph and character styles. */
export const DEFAULT_STYLES: readonly StyleDefinition[] = Object.freeze(builtinStyles());

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

/** Copies only defined values of `patch` over `base`. */
function overlay<T extends object>(base: T, patch: T | undefined | null): T {
  if (!patch) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  Object.entries(patch).forEach(([key, value]) => {
    if (value !== undefined && value !== null) out[key] = value;
  });
  return out as T;
}

function sameBlock(a: StyleBlock, type: string, attrs: Record<string, any>): boolean {
  if (a.type !== type) return false;
  return Object.entries(a.attrs ?? {}).every(([key, value]) => attrs[key] === value);
}

/**
 * Style definitions with `basedOn` inheritance, next-style and linked
 * character/paragraph styles, resolved in cascade order: document defaults →
 * style chain (base first) → direct formatting. Chains are cycle-safe.
 *
 * `subscribe` calls the listener immediately and on every change (Svelte
 * store contract); `getSnapshot` is stable between changes.
 */
export class StyleRegistry {
  private styles = new Map<string, StyleDefinition>();
  private defaults: StyleDefaults;
  private version = 0;
  private snapshot: StyleRegistrySnapshot | null = null;
  private listeners = new Set<(snapshot: StyleRegistrySnapshot) => void>();

  constructor(options: StyleRegistryOptions = {}) {
    this.defaults = clone(options.defaults ?? {});
    if (options.builtins !== false) DEFAULT_STYLES.forEach((style) => this.styles.set(style.id, clone(style)));
    (options.styles ?? []).forEach((style) => this.put(style));
  }

  // -- Reading --------------------------------------------------------------

  get(id: string | null | undefined): StyleDefinition | undefined {
    return id ? this.styles.get(id) : undefined;
  }

  /** Finds a style by id or display name (case-insensitive). */
  find(nameOrId: string): StyleDefinition | undefined {
    const direct = this.styles.get(nameOrId);
    if (direct) return direct;
    const lower = nameOrId.toLowerCase();
    return this.list().find((style) => style.name.toLowerCase() === lower);
  }

  /** All styles (optionally of one kind) in gallery order. */
  list(kind?: StyleKind): StyleDefinition[] {
    return Array.from(this.styles.values())
      .filter((style) => !kind || style.kind === kind)
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99) || a.name.localeCompare(b.name));
  }

  /** Styles shown in the gallery (`quick`, not hidden), paragraph styles by default. */
  gallery(kind: StyleKind = "paragraph"): StyleDefinition[] {
    return this.list(kind).filter((style) => style.quick && !style.hidden);
  }

  /** The `basedOn` chain from the root style down to `id` (cycle-safe, bounded). */
  chain(id: string): StyleDefinition[] {
    const out: StyleDefinition[] = [];
    let current = this.styles.get(id);
    while (current && out.length < MAX_CHAIN && !out.includes(current)) {
      out.push(current);
      current = current.basedOn ? this.styles.get(current.basedOn) : undefined;
    }
    return out.reverse();
  }

  /**
   * Resolves a paragraph style: defaults, then each style of the chain (base
   * first). Unknown ids resolve to the defaults in a `paragraph` block.
   */
  resolve(id: string): ResolvedStyle {
    let paragraph = overlay<ParagraphFormat>({}, this.defaults.paragraph);
    let character = overlay<CharacterFormat>({}, this.defaults.character);
    let block: StyleBlock = { type: "paragraph" };
    this.chain(id).forEach((style) => {
      if (style.kind !== "paragraph") return;
      paragraph = overlay(paragraph, style.paragraph);
      character = overlay(character, style.character);
      if (style.block) block = clone(style.block);
    });
    return { id, paragraph, character, block, next: this.nextStyleId(id) };
  }

  /** Character formatting a paragraph style's chain sets (without defaults). */
  private paragraphCharacter(id: string): CharacterFormat {
    let character: CharacterFormat = {};
    this.chain(id).forEach((style) => {
      if (style.kind === "paragraph") character = overlay(character, style.character);
    });
    return character;
  }

  /**
   * Character formatting of a character style's chain. A style linked to a
   * paragraph style takes that style's character formatting first.
   */
  resolveCharacterStyle(id: string): CharacterFormat {
    let character: CharacterFormat = {};
    this.chain(id).forEach((style) => {
      if (style.kind === "character" && style.linked && this.get(style.linked)?.kind === "paragraph") {
        character = overlay(character, this.paragraphCharacter(style.linked));
      }
      character = overlay(character, style.character);
    });
    return character;
  }

  /**
   * Character formatting of text: defaults → paragraph style chain →
   * character style chain → direct formatting.
   */
  resolveText(input: {
    paragraphStyle?: string | null;
    characterStyle?: string | null;
    direct?: CharacterFormat;
  }): CharacterFormat {
    let character = this.resolve(input.paragraphStyle || NORMAL_STYLE_ID).character;
    if (input.characterStyle) character = overlay(character, this.resolveCharacterStyle(input.characterStyle));
    return overlay(character, input.direct);
  }

  /** The style after Enter at the end of a paragraph of `id` (itself when unset or unknown). */
  nextStyleId(id: string): string {
    const next = this.styles.get(id)?.next;
    return next && this.styles.get(next)?.kind === "paragraph" ? next : id;
  }

  /** The linked character style of a paragraph style, if any. */
  linkedCharacterStyle(id: string): StyleDefinition | undefined {
    const style = this.styles.get(id);
    const linked = style?.linked ? this.styles.get(style.linked) : undefined;
    return style?.kind === "paragraph" && linked?.kind === "character" ? linked : undefined;
  }

  /**
   * The style a block uses when it names none: Normal for paragraphs,
   * Heading N for headings of level N, Code for code blocks (the built-in
   * style whose own `block` matches).
   */
  defaultStyleFor(type: string, attrs: Record<string, any> = {}): string | null {
    if (type === "paragraph" && this.styles.get(NORMAL_STYLE_ID)) return NORMAL_STYLE_ID;
    const candidates = this.list("paragraph").filter(
      (style) => style.block && sameBlock(style.block, type, attrs),
    );
    return (candidates.find((s) => s.builtin) ?? candidates[0])?.id ?? null;
  }

  /** The style of a block: its `styleId` when known, otherwise the block's default style. */
  styleOfBlock(type: string, attrs: Record<string, any> = {}): string | null {
    const id = attrs.styleId;
    if (id && this.styles.get(id)?.kind === "paragraph") return id;
    return this.defaultStyleFor(type, attrs);
  }

  getSnapshot = (): StyleRegistrySnapshot => {
    if (!this.snapshot) {
      this.snapshot = Object.freeze({
        styles: Object.freeze(this.list()),
        defaults: this.defaults,
        version: this.version,
      });
    }
    return this.snapshot;
  };

  subscribe = (listener: (snapshot: StyleRegistrySnapshot) => void): (() => void) => {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  };

  toJSON(): StyleRegistryJSON {
    return { styles: clone(Array.from(this.styles.values())), defaults: clone(this.defaults) };
  }

  // -- Writing --------------------------------------------------------------

  /** Adds or replaces a style. Throws on an invalid id. */
  upsert(style: StyleDefinition): StyleDefinition {
    const stored = this.put(style);
    this.changed();
    return stored;
  }

  /** Merges `patch` into a style (formats are merged key by key). Returns `undefined` for unknown ids. */
  update(id: string, patch: Partial<Omit<StyleDefinition, "id">>): StyleDefinition | undefined {
    const current = this.styles.get(id);
    if (!current) return undefined;
    const next: StyleDefinition = {
      ...current,
      ...patch,
      id,
      paragraph: patch.paragraph ? { ...current.paragraph, ...patch.paragraph } : current.paragraph,
      character: patch.character ? { ...current.character, ...patch.character } : current.character,
    };
    return this.upsert(next);
  }

  /**
   * Removes a style and returns it. Built-in styles cannot be removed. Styles
   * based on it are rebased onto its own base, and `next`/`linked`
   * references to it are dropped.
   */
  remove(id: string): StyleDefinition | undefined {
    const gone = this.styles.get(id);
    if (!gone || gone.builtin) return undefined;
    this.styles.delete(id);
    this.styles.forEach((style, key) => {
      let changed = style;
      if (style.basedOn === id) {
        changed = { ...changed, basedOn: gone.basedOn && gone.basedOn !== key ? gone.basedOn : null };
      }
      if (style.next === id) changed = { ...changed, next: null };
      if (style.linked === id) changed = { ...changed, linked: null };
      if (changed !== style) this.styles.set(key, changed);
    });
    this.changed();
    return gone;
  }

  /** Replaces the document defaults. */
  setDefaults(defaults: StyleDefaults): void {
    this.defaults = clone(defaults);
    this.changed();
  }

  /** An unused id derived from a display name (`My Style` → `MyStyle`, then `MyStyle1`, …). */
  newId(name: string): string {
    let base = name.replace(/[^A-Za-z0-9_-]+/g, "").replace(/^[^A-Za-z]+/, "").slice(0, 56);
    if (!base) base = "Style";
    if (!this.styles.has(base)) return base;
    for (let i = 1; i < 100000; i++) {
      const id = `${base}${i}`;
      if (!this.styles.has(id)) return id;
    }
    return `${base}${Date.now()}`;
  }

  // -- CSS --------------------------------------------------------------------

  /** CSS declarations (`property: value`) of a resolved paragraph or character style. */
  cssDeclarations(id: string): Record<string, string> {
    const style = this.styles.get(id);
    if (style?.kind === "character") return characterCSS(this.resolveCharacterStyle(id));
    const resolved = this.resolve(id);
    return { ...paragraphCSS(resolved.paragraph), ...characterCSS(resolved.character) };
  }

  /**
   * Declarations for previewing a style in a menu or gallery: font family,
   * weight, style, color, decoration, case and letter spacing (no sizes,
   * margins or borders).
   */
  previewDeclarations(id: string): Record<string, string> {
    return Object.fromEntries(
      Object.entries(this.cssDeclarations(id)).filter(([property]) => PREVIEW_PROPERTIES.has(property)),
    );
  }

  /**
   * A stylesheet for the styles: `[data-style="Id"]` rules for paragraph
   * styles (plus the plain element of blocks that use their default style,
   * e.g. `h2:not([data-style])`), `[data-char-style="Id"]` for character
   * styles and the defaults on the scope element.
   */
  toCSS(options: StyleCSSOptions = {}): string {
    const scope = options.scope ?? ".ProseMirror";
    const tagFor = options.tagFor ?? defaultTagFor;
    const rules: string[] = [];
    const rule = (selectors: string[], declarations: Record<string, string>) => {
      const body = Object.entries(declarations)
        .map(([property, value]) => `${property}: ${value};`)
        .join(" ");
      if (body) rules.push(`${selectors.join(", ")} { ${body} }`);
    };
    rule([scope], {
      ...paragraphCSS(this.defaults.paragraph ?? {}),
      ...characterCSS(this.defaults.character ?? {}),
    });
    this.list().forEach((style) => {
      if (style.kind === "character") {
        rule([`${scope} [data-char-style="${style.id}"]`], this.cssDeclarations(style.id));
        return;
      }
      const selectors = [`${scope} [data-style="${style.id}"]`];
      const block = this.resolve(style.id).block;
      if (this.defaultStyleFor(block.type, block.attrs ?? {}) === style.id) {
        const tag = tagFor(block);
        if (tag) selectors.push(`${scope} ${tag}:not([data-style])`);
      }
      // Defaults already apply to the scope; repeat only what the chain sets.
      const resolved = this.resolve(style.id);
      const own = {
        ...paragraphCSS(withoutDefaults(resolved.paragraph, this.defaults.paragraph)),
        ...characterCSS(withoutDefaults(resolved.character, this.defaults.character)),
      };
      rule(selectors, own);
    });
    return rules.join("\n");
  }

  // -- Internals --------------------------------------------------------------

  private put(style: StyleDefinition): StyleDefinition {
    if (!isValidStyleId(style.id)) throw new Error(`Invalid style id: ${String(style.id)}`);
    if (style.kind !== "paragraph" && style.kind !== "character") {
      throw new Error(`Invalid style kind: ${String(style.kind)}`);
    }
    const stored = clone({ ...style, name: style.name || style.id });
    this.styles.set(style.id, stored);
    return stored;
  }

  private changed(): void {
    this.version++;
    this.snapshot = null;
    const snapshot = this.getSnapshot();
    this.listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (err) {
        console.error("[StyleRegistry] Error in listener:", err);
      }
    });
  }
}

function withoutDefaults<T extends object>(format: T, defaults: T | undefined): T {
  if (!defaults) return format;
  const out: Record<string, unknown> = {};
  Object.entries(format).forEach(([key, value]) => {
    if ((defaults as Record<string, unknown>)[key] !== value) out[key] = value;
  });
  return out as T;
}

function defaultTagFor(block: StyleBlock): string | null {
  if (block.type === "paragraph") return "p";
  if (block.type === "heading") {
    const level = Number(block.attrs?.level);
    return level >= 1 && level <= 6 ? `h${level}` : null;
  }
  if (block.type === "codeBlock") return "pre";
  return null;
}

/** A CSS value, or `undefined` when it is unsafe or empty. */
export function safeCSSValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200 || UNSAFE_CSS.test(trimmed)) return undefined;
  return trimmed;
}

function paragraphCSS(format: ParagraphFormat): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (property: string, value: unknown) => {
    const safe = safeCSSValue(value);
    if (safe) out[property] = safe;
  };
  set("text-align", format.textAlign);
  set("line-height", format.lineHeight);
  set("margin-top", format.spaceBefore);
  set("margin-bottom", format.spaceAfter);
  set("margin-left", format.indentLeft);
  set("margin-right", format.indentRight);
  set("text-indent", format.indentFirstLine);
  set("border-left", format.borderLeft);
  set("padding-left", format.paddingLeft);
  set("background-color", format.backgroundColor);
  return out;
}

function characterCSS(format: CharacterFormat): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (property: string, value: unknown) => {
    const safe = safeCSSValue(value);
    if (safe) out[property] = safe;
  };
  set("font-family", format.fontFamily);
  set("font-size", format.fontSize);
  if (format.bold !== undefined) out["font-weight"] = format.bold ? "700" : "400";
  if (format.italic !== undefined) out["font-style"] = format.italic ? "italic" : "normal";
  const lines = [format.underline && "underline", format.strike && "line-through"].filter(Boolean);
  if (format.underline !== undefined || format.strike !== undefined) {
    out["text-decoration-line"] = lines.length ? lines.join(" ") : "none";
  }
  set("color", format.color);
  set("background-color", format.backgroundColor);
  set("letter-spacing", format.letterSpacing);
  set("text-transform", format.textTransform);
  if (format.smallCaps !== undefined) out["font-variant-caps"] = format.smallCaps ? "small-caps" : "normal";
  return out;
}

/** Creates a style registry with the built-in styles (unless `builtins: false`) and `styles`. */
export function createStyleRegistry(options: StyleRegistryOptions | StyleRegistryJSON = {}): StyleRegistry {
  return new StyleRegistry(options as StyleRegistryOptions);
}
