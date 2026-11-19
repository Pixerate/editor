---
"@pixerate/editor": minor
"@pixerate/swift": minor
---

The style resolver in Swift (#890): `PixerateCore` ports `createStyleResolver` (`StyleResolver` over `StyleLayer`s of `StyleStore`s, `MemoryStyleStore`; locked and required layers, skill state, one-of-a-kind groups, scopes, `extends`, `$token` references through a `StyleTokenSource`, profiles in frontmatter and file limits), the strict frontmatter YAML reader (`parseYaml`, `parseFrontmatter`), `HouseStyle(resolved:)` for the domains' check tools, and `createStyleToolProvider` with `list_styles`, `get_style`, `get_style_file` and `get_style_schema`. Profile migrations and the authoring and choice tools are not ported.

`@pixerate/conformance` has a new `style` domain (`styleContracts()` in `@pixerate/editor/tools`): the read tools as recorded calls over layered memory stores, and what `get_style_schema` returns for each domain.
