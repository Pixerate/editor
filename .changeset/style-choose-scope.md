---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

House style: one-of-a-kind groups and scoped skills (#773).

- A style skill can join a group (`group: look` in frontmatter, or `group` in store state). Of the switched-on skills in a group only the first applies. `resolver.choose(name, { layer, scope })` switches one on and its rivals off in one write to the most specific writable layer (`StyleStore.setState`), and refuses, writing nothing, for an ungrouped skill, a read-only layer or a rival a required layer keeps on. `resolver.chosen(group)` and `resolver.choices()` read the choice; `StyleSkillInfo` gains `group`, `scope` and `chosen`.
- A skill's state can carry `scope: string[]`; scoped skills apply only when `resolve` / `check` / `list` are asked for one of their scopes. The style and check tool providers take a host-set `scope` option.
- Agent tools `list_style_choices` and `choose_style`.
- React and Svelte: `useStyleChoices(styles, scope?)` for pickers.
