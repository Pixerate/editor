import { Extension, textInputRule } from "@tiptap/core";
import type { AutocorrectRule } from "./autocorrect";

/**
 * Smilie patterns (each ending in a typed space) and their replacements.
 * Longer patterns come first so they win over their prefixes.
 */
export const SMILIE_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-___- $/, "😑 "],
  [/:'-\) $/, "😂 "],
  [/':-\) $/, "😅 "],
  [/':-D $/, "😅 "],
  [/>:-\) $/, "😆 "],
  [/-__- $/, "😑 "],
  [/':-\( $/, "😓 "],
  [/:'-\( $/, "😢 "],
  [/>:-\( $/, "😠 "],
  [/O:-\) $/, "😇 "],
  [/:'\) $/, "😂 "],
  [/:-D $/, "😃 "],
  [/':\) $/, "😅 "],
  [/;-\) $/, "😉 "],
  [/B-\) $/, "😎 "],
  [/:-\* $/, "😘 "],
  [/:-\) $/, "🙂 "],
  [/-_- $/, "😑 "],
  [/:-O $/, "😮 "],
  [/:-P $/, "😛 "],
  [/:-p $/, "😛 "],
  [/:-\/ $/, "😕 "],
  [/:-\( $/, "😞 "],
  [/:'\( $/, "😢 "],
  [/:D $/, "😃 "],
  [/=D $/, "😃 "],
  [/;\) $/, "😉 "],
  [/B\) $/, "😎 "],
  [/:\) $/, "🙂 "],
  [/=\) $/, "🙂 "],
  [/:O $/, "😮 "],
  [/:P $/, "😛 "],
  [/:p $/, "😛 "],
  [/:\/ $/, "😕 "],
  [/:\( $/, "😞 "],
  [/<3 $/, "❤️ "],
  [/<\/3 $/, "💔 "],
  [/\/shrug $/, "¯\\_(ツ)_/¯ "],
];

/**
 * The smilies as `Autocorrect` rules. Straight apostrophes in the patterns
 * also match curly `‘` and `’`, because the smart-quote rule converts `'` as soon as
 * it is typed.
 */
export const smilieAutocorrectRules: AutocorrectRule[] = SMILIE_REPLACEMENTS.map(
  ([find, replace], index) => ({
    id: `smilie:${index}`,
    find: new RegExp(find.source.replace(/'/g, "['\u2018\u2019]"), find.flags),
    replace,
  }),
);

export const SmilieReplacer = Extension.create({
  name: "smilieReplacer",

  addInputRules() {
    return SMILIE_REPLACEMENTS.map(([find, replace]) =>
      textInputRule({ find, replace }),
    );
  },
});
