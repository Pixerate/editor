import { Extension } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/**
 * Context passed to function replacements.
 */
export interface AutocorrectContext {
  /** Text of the current block before the caret, including the typed text. */
  textBefore: string;
  /** Returns true if `text` is in the exceptions list (case-insensitive). */
  isException: (text: string) => boolean;
  /** Editor state before the typed text was inserted. */
  state: EditorState;
}

/**
 * An autocorrect rule. Rules are checked in order after every typed character
 * against the text before the caret; the first one that produces a
 * replacement wins.
 *
 * - `find: string` matches when the text before the caret ends with it.
 *   With `wholeWord: true` it must also be a whole word followed by a space or
 *   punctuation (Word's AutoCorrect entries, e.g. `teh ` -> `the `); the
 *   delimiter is kept.
 * - `find: RegExp` must match at the end of the text (anchor it with `$`).
 *
 * `replace` replaces the whole match. A string is inserted literally (no `$1`
 * patterns); use a function to reuse capture groups. Return `null` from a
 * function to skip the correction.
 */
export interface AutocorrectRule {
  id: string;
  find: string | RegExp;
  replace:
    | string
    | ((match: RegExpMatchArray, context: AutocorrectContext) => string | null | undefined);
  wholeWord?: boolean;
}

/**
 * A correction that was applied.
 */
export interface AutocorrectCorrection {
  ruleId: string;
  /** Document range of the replacement text after the correction. */
  from: number;
  to: number;
  original: string;
  replacement: string;
}

export interface AutocorrectOptions {
  /** Rules in priority order. Defaults to `defaultAutocorrectRules`. */
  rules: AutocorrectRule[];
  /**
   * Exceptions (Word's AutoCorrect exceptions). Matched case-insensitively.
   * - Abbreviations ending in `.` (e.g. `e.g.`) do not end a sentence, so the
   *   next word is not capitalized.
   * - Words like `IDs` are not "fixed" by the two-initial-capitals rule.
   * - Any other entry is text that should never be corrected (the matched
   *   text, e.g. `(c)` or `teh`).
   */
  exceptions: string[];
  /** Node types in which nothing is corrected (plus any node with `code: true`). */
  ignoreNodes: string[];
  /** Mark types in which nothing is corrected (plus any mark with `code: true`). */
  ignoreMarks: string[];
  /** Skip corrections inside `{{template}}`, `{variable}` and `__instruction__` tokens. */
  ignorePromptTokens: boolean;
  /** Called after each correction. */
  onCorrection?: (correction: AutocorrectCorrection) => void;
}

export interface AutocorrectStorage {
  /** Whether corrections are applied. Toggle with `setAutocorrectEnabled`. */
  enabled: boolean;
  /** Live exceptions set (lowercased). Edit with the exception commands. */
  exceptions: Set<string>;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    autocorrect: {
      /** Reverts the last correction if nothing else has changed since. */
      undoAutocorrect: () => ReturnType;
      /** Enables or disables autocorrect. */
      setAutocorrectEnabled: (enabled: boolean) => ReturnType;
      /** Adds an entry to the exceptions list. */
      addAutocorrectException: (text: string) => ReturnType;
      /** Removes an entry from the exceptions list. */
      removeAutocorrectException: (text: string) => ReturnType;
    };
  }
}

const quoteOpener = /[\s ([{<—–‘“-]/;

/** Smart (curly) quotes and apostrophes. */
export const smartQuoteRules: AutocorrectRule[] = [
  {
    id: "smart-quotes:double",
    find: /(^|.)"$/su,
    replace: (m) => m[1] + (!m[1] || quoteOpener.test(m[1]) ? "“" : "”"),
  },
  {
    id: "smart-quotes:single",
    find: /(^|.)'$/su,
    replace: (m) => m[1] + (!m[1] || quoteOpener.test(m[1]) ? "‘" : "’"),
  },
];

/** Symbols: em dash, ellipsis, arrows, copyright, registered, trademark. */
export const symbolRules: AutocorrectRule[] = [
  { id: "symbols:em-dash", find: "--", replace: "—" },
  { id: "symbols:ellipsis", find: "...", replace: "…" },
  { id: "symbols:right-arrow", find: "->", replace: "→" },
  { id: "symbols:left-arrow", find: "<-", replace: "←" },
  { id: "symbols:copyright", find: /\([cC]\)$/, replace: "©" },
  { id: "symbols:registered", find: /\([rR]\)$/, replace: "®" },
  { id: "symbols:trademark", find: /\((?:tm|TM)\)$/, replace: "™" },
];

const FRACTIONS: Record<string, string> = { "1/2": "½", "1/4": "¼", "3/4": "¾" };

/** Fractions (`1/2`, `1/4`, `3/4`), corrected once the number is complete. */
export const fractionRules: AutocorrectRule[] = [
  {
    id: "fractions",
    find: /(^|[^\d/.,])([13]\/[24])([\s.,;:!?)])$/u,
    replace: (m) => (FRACTIONS[m[2]] ? m[1] + FRACTIONS[m[2]] + m[3] : null),
  },
];

/**
 * Capitalizes the first letter of a sentence when the word is completed.
 * Abbreviations in the exceptions list (and single-letter initials such as
 * `J.`) do not end a sentence.
 */
export const capitalizeSentenceRules: AutocorrectRule[] = [
  {
    id: "capitalize-sentence",
    find: /(?:^|(\S+)(\s+))(\p{Ll}[^\s]*)(\s)$/u,
    replace: (m, ctx) => {
      const [, previous, space = "", word, trailing] = m;
      // URLs, paths, e-mail addresses and dotted abbreviations stay as typed.
      if (/[./@:\\]/.test(word.slice(0, -1))) return null;
      if (previous !== undefined) {
        if (!/[.!?]["'”’)]*$/.test(previous)) return null;
        const token = previous.replace(/["'”’)]+$/, "");
        if (ctx.isException(token)) return null;
        if (/^\p{L}\.$/u.test(token)) return null;
        if (/\.\./.test(token) || token.endsWith("…")) return null;
      }
      return (
        (previous ?? "") + space + word.charAt(0).toUpperCase() + word.slice(1) + trailing
      );
    },
  },
];

/** Fixes TWo INitial CApitals (`THe ` -> `The `), unless the word is an exception. */
export const twoInitialCapitalsRules: AutocorrectRule[] = [
  {
    id: "two-initial-capitals",
    find: /(^|[^\p{L}\p{N}'’])(\p{Lu})(\p{Lu})(\p{Ll}{1,})([\s.,;:!?])$/u,
    replace: (m, ctx) => {
      const word = m[2] + m[3] + m[4];
      if (ctx.isException(word)) return null;
      return m[1] + m[2] + m[3].toLowerCase() + m[4] + m[5];
    },
  },
];

/**
 * The default rule set: smart quotes, symbols, fractions, sentence
 * capitalization and two-initial-capitals.
 */
export const defaultAutocorrectRules: AutocorrectRule[] = [
  ...smartQuoteRules,
  ...symbolRules,
  ...fractionRules,
  ...capitalizeSentenceRules,
  ...twoInitialCapitalsRules,
];

/** Default exceptions: common abbreviations and two-capital words. */
export const DEFAULT_AUTOCORRECT_EXCEPTIONS: string[] = [
  "a.m.", "abbr.", "approx.", "apt.", "assn.", "ave.", "ca.", "cf.", "co.",
  "corp.", "dept.", "dr.", "e.g.", "est.", "etc.", "fig.", "i.e.", "inc.",
  "jr.", "ltd.", "mr.", "mrs.", "ms.", "mt.", "no.", "p.", "p.m.", "pp.",
  "prof.", "sr.", "st.", "vol.", "vs.",
  "CDs", "IDs", "PCs", "GHz", "MHz", "KHz",
];

export const autocorrectPluginKey = new PluginKey<AutocorrectPluginState>("autocorrect");

interface AutocorrectPluginState {
  last: AutocorrectCorrection | null;
  /** The next typed text should start a new undo group. */
  closePending: boolean;
}

const WHOLE_WORD_DELIMITER = /[\s.,;:!?]/;

/**
 * Finds the first matching rule for `textBefore`. Exported for testing and for
 * custom input pipelines.
 */
export function findAutocorrection(
  textBefore: string,
  rules: readonly AutocorrectRule[],
  context: Omit<AutocorrectContext, "textBefore">,
): { ruleId: string; start: number; original: string; replacement: string } | null {
  const ctx: AutocorrectContext = { ...context, textBefore };
  for (const rule of rules) {
    let match: RegExpMatchArray | null = null;
    if (typeof rule.find === "string") {
      const find = rule.find;
      if (rule.wholeWord) {
        const delimiter = textBefore.slice(-1);
        if (!WHOLE_WORD_DELIMITER.test(delimiter)) continue;
        const body = textBefore.slice(0, -1);
        if (!body.endsWith(find)) continue;
        const before = body.charAt(body.length - find.length - 1);
        if (before && /[\p{L}\p{N}_]/u.test(before)) continue;
        match = Object.assign([find + delimiter], {
          index: textBefore.length - find.length - 1,
          input: textBefore,
        }) as RegExpMatchArray;
      } else {
        if (!textBefore.endsWith(find)) continue;
        match = Object.assign([find], {
          index: textBefore.length - find.length,
          input: textBefore,
        }) as RegExpMatchArray;
      }
    } else {
      const regex = new RegExp(rule.find.source, rule.find.flags.replace("g", ""));
      match = textBefore.match(regex);
      if (!match || match.index! + match[0].length !== textBefore.length) continue;
    }

    const original = match[0];
    if (ctx.isException(original.trim())) continue;
    let replacement: string | null | undefined;
    if (typeof rule.replace === "function") {
      replacement = rule.replace(match, ctx);
    } else {
      replacement =
        rule.wholeWord && typeof rule.find === "string"
          ? rule.replace + original.slice(-1)
          : rule.replace;
    }
    if (replacement == null || replacement === original) continue;
    return { ruleId: rule.id, start: match.index!, original, replacement };
  }
  return null;
}

/**
 * True when the end of `textBefore` is inside an unclosed prompt token:
 * `{{template`, `{variable` or `__instruction`.
 */
export function isInsidePromptToken(textBefore: string): boolean {
  if (textBefore.lastIndexOf("{") > textBefore.lastIndexOf("}")) return true;
  const underscores = textBefore.match(/__/g);
  return !!underscores && underscores.length % 2 === 1;
}

/**
 * Word-style AutoCorrect with a configurable rule registry and exceptions
 * list. Each correction is its own undo step: undo (Mod-z) right after a
 * correction restores exactly what was typed. Corrections never apply inside
 * code blocks, inline code or (by default) prompt tokens.
 *
 * Do not combine with `@tiptap/extension-typography`: TipTap's input rules
 * run first and would pre-empt the overlapping rules. `createRichTextPreset`
 * drops Typography when `autocorrect` is enabled.
 */
export const Autocorrect = Extension.create<AutocorrectOptions, AutocorrectStorage>({
  name: "autocorrect",

  addOptions() {
    return {
      rules: defaultAutocorrectRules,
      exceptions: DEFAULT_AUTOCORRECT_EXCEPTIONS,
      ignoreNodes: ["codeBlock"],
      ignoreMarks: ["code"],
      ignorePromptTokens: true,
      onCorrection: undefined,
    };
  },

  addStorage() {
    return {
      enabled: true,
      exceptions: new Set(this.options.exceptions.map((e) => e.toLowerCase())),
    };
  },

  addCommands() {
    return {
      undoAutocorrect:
        () =>
        ({ state, tr, dispatch }) => {
          const last = autocorrectPluginKey.getState(state)?.last;
          if (!last) return false;
          if (state.doc.textBetween(last.from, last.to) !== last.replacement) return false;
          if (dispatch) {
            tr.insertText(last.original, last.from, last.to);
            tr.setMeta(autocorrectPluginKey, { undo: true });
          }
          return true;
        },
      setAutocorrectEnabled:
        (enabled) =>
        () => {
          this.storage.enabled = enabled;
          return true;
        },
      addAutocorrectException:
        (text) =>
        () => {
          this.storage.exceptions.add(text.toLowerCase());
          return true;
        },
      removeAutocorrectException:
        (text) =>
        () =>
          this.storage.exceptions.delete(text.toLowerCase()),
    };
  },

  addProseMirrorPlugins() {
    const extension = this;

    const isIgnored = (state: EditorState, from: number, to: number) => {
      const { ignoreNodes, ignoreMarks } = extension.options;
      const $from = state.doc.resolve(from);
      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d);
        if (node.type.spec.code || ignoreNodes.includes(node.type.name)) return true;
      }
      const isIgnoredMark = (mark: any) =>
        mark.type.spec.code || ignoreMarks.includes(mark.type.name);
      const marks = state.storedMarks ?? $from.marks();
      if (marks.some(isIgnoredMark)) return true;
      let ignored = false;
      if (to > from) {
        state.doc.nodesBetween(from, to, (node) => {
          if (node.marks.some(isIgnoredMark)) ignored = true;
        });
      }
      return ignored;
    };

    const handleTextInput = (view: EditorView, from: number, to: number, text: string) => {
      if (!extension.storage.enabled || view.composing) return false;
      const { state } = view;
      const pluginState = autocorrectPluginKey.getState(state);
      const $from = state.doc.resolve(from);
      if (!$from.parent.isTextblock || !$from.sameParent(state.doc.resolve(to))) {
        return false;
      }

      const insertTyped = () => {
        const tr = state.tr.insertText(text, from, to);
        if (pluginState?.closePending) closeHistory(tr);
        view.dispatch(tr);
      };

      if (isIgnored(state, from, to)) return false;
      const textBefore =
        $from.parent.textBetween(0, $from.parentOffset, undefined, "￼") + text;
      if (extension.options.ignorePromptTokens && isInsidePromptToken(textBefore)) {
        return false;
      }
      // Leave URLs alone.
      const currentWord = /\S*$/.exec(textBefore)?.[0] ?? "";
      if (/:\/\/|^www\./i.test(currentWord)) return false;

      const exceptions = extension.storage.exceptions;
      const found = findAutocorrection(textBefore, extension.options.rules, {
        state,
        isException: (value) => exceptions.has(value.toLowerCase()),
      });
      if (!found) {
        if (!pluginState?.closePending) return false;
        insertTyped();
        return true;
      }

      // Only replace the part that actually changes.
      let { original, replacement } = found;
      let start = found.start;
      let prefix = 0;
      while (
        prefix < original.length &&
        prefix < replacement.length &&
        original[prefix] === replacement[prefix]
      ) {
        prefix++;
      }
      let suffix = 0;
      while (
        suffix < original.length - prefix &&
        suffix < replacement.length - prefix &&
        original[original.length - 1 - suffix] === replacement[replacement.length - 1 - suffix]
      ) {
        suffix++;
      }
      start += prefix;
      original = original.slice(prefix, original.length - suffix);
      replacement = replacement.slice(prefix, replacement.length - suffix);
      const textEnd = textBefore.length - suffix;

      // 1. The typed text, as a normal edit (joins the current undo group).
      insertTyped();
      // 2. The correction, as its own undo group.
      const next = view.state;
      const blockStart = next.doc.resolve(from + text.length).start();
      const correctionFrom = blockStart + start;
      const correctionTo = blockStart + textEnd;
      if (
        next.doc.textBetween(correctionFrom, correctionTo, undefined, "￼") !== original ||
        isIgnored(next, correctionFrom, correctionTo)
      ) {
        return true;
      }
      const correction: AutocorrectCorrection = {
        ruleId: found.ruleId,
        from: correctionFrom,
        to: correctionFrom + replacement.length,
        original,
        replacement,
      };
      const tr = next.tr.insertText(replacement, correctionFrom, correctionTo);
      closeHistory(tr);
      tr.setMeta(autocorrectPluginKey, { correction });
      view.dispatch(tr);
      extension.options.onCorrection?.(correction);
      return true;
    };

    return [
      new Plugin<AutocorrectPluginState>({
        key: autocorrectPluginKey,
        state: {
          init: () => ({ last: null, closePending: false }),
          apply: (tr, prev) => {
            const meta = tr.getMeta(autocorrectPluginKey);
            if (meta?.correction) return { last: meta.correction, closePending: true };
            if (meta?.undo) return { last: null, closePending: true };
            if (!tr.docChanged) return prev;
            if (!prev.last && !prev.closePending) return prev;
            // Any other edit (including the next typed character, which
            // `handleTextInput` already put in a new undo group) ends the
            // window in which the correction can be reverted.
            return { last: null, closePending: false };
          },
        },
        props: { handleTextInput },
      }),
    ];
  },
});
