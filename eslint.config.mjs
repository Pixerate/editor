import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.svelte"],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
    plugins: {
      // Existing files contain `eslint-disable-next-line react-hooks/exhaustive-deps` comments.
      "react-hooks": {
        rules: {
          "exhaustive-deps": { meta: {}, create: () => ({}) },
        },
      },
    },
  },
  {
    files: ["packages/core/src/tools/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "dagre", message: "packages/core/src/tools must stay dependency-free." },
            { name: "react", message: "packages/core/src/tools must not import React." },
            { name: "react-dom", message: "packages/core/src/tools must not import react-dom." },
            { name: "svelte", message: "packages/core/src/tools must not import Svelte." },
          ],
          patterns: [
            {
              group: ["@tiptap/*", "prosemirror-*", "@dagrejs/*", "react/*", "svelte/*"],
              message: "packages/core/src/tools must not import TipTap, ProseMirror, dagre, React, or Svelte.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/react/src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "svelte", message: "packages/react must not import Svelte." }],
          patterns: [
            {
              group: ["svelte/*", "@pixerate/editor-svelte*"],
              message: "packages/react must not import Svelte or @pixerate/editor-svelte.",
            },
            {
              group: ["../../core*", "../../../core*"],
              message: "Import from @pixerate/editor instead of relative paths into packages/core.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/svelte/src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: "packages/svelte must not import React." },
            { name: "react-dom", message: "packages/svelte must not import react-dom." },
          ],
          patterns: [
            {
              group: ["react/*", "@pixerate/editor-react*"],
              message: "packages/svelte must not import React or @pixerate/editor-react.",
            },
            {
              group: ["../../core*", "../../../core*"],
              message: "Import from @pixerate/editor instead of relative paths into packages/core.",
            },
          ],
        },
      ],
    },
  },
];
