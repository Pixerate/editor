import type { Editor } from "@tiptap/core";
import type { CommandParamsSchema, CommandSpec } from "../../commands/registry";
import { compileFindPattern, type FindOptions } from "./pattern";
import { findReplacePluginKey, getFindReplaceState } from "./extension";

export interface FindReplaceCommandOptions {
  /** Id prefix (default `findReplace.`). */
  prefix?: string;
  group?: string;
  scope?: string;
  /**
   * Give the open commands default shortcuts (Mod+F, Mod+H). Off by default
   * because the `FindReplace` extension already binds them inside the editor.
   */
  shortcuts?: boolean;
}

interface SearchParams extends FindOptions {
  query?: string;
  replacement?: string;
}

const OPTION_KEYS = [
  "matchCase",
  "wholeWord",
  "matchPrefix",
  "matchSuffix",
  "ignorePunctuation",
  "ignoreWhitespace",
  "wildcards",
  "regex",
  "literal",
] as const satisfies readonly (keyof FindOptions)[];

const searchParams = (withReplacement: boolean): CommandParamsSchema => ({
  type: "object",
  properties: {
    query: { type: "string", description: "Find what. Word ^ codes (^p, ^t, ^#) unless literal." },
    ...(withReplacement
      ? {
          replacement: {
            type: "string",
            description: "Replace with. ^& is the found text; with wildcards, \\1-\\9 are groups.",
          },
        }
      : {}),
    ...Object.fromEntries(OPTION_KEYS.map((key) => [key, { type: "boolean" }])),
  },
  additionalProperties: false,
});

function splitParams(params: SearchParams | undefined) {
  if (!params) return null;
  const options: Partial<FindOptions> = {};
  for (const key of OPTION_KEYS) if (params[key] !== undefined) options[key] = params[key];
  return {
    ...(params.query !== undefined ? { query: params.query } : {}),
    ...(params.replacement !== undefined ? { replacement: params.replacement } : {}),
    options,
  };
}

const usable = (editor: Editor) =>
  !editor.isDestroyed && findReplacePluginKey.getState(editor.state)
    ? true
    : "Find and Replace is not available.";

/**
 * Find and Replace commands for the command registry (`@pixerate/editor/commands`):
 * open the bar, step through matches, and find / replace with explicit
 * params (useful for agents). Requires the `FindReplace` extension.
 */
export function createFindReplaceCommands(
  editor: Editor,
  options: FindReplaceCommandOptions = {},
): CommandSpec[] {
  const prefix = options.prefix ?? "findReplace.";
  const group = options.group ?? "Edit";
  const scope = options.scope ? { scope: options.scope } : {};
  const state = () => getFindReplaceState(editor);
  const hasMatches = () => {
    const ok = usable(editor);
    if (ok !== true) return ok;
    return state()?.matches.length ? true : "No matches.";
  };
  const apply = (params: SearchParams | undefined) => {
    const split = splitParams(params);
    if (split) editor.commands.setSearch(split);
  };
  const failIfInvalid = () => {
    const s = state();
    if (s?.error) throw new Error(s.error.message);
  };

  return [
    {
      id: `${prefix}open`,
      label: "Find",
      group,
      keywords: ["search", "find"],
      description: "Shows the find bar.",
      ...(options.shortcuts ? { shortcut: "Mod+F" } : {}),
      ...scope,
      enabled: () => usable(editor),
      run: () => editor.commands.openFindReplace({ mode: "find" }),
    },
    {
      id: `${prefix}openReplace`,
      label: "Replace",
      group,
      keywords: ["search", "substitute"],
      description: "Shows the find bar with the replace field.",
      ...(options.shortcuts ? { shortcut: "Mod+H" } : {}),
      ...scope,
      enabled: () => usable(editor),
      run: () => editor.commands.openFindReplace({ mode: "replace" }),
    },
    {
      id: `${prefix}find`,
      label: "Find text",
      group,
      description: "Searches the document and returns the number of matches.",
      params: searchParams(false),
      readOnly: true,
      ...scope,
      enabled: () => usable(editor),
      run: (_ctx: unknown, params: SearchParams) => {
        apply(params);
        failIfInvalid();
        const s = state();
        return {
          count: s?.matches.length ?? 0,
          truncated: s?.truncated ?? false,
          matches: (s?.matches ?? []).slice(0, 200).map(({ from, to, text }) => ({ from, to, text })),
        };
      },
    },
    {
      id: `${prefix}next`,
      label: "Find next",
      group,
      ...scope,
      enabled: hasMatches,
      run: () => editor.commands.findNext(),
    },
    {
      id: `${prefix}previous`,
      label: "Find previous",
      group,
      ...scope,
      enabled: hasMatches,
      run: () => editor.commands.findPrevious(),
    },
    {
      id: `${prefix}replaceAll`,
      label: "Replace all",
      group,
      description: "Replaces every match (one undo step). Tracked when Track Changes is on.",
      params: searchParams(true),
      ...scope,
      enabled: (_ctx: unknown, params: SearchParams | undefined) =>
        params?.query !== undefined ? usable(editor) : hasMatches(),
      run: (_ctx: unknown, params: SearchParams) => {
        apply(params);
        failIfInvalid();
        const count = state()?.matches.length ?? 0;
        if (count) editor.commands.replaceAll();
        return { replaced: count };
      },
    },
  ];
}

/** Validates Find text without an editor (e.g. to show an error while typing). */
export function validateFindPattern(query: string, options: FindOptions = {}) {
  const result = compileFindPattern(query, options);
  return result.ok ? null : result.error;
}
