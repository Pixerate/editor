---
"@pixerate/editor": minor
---

House style: variants with `extends`, and profile versions with migrations (#793, #794).

- A style skill can build on another with `extends: <skill>` in its frontmatter. Its profiles (`brand.json` included) merge over the base's chain (objects field by field, lists and values replace) and are validated whole, so a variant gives only what differs. The base is the copy in use across layers, and a switched-off base still serves. `list_styles` and `get_style` report `inherits`; `sources` say `<layer> (from <base>)` for inherited fields. A missing base, a circle or a chain deeper than `MAX_STYLE_INHERITANCE_DEPTH` (8) leaves the variant's profiles out with an issue naming the skills.
- `checkStyleSkill` takes `bases` (a resolver) to check a draft over its installed base; `check_style_skill` and `save_style` use the host's. `pixerate-style check` reads a base from a sibling folder. `removeStyleSkill` / `remove_style` report `extendedBy`.
- `StyleDomain.profileVersion` and `migrateProfile(profile, from, { partial })`: each profile copy records its `"version"` (missing means 1) and is upgraded step by step when read. Nothing is written back; `StyleSkillInfo.migrations` (and `checkStyleSkill`'s) hold the upgraded copies to save. Newer, malformed or unmigratable versions leave the profile out with the file named. `get_style_schema`, `styleProfileSchema` and `scaffoldStyleSkill` include the version.
- A later layer giving a locked field the value it already has is no longer reported as an attempt to change it.
