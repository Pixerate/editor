---
"@pixerate/editor": minor
---

House style: an authoring kit for the people who write style skills (#775).

- `checkStyleSkill(name, files, { domains, tokens })` reads a draft skill exactly as a resolver would and reports `ok`, errors (what would be left out and why), warnings, each file's role, the profile each domain gets and the brand. Agents get it as the `check_style_skill` tool.
- `styleProfileSchema(domain)` is a domain's standalone JSON Schema with its checks; profiles may carry `"$schema"` for editor completion (ignored when they load). `StyleDomain.example` gives each domain a valid example (brand, chart, tokens), which `get_style_schema` now returns along with the shared checks.
- `scaffoldStyleSkill` starts a skill from the examples; `renderStylePreview` draws a report as an HTML page with brand swatches, fonts, the logo and a sample per domain (`StyleDomain.preview`; charts draw a sample bar chart, `chartStylePreview`).
- New `pixerate-style` command: `check` (exit 1 on errors, `--json`, `--tokens`), `init`, `schema` and `preview` (live reload on 127.0.0.1).
- `styleStoreConformance` and `STYLE_FIXTURE_SKILLS` test a host's own `StyleStore`.
- `StyleResolver.tokens` exposes the token source; `STYLE_SKILL_NAME` is exported.
