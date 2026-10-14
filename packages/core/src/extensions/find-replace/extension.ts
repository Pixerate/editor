// Portions ported from wordcraft/crates/engine/src/cmd/edit.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { Extension, type Editor, type KeyboardShortcutCommand } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { closeHistory } from "@tiptap/pm/history";
import type { FindOptions, FindPatternError } from "./pattern";
import { applyReplacements, searchDocument, type FindMatch } from "./search";

export type FindReplaceMode = "find" | "replace";

/** Everything a find bar needs. Snapshots are cached, so they suit `useSyncExternalStore`. */
export interface FindReplaceSnapshot {
  /** Whether the find bar should be shown (`openFindReplace` / Mod+F). */
  open: boolean;
  mode: FindReplaceMode;
  query: string;
  replacement: string;
  options: Readonly<FindOptions>;
  matches: readonly FindMatch[];
  /** Index of the current match, or -1. */
  currentIndex: number;
  error: FindPatternError | null;
  /** The search stopped at the match cap or time budget. */
  truncated: boolean;
  /** Replacements made by the last `replaceAll` / `replaceCurrent` (`null` before any). */
  lastReplaceCount: number | null;
  /** Bumped whenever the bar is asked to focus its find field (Mod+F while open). */
  focusRequest: number;
}

const EMPTY_OPTIONS: Readonly<FindOptions> = Object.freeze({});

export const EMPTY_FIND_REPLACE_SNAPSHOT: FindReplaceSnapshot = Object.freeze({
  open: false,
  mode: "find",
  query: "",
  replacement: "",
  options: EMPTY_OPTIONS,
  matches: Object.freeze([]) as readonly FindMatch[],
  currentIndex: -1,
  error: null,
  truncated: false,
  lastReplaceCount: null,
  focusRequest: 0,
}) as FindReplaceSnapshot;

/**
 * External store over the find state. `subscribe` calls the listener
 * immediately (Svelte store contract).
 */
export class FindReplaceStore {
  private snapshot: FindReplaceSnapshot = EMPTY_FIND_REPLACE_SNAPSHOT;
  private listeners = new Set<(snapshot: FindReplaceSnapshot) => void>();

  subscribe = (listener: (snapshot: FindReplaceSnapshot) => void): (() => void) => {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): FindReplaceSnapshot => this.snapshot;

  /** @internal Called by the extension's plugin view. */
  set(snapshot: FindReplaceSnapshot): void {
    if (snapshot === this.snapshot) return;
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (err) {
        console.error("[FindReplaceStore] Error in listener:", err);
      }
    });
  }
}

export interface FindReplaceOptions {
  /** Bind Mod+F / Mod+H (and Mod+Shift+H) to open the bar, F3 / Mod+G to step. Default `true`. */
  shortcuts: boolean;
  /** Class of every match. */
  matchClass: string;
  /** Class of the current match. */
  currentMatchClass: string;
  /** Wall-clock budget per search in milliseconds (default 250). */
  timeLimitMs: number;
  /** Match cap per search (default 10 000). */
  maxMatches: number;
  /** Text of `^c` in Replace with (clipboard reads are async in browsers, so supply it). */
  getClipboardText: () => string;
  /** Longest selection copied into the find field by Mod+F. Default 256. */
  maxPrefillLength: number;
}

export interface FindReplaceStorage {
  store: FindReplaceStore;
}

export interface SetSearchParams {
  query?: string;
  replacement?: string;
  /** Merged into the current options. */
  options?: Partial<FindOptions>;
}

export interface OpenFindReplaceParams {
  mode?: FindReplaceMode;
  /** Find text; defaults to the selected text (single paragraph, short). */
  query?: string;
}

interface PluginState {
  active: boolean;
  open: boolean;
  mode: FindReplaceMode;
  query: string;
  replacement: string;
  options: Readonly<FindOptions>;
  matches: readonly FindMatch[];
  currentIndex: number;
  /** Position the current match is chosen from (first match at or after it) after a re-search. */
  anchor: number;
  error: FindPatternError | null;
  truncated: boolean;
  lastReplaceCount: number | null;
  focusRequest: number;
  decorations: DecorationSet;
}

type FindReplaceMeta =
  | { type: "set"; params: SetSearchParams; anchor: number }
  | { type: "open"; mode: FindReplaceMode; query?: string; anchor: number }
  | { type: "close" }
  | { type: "clear" }
  | { type: "current"; index: number }
  | { type: "replaced"; anchor: number; count: number };

export const findReplacePluginKey = new PluginKey<PluginState>("findReplace");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    findReplace: {
      /** Sets the find text, replace text and/or options and searches. */
      setSearch: (params: SetSearchParams) => ReturnType;
      /** Shows the find bar (and searches its text). */
      openFindReplace: (params?: OpenFindReplaceParams) => ReturnType;
      /** Hides the find bar and its highlights; the find text is kept. */
      closeFindReplace: () => ReturnType;
      /** Clears the find text and highlights. */
      clearSearch: () => ReturnType;
      /** Selects the next match after the selection, wrapping around. */
      findNext: () => ReturnType;
      /** Selects the previous match before the selection, wrapping around. */
      findPrevious: () => ReturnType;
      /** Replaces the current match and moves on to the next one. */
      replaceCurrent: () => ReturnType;
      /** Replaces every match in one transaction (one undo step). */
      replaceAll: () => ReturnType;
    };
  }
}

/** The extension's plugin state, or `null` without `FindReplace`. */
export function getFindReplaceState(source: Editor | EditorState | null | undefined): FindReplaceSnapshot | null {
  const state: EditorState | undefined = (source as any)?.state ?? (source as any);
  if (!state || typeof (state as any).plugins === "undefined") return null;
  const plugin = findReplacePluginKey.getState(state);
  return plugin ? toSnapshot(plugin) : null;
}

/** Returns the find store of an editor using `FindReplace`. */
export function getFindReplaceStore(editor: Editor | null | undefined): FindReplaceStore | null {
  return (editor?.storage as any)?.findReplace?.store ?? null;
}

const snapshotCache = new WeakMap<PluginState, FindReplaceSnapshot>();

function toSnapshot(s: PluginState): FindReplaceSnapshot {
  let snapshot = snapshotCache.get(s);
  if (!snapshot) {
    snapshot = Object.freeze({
      open: s.open,
      mode: s.mode,
      query: s.query,
      replacement: s.replacement,
      options: s.options,
      matches: s.active ? s.matches : EMPTY_FIND_REPLACE_SNAPSHOT.matches,
      currentIndex: s.active ? s.currentIndex : -1,
      error: s.error,
      truncated: s.truncated,
      lastReplaceCount: s.lastReplaceCount,
      focusRequest: s.focusRequest,
    });
    snapshotCache.set(s, snapshot);
  }
  return snapshot;
}

export interface FindOptionToggle {
  key: keyof FindOptions;
  label: string;
  /** Compact button text. */
  short: string;
  /** Shown under "More options" rather than as a toolbar toggle. */
  advanced: boolean;
}

/** The option toggles of the React and Svelte find bars, in display order. */
export const FIND_OPTION_TOGGLES: readonly FindOptionToggle[] = Object.freeze([
  { key: "matchCase", label: "Match case", short: "Aa", advanced: false },
  { key: "wholeWord", label: "Whole words only", short: "ab", advanced: false },
  { key: "wildcards", label: "Use wildcards", short: "*?", advanced: false },
  { key: "regex", label: "Regular expression", short: ".*", advanced: false },
  { key: "matchPrefix", label: "Match prefix", short: "ab-", advanced: true },
  { key: "matchSuffix", label: "Match suffix", short: "-ab", advanced: true },
  { key: "ignorePunctuation", label: "Ignore punctuation", short: ".,", advanced: true },
  { key: "ignoreWhitespace", label: "Ignore white space", short: "_", advanced: true },
  { key: "literal", label: "No special characters (^)", short: "^", advanced: true },
]);

/**
 * Text of a find bar's match counter: `"3 of 12"`, `"12 results"` (no
 * current match), `"No results"`, `"10000+ results"` when truncated, or the
 * pattern error. Empty without a query.
 */
export function formatFindStatus(
  s: Pick<FindReplaceSnapshot, "query" | "matches" | "currentIndex" | "error" | "truncated">,
): string {
  if (!s.query) return "";
  if (s.error) return s.error.message;
  const n = s.matches.length;
  if (n === 0) return "No results";
  const total = s.truncated ? `${n}+` : `${n}`;
  return s.currentIndex >= 0 ? `${s.currentIndex + 1} of ${total}` : `${total} results`;
}

/** Index of the first match starting at or after `pos`, wrapping to the first match. */
function indexFrom(matches: readonly FindMatch[], pos: number): number {
  if (!matches.length) return -1;
  const i = matches.findIndex((m) => m.from >= pos);
  return i < 0 ? 0 : i;
}

/** Text of a short selection inside one textblock, for prefilling the find field. */
function selectedQuery(state: EditorState, maxLength: number): string | undefined {
  const { from, to, $from, $to } = state.selection;
  if (from === to || !$from.sameParent($to)) return undefined;
  const text = state.doc.textBetween(from, to, "", "");
  return text && text.length <= maxLength && !/[\r\n]/.test(text) ? text : undefined;
}

/**
 * Word-style Find and Replace: Match case, Whole words, prefix/suffix,
 * Ignore punctuation/white space, `^` special characters, wildcards (with
 * `\1` groups in the replacement) and a raw regex mode. Matches are
 * decorated; tracked-deleted text is skipped, and replacements made while
 * Track Changes is on become tracked changes.
 */
export const FindReplace = Extension.create<FindReplaceOptions, FindReplaceStorage>({
  name: "findReplace",

  addOptions() {
    return {
      shortcuts: true,
      matchClass: "pixerate-find-match",
      currentMatchClass: "pixerate-find-match-current",
      timeLimitMs: 250,
      maxMatches: 10_000,
      getClipboardText: () => "",
      maxPrefillLength: 256,
    };
  },

  addStorage() {
    return { store: new FindReplaceStore() };
  },

  addCommands() {
    const meta = (tr: Transaction, value: FindReplaceMeta) => tr.setMeta(findReplacePluginKey, value);
    const current = (state: EditorState) => findReplacePluginKey.getState(state);
    const maxPrefill = () => this.options.maxPrefillLength;

    const select = (tr: Transaction, match: FindMatch) => {
      tr.setSelection(TextSelection.create(tr.doc, match.from, match.to)).scrollIntoView();
    };

    return {
      setSearch:
        (params) =>
        ({ tr, state, dispatch }) => {
          if (!current(state)) return false;
          if (dispatch) meta(tr, { type: "set", params, anchor: state.selection.from });
          return true;
        },
      openFindReplace:
        (params = {}) =>
        ({ tr, state, dispatch }) => {
          if (!current(state)) return false;
          if (dispatch) {
            meta(tr, {
              type: "open",
              mode: params.mode ?? "find",
              query: params.query ?? selectedQuery(state, maxPrefill()),
              anchor: state.selection.from,
            });
          }
          return true;
        },
      closeFindReplace:
        () =>
        ({ tr, state, dispatch }) => {
          if (!current(state)) return false;
          if (dispatch) meta(tr, { type: "close" });
          return true;
        },
      clearSearch:
        () =>
        ({ tr, state, dispatch }) => {
          if (!current(state)) return false;
          if (dispatch) meta(tr, { type: "clear" });
          return true;
        },
      findNext:
        () =>
        ({ tr, state, dispatch }) => {
          const s = current(state);
          if (!s || !s.active || !s.matches.length) return false;
          const { from, to } = state.selection;
          const cur = s.matches[s.currentIndex];
          const onCurrent = cur && cur.from === from && cur.to === to;
          const index = onCurrent
            ? (s.currentIndex + 1) % s.matches.length
            : indexFrom(s.matches, to);
          if (dispatch) {
            meta(tr, { type: "current", index });
            select(tr, s.matches[index]);
          }
          return true;
        },
      findPrevious:
        () =>
        ({ tr, state, dispatch }) => {
          const s = current(state);
          if (!s || !s.active || !s.matches.length) return false;
          const { from, to } = state.selection;
          const n = s.matches.length;
          const cur = s.matches[s.currentIndex];
          const onCurrent = cur && cur.from === from && cur.to === to;
          let index: number;
          if (onCurrent) {
            index = (s.currentIndex - 1 + n) % n;
          } else {
            index = -1;
            for (let i = n - 1; i >= 0; i--) {
              if (s.matches[i].to <= from) {
                index = i;
                break;
              }
            }
            if (index < 0) index = n - 1;
          }
          if (dispatch) {
            meta(tr, { type: "current", index });
            select(tr, s.matches[index]);
          }
          return true;
        },
      replaceCurrent:
        () =>
        ({ tr, state, dispatch }) => {
          const s = current(state);
          if (!s || !s.active || s.currentIndex < 0 || !s.matches[s.currentIndex]) return false;
          if (dispatch) {
            // A replacement is its own undo step, not merged with typing before it.
            closeHistory(tr);
            const [end] = applyReplacements(tr, [s.matches[s.currentIndex]]);
            tr.setSelection(TextSelection.create(tr.doc, end)).scrollIntoView();
            meta(tr, { type: "replaced", anchor: end, count: 1 });
          }
          return true;
        },
      replaceAll:
        () =>
        ({ tr, state, dispatch }) => {
          const s = current(state);
          if (!s || !s.active || !s.matches.length) return false;
          if (dispatch) {
            closeHistory(tr);
            const ends = applyReplacements(tr, s.matches);
            meta(tr, { type: "replaced", anchor: ends[ends.length - 1], count: s.matches.length });
          }
          return true;
        },
    };
  },

  addKeyboardShortcuts(): Record<string, KeyboardShortcutCommand> {
    if (!this.options.shortcuts) return {};
    const open = (mode: FindReplaceMode) => () => this.editor.commands.openFindReplace({ mode });
    const step = (forward: boolean) => () => {
      const s = findReplacePluginKey.getState(this.editor.state);
      if (!s?.active || !s.matches.length) return false;
      return forward ? this.editor.commands.findNext() : this.editor.commands.findPrevious();
    };
    return {
      "Mod-f": open("find"),
      "Mod-h": open("replace"),
      "Mod-Shift-h": open("replace"),
      F3: step(true),
      "Shift-F3": step(false),
      "Mod-g": step(true),
      "Mod-Shift-g": step(false),
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    const store = this.storage.store;

    const search = (s: PluginState, doc: EditorState["doc"]): PluginState => {
      if (!s.active || !s.query) {
        return { ...s, matches: [], currentIndex: -1, error: null, truncated: false };
      }
      const result = searchDocument(doc, s.query, s.options, {
        replacement: s.replacement,
        clipboardText: safeClipboard(options.getClipboardText),
        timeLimitMs: options.timeLimitMs,
        maxMatches: options.maxMatches,
      });
      return {
        ...s,
        matches: result.matches,
        currentIndex: indexFrom(result.matches, s.anchor),
        error: result.error,
        truncated: result.truncated,
      };
    };

    const decorate = (s: PluginState, doc: EditorState["doc"]): PluginState => {
      if (!s.active || !s.matches.length) return { ...s, decorations: DecorationSet.empty };
      const decorations = s.matches.map((m, i) =>
        Decoration.inline(m.from, m.to, {
          class: i === s.currentIndex ? `${options.matchClass} ${options.currentMatchClass}` : options.matchClass,
        }),
      );
      return { ...s, decorations: DecorationSet.create(doc, decorations) };
    };

    return [
      new Plugin<PluginState>({
        key: findReplacePluginKey,
        state: {
          init: () => ({
            active: false,
            open: false,
            mode: "find",
            query: "",
            replacement: "",
            options: EMPTY_OPTIONS,
            matches: [],
            currentIndex: -1,
            anchor: 0,
            error: null,
            truncated: false,
            lastReplaceCount: null,
            focusRequest: 0,
            decorations: DecorationSet.empty,
          }),
          apply: (tr, prev, _oldState, newState) => {
            const m = tr.getMeta(findReplacePluginKey) as FindReplaceMeta | undefined;
            if (!m && !tr.docChanged) return prev;
            let s: PluginState = prev;
            let research = false;
            let redecorate = false;
            if (tr.docChanged) {
              s = { ...s, anchor: tr.mapping.map(s.anchor) };
              research = s.active;
            }
            if (m) {
              switch (m.type) {
                case "set": {
                  const p = m.params;
                  s = {
                    ...s,
                    active: true,
                    query: p.query ?? s.query,
                    replacement: p.replacement ?? s.replacement,
                    options: p.options ? Object.freeze({ ...s.options, ...p.options }) : s.options,
                    anchor: m.anchor,
                    lastReplaceCount: null,
                  };
                  research = true;
                  break;
                }
                case "open":
                  s = {
                    ...s,
                    active: true,
                    open: true,
                    mode: m.mode,
                    query: m.query ?? s.query,
                    anchor: m.anchor,
                    focusRequest: s.focusRequest + 1,
                  };
                  research = true;
                  break;
                case "close":
                  s = { ...s, open: false, active: false };
                  research = true;
                  break;
                case "clear":
                  s = { ...s, active: false, query: "", lastReplaceCount: null };
                  research = true;
                  break;
                case "current":
                  s = {
                    ...s,
                    currentIndex: m.index,
                    anchor: s.matches[m.index]?.from ?? s.anchor,
                  };
                  redecorate = true;
                  break;
                case "replaced":
                  s = { ...s, anchor: m.anchor, lastReplaceCount: m.count };
                  research = true;
                  break;
              }
            }
            if (research) s = search(s, newState.doc);
            if (research || redecorate) s = decorate(s, newState.doc);
            return s;
          },
        },
        props: {
          decorations: (state) => findReplacePluginKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
        view: (view) => {
          const sync = () => {
            const s = findReplacePluginKey.getState(view.state);
            if (s) store.set(toSnapshot(s));
          };
          sync();
          return { update: sync };
        },
      }),
    ];
  },
});

function safeClipboard(get: () => string): string {
  try {
    return String(get() ?? "");
  } catch {
    return "";
  }
}
