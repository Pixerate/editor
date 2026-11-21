---
"@pixerate/editor": patch
"@pixerate/swift": patch
---

Text mechanics fix the word inside closing emphasis markers (#899): `*dont* `, `_i dont know_ `, `~cant~ ` and `**dont** ` get their apostrophe and capital I with the markers left as they are, in both the prose and chat profiles. The identifier check ignores emphasis that opens a token, while `file_dont` and `snake_case_` stay untouched. A closed bold word that starts a paragraph now gets its sentence capital (`**Bold** start`), like one still being typed. New `textMechanicsWordEnd` (Swift `TextMechanics.wordEnd(at:ns:)`) gives the end of the word a boundary closes.
