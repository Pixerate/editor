---
name: pixerate-talking-head-edit
description: How to clean up talking-head, interview, podcast and voiceover video in the Pixerate video editor by its transcript - finding filler words, long pauses and stutters in one pass, reviewing them, proposing the cuts as one edit plan the user previews before it applies, keeping breath around cuts, and checking the result. Use when asked to tighten dialogue, remove ums and ahs, cut dead air, clean up a talking head or make a rough cut of an interview, or when find_video_disfluencies or plan_video_dialogue_cleanup are available.
---

# Pixerate talking-head cleanup

Spoken media in a video project carries a **transcript**: each word with its start and end in
the source. The editor maps the words through the clips onto the timeline, so a word's place is
always where it plays now, however the clips were cut. Cleaning up speech is then a matter of
finding stretches of the timeline (fillers, long pauses, stutters) and cutting them out on every
sync-locked track at once, so picture, sound and B-roll stay in sync.

Cleanup is **plan first**: propose the cuts as one plan, let the user review it (the editor
shows the plan with its length change and every stretch it cuts), then apply it as one undo step.
Never cut a whole interview's disfluencies without a review.

This skill works with the video editor's own tools (`pixerate-video-editor`): transcripts,
`get_video_transcript`, `remove_video_ranges`, `apply_video_edit_plan`, `render_video_frame`.
See `pixerate-agent-tools` for errors and undo.

## Working method

1. **Make sure there is a transcript.** `get_video_project` shows which assets have one; if the
   speech has none, ask the host or user for a Whisper-style JSON, `.srt` or `.vtt` file and
   attach it with `set_video_transcript`. Captions without word timings are approximate: cuts
   on them may clip words, so prefer word-timed transcripts.
2. **Read the speech.** `get_video_transcript` for the text and the word list (the indexes the
   find tool returns refer to it).
3. **Find what to tidy.** `find_video_disfluencies` lists fillers (um, uh, er, you know, I
   mean…), pauses longer than `min_pause` (default 700 ms, keeping `keep` ms of breath either
   side) and repeated words or phrases ("I I think", "we should we should"), with a total per
   kind and how much time the cuts would remove.
4. **Review.** Read the list against the transcript. Keep repeats that are meant ("very very"),
   pauses that land a point, and fillers that carry meaning ("like" and "so" are not in the
   defaults for that reason). Note the `from` times of finds to keep.
5. **Propose.** `plan_video_dialogue_cleanup` with the same options and `exclude` (the `from`
   times to keep) proposes the cuts as one plan; nothing changes yet. Tell the user what it does
   (its `text`: stretches and seconds removed) and ask them to review it in the editor.
6. **Apply.** Once they agree, `apply_video_edit_plan` with the plan id (or
   `discard_video_edit_plan`). If they edited meanwhile, the plan is re-checked; if it no longer
   applies, find and plan again.
7. **Check.** `get_video_transcript` again (every time after a cut moved), listen at a few cuts
   with `get_video_frame` (audio gains) and look with `render_video_frame` for jump cuts in the
   picture: cover those with B-roll on a higher track or a slight push-in (`set_video_keyframes`
   `scale` 1 to 1.05).

## Best practices

- **Breath matters.** Cut pauses down, not out: keep 150-250 ms either side (`keep`) so speech
  does not sound breathless. For fillers and stutters, `margin` 20-60 ms avoids clipping the
  words around a cut when word timings are loose.
- **Brisk or relaxed.** For social clips and explainers, `min_pause` 500-600 ms; for
  interviews and documentary, 900-1200 ms so thinking pauses stay.
- **One plan, one undo.** Propose the whole cleanup as one plan rather than many small cuts:
  the user reviews it once and can undo it in one step.
- **Words cut with their picture.** The cut runs across every unlocked sync-locked track. A
  music bed that should keep playing must have `syncLocked: false` (`update_video_track`)
  before the plan is applied, or it is cut too.
- **Duck music after cleanup.** Speech has moved, so duck background music once the dialogue
  is final (`duck_video_music`, in `pixerate-bgm-alignment`).

## Tool reference

| Tool | When and how to use it |
| --- | --- |
| `find_video_disfluencies` | Read-only. Lists fillers, long pauses and stutters in time order as `{ kind, from, to, text, words }` (timeline ms; `words` are the first and last indexes in `get_video_transcript`'s list; for a pause, the words either side), with `totals` per kind and `removable` time once merged. Options: `track`, `kinds` (`filler`, `pause`, `repetition`), `fillers` (your own list), `min_pause` (ms, default 700), `keep` (breath either side of a pause cut, default 150), `max_phrase` (longest repeat checked, default 3 words). Review it before planning. |
| `plan_video_dialogue_cleanup` | Proposes cutting the finds as one plan for review (nothing changes): the same options as the find tool, plus `exclude` (the `from` times of finds to keep), `margin` (ms left at each end of filler and stutter cuts, default 0) and a `title`. Returns the plan (id, title, summary with the length change, `text`) and a hint. Apply with `apply_video_edit_plan`, or `discard_video_edit_plan`. Fails when nothing is left to cut. |

## Pitfalls

- **Overlapping finds.** A filler inside a stutter is listed twice; the plan merges the ranges,
  so it is cut once. Do not add the same stretch again through `remove_video_ranges`.
- **Stale plans.** Applying a plan after other edits re-checks it; if it is refused, run the find
  and plan again rather than applying old times by hand.
- **Approximate transcripts.** Captions spread words evenly over each cue, so a "filler" may be a
  neighbour's syllable. Check the find's `text` against `get_video_transcript`, and prefer
  word-timed transcripts for cleanup.
- **Transcripts come from the host.** Speech recognition is the host's job: the editor never sends
  media anywhere. Ask for a transcript rather than guessing words from audio levels.
