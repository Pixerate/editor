---
"@pixerate/editor": minor
---

House style: safer loading and smaller prompts (#774).

- Style skill frontmatter is read by a strict YAML subset (`parseYaml`, `parseFrontmatter`): maps, lists, flow `[a, b]` / `{ a: 1 }`, quotes, block text, comments. Anchors, aliases, tags, `?` keys, several documents and duplicate keys are refused with the line; the skill still loads and lists the problem as an issue.
- A profile can sit under its domain's frontmatter key (`chart:`) for stores that keep only `SKILL.md`; a `chart.json` of the same skill wins.
- File limits (`createStyleResolver({ limits })`, `DEFAULT_STYLE_LIMITS`): files up to 256 KB, 200 files, four folders deep, text types only, no hidden or `..` paths. Oversized `SKILL.md` copies and profiles are left out with an issue; `readFile` / `get_style_file` refuse unsafe paths with the reason; `checkStyleSkill` also checks the 4 MB skill total and marks files `left-out`. `styleFilePathProblem` and `STYLE_TEXT_FILE` are exported.
- `renderStyleCatalog(skills)` renders a short `<style_catalog>` of switched-on skills for system prompts. `renderStyle` now escapes block tags in profile and brand JSON as well as in skill bodies.
