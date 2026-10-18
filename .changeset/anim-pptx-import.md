---
"@pixerate/editor": minor
---

Animation scenes can be imported from PowerPoint with `fromPptxAnimation` and the `import_pptx_animation` agent tool (base64 `.pptx`, `slide`, dry run).

- **Shapes:** a slide's shapes become the artwork: preset and custom geometry, groups, solid fills, outlines and theme colours.
- **Animation:** its animation pane becomes a shot per click, and the scene plays on click.
  - Entrances, exits and emphasis map to the editor's commands, and motion paths become follows along hidden paths.
  - With previous and after previous, delays, repeats, auto-reverse and acceleration carry over.
- **Notes:** text, pictures, charts and effects with no match are listed.
- **Demo:** the animation tab can import a slide.
