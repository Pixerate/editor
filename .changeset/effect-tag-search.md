---
"@pixerate/editor": minor
---

Effect search by tag. `EffectSearchOptions.tags` keeps effects carrying every tag (any case, spaces as hyphens), applied by `searchEffectSummaries`; `normaliseEffectTag`, `hasEffectTags` and `countEffectTags` are exported. The `search_effects` tool takes `tags`, returns each effect's tags, and lists the tags of everything it matched with their counts, so an agent can browse a catalog's tags and narrow by them. A tag the catalog does not have comes back in `unknownTags` with the nearest ones.
