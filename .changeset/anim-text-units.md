---
"@pixerate/editor": minor
---

Outlined text can animate a letter, word or line at a time.

- **Splitting:** any command takes `split: "letter" | "word" | "line"` for a group of letter paths, meaning text converted to outlines.
- **Reading order:** letters are sorted into lines by vertical overlap and into words by spacing (`motionTextLayout`), then staggered. Defaults are 40 ms a letter, 120 a word and 300 a line.
- **Order:** `cascade` sets it: forward, backward, from the centre, from the edges, or a seeded random that is the same every time.
- **Checks:** `split-not-text` warns when the target isn't a group of letter paths.
- **Agents:** a new read tool, `get_text_layout`, shows the letters, words and lines.
