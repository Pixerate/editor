---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Record animation takes live. Press Record and perform on the stage: drag elements to move them, scale them about their centre or turn them, and change the picked element's fill, stroke and opacity. Stop keeps the performance as one new shot, one undo step, made of ordinary commands. A path becomes one `move` through `via` waypoints reached at the recorded times (the new `times` field). Scales, turns, fades and stroke widths become a few eased commands. Paints change when they were picked.

- Core: `AnimationEditorController.startRecording`, `recordSample`, `beginRecordGesture` / `updateRecordGesture` / `endRecordGesture`, `stopRecording`, `cancelRecording`, `recordTake`, `pose`, `clientToDocument` and `state.recording`; `motionTakeShot`, `motionNodePose`, `simplifyTimedSamples`, `motionClientToDocument`; `AnimationPlayer.liveTime`; the `record_animation_take` agent tool.
- React and Svelte: `<AnimationRecordPanel>` and `<AnimationStage recordMode>`, built into `<AnimationEditor>`.
