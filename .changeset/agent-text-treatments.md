---
"@pixerate/editor": minor
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
"@pixerate/conformance": minor
"@pixerate/swift": minor
---

Agents' edits to text can be drawn with a text treatment from the effects provider (#887).

- Effects contract (`/effects`): a `text-treatment` kind and use. A provider with `capabilities.supportsTextTreatments` implements `textTreatmentPlan(id, { stage, time, target, reduceMotion? }, values?)`, which returns a layer plan for one stage of an edit (`caret`, `checking`, `selecting`, `typing`, `landed`) over the host's line rectangles. `defaultTextTreatment` names the one editors use until one is chosen. Also new: `checkTextTreatmentRequest`, `textTreatmentPlanProblems`, `planTextTreatment`, and conformance checks in `checkEffectProvider`. `createFakeEffectProvider({ textTreatments: true })` adds `fake.soft` and `fake.underline`.
- `builtInTextTreatmentPlan` is the built-in treatment: the editors' current look, plus a soft sweep while checking. Hosts draw it when there is no provider.
- `planAgentTyping` takes `edit.check` and `checkMs` (default 480): a `check` step before the selection, which a treatment draws as its checking sweep. `typeAgentText` takes `check` too.
- Rich text: `setAgentTextTreatments(editor, { provider, treatment?, reduceMotion? })` draws each agent's stages in an overlay behind and above the text. Each agent can choose its own treatment (`AgentCaretInput.treatment`, the rich-text tools' `presence.treatment`) and is drawn in its own colour. Reduce Motion is followed. Without a provider that has treatments, carets are decorations as before. `AgentCaret` now has its `stage`.
- React and Svelte: effect thumbnails label text treatments.
- `@pixerate/conformance`: the `agent-text` domain gains `treatment-plans.json` (the built-in treatment's plans) and plans with a check step.
- Swift (`PixerateCore`):
  - `AgentTypingStep.check`, `AgentTextEdit.check` and `AgentTypingOptions.checkMs`.
  - `AgentCaretStore` keeps each caret's stage, the range it checks or has typed, and when its stage began and its changes landed.
  - `AgentTextDirector` takes a `treatment` and records each stage.
  - `TextTreatmentPlan` and its types, `TextTreatmentProvider`, `BuiltInTextTreatment` (matches every plan in the contract), and `AgentTextTreatments.plans`, which turns the carets into plans for a `TextTreatmentRenderer`.
