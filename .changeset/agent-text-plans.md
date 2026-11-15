---
"@pixerate/editor": minor
"@pixerate/conformance": minor
"@pixerate/swift": minor
---

Agents' text edits play out the same way in TypeScript and Swift (#878).

- `planAgentTyping(edit, options)` (`/tools`): the pure planner behind `typeAgentText`. It selects what an edit replaces, types it in ~30 fps frames (60 characters a second, at most 1.5 s), then commits. It knows no editor. `typeAgentText` now takes its timing from it, with no change in behaviour. `agentTypingDuration`, and the defaults as constants.
- `@pixerate/conformance`: a new `agent-text` domain (`manifest.json`, `typing-plans.json`) with the plans for a set of edits, exported by `agentTextContracts()` and checked by a core test.
- Swift (`PixerateCore`):
  - `planAgentTyping` reproduces every plan in the contract.
  - `AgentTextDirector` plays an edit on any `AgentTextTarget`: the agent's caret selects the range, the typing shows as previews outside the undo history, the original goes back, and the edit commits as one undo step. Calls run one after another per agent. An edit by the person inside the range (`noteEdit`), an unreported change, or cancelling stops the call and leaves the text as it was.
  - `AgentCaretStore`: carets, selections and changed-text tints for a host to draw, mapped through other people's edits.
  - `PresenceClock`, with `RealPresenceClock` and `InstantPresenceClock`.
