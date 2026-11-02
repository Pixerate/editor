---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Fill a provider's sequence templates in the animation and video editors.

- `fillEffectTemplate` does the following in order:
  1. checks the values against the template's slots, refusing every problem at once;
  2. fills the template;
  3. checks the sequence against the provider's catalog before anything loads.
- `AnimationEditorController.fillTemplate` makes a new scene from a template, or appends its shots scaled to the artwork (`motionShotsFromSequence`). Layers, transitions, framings and camera moves carry over; titles and captions become overlay word layers.
- `VideoEditorController.fillTemplate` puts a template on new tracks at a time (`videoEditsFromSequence`). Each shot's bottom layer goes on a base track carrying the shots' transitions; other layers become effect, picture and text clips by role. Open slots become named placeholder clips.
- Each fill is one undo step.
- New agent tools on both editors' effect tool providers: `list_templates`, `describe_template` (with a values JSON Schema and example values) and `fill_template`.
- New `<EffectTemplates>` component for React and Svelte: a form built from the slots and checked as you type, shown in `<AnimationEffectsPanel>` and `<VideoEffectsPanel>`.
- The helpers `effectSequenceTiming` and `effectLayerSpan`.
