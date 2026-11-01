---
"@pixerate/editor": patch
---

`searchTools` (and the `search_tools` discovery tool) no longer re-tokenizes the whole tool catalogue on every query. Token sets are cached by text and argument text by schema object, so a search over the ~580 built-in tools takes about a tenth of the time and still picks up a re-registered tool or a changed toolset title or description. Rankings and scores are unchanged.
