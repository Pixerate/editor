---
name: pixerate-video-social-cut
description: The social video workflow in the Pixerate video editor - reframing for vertical (9:16) or square, opening on the hook in the first seconds, cutting to platform length, titles and captions inside the safe area, pacing for the feed, loudness for mobile and an export for Reels, TikTok, Shorts or a feed post. Use when asked to make a social cut, a vertical, Reels, TikTok, Shorts or story version, a teaser or trailer for social, a short clip from a longer video, or to reframe, caption or title a video for social, or when set_video_settings, update_video_clip and add_video_marker are available. Load with pixerate-video-editor, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-video-editor
---

# Cutting for social

A social cut is watched on a phone, often without sound, by someone who decides in the first
second or two whether to stay. So the frame is vertical or square and filled, the strongest
moment comes first, every shot earns its place, and words are on screen. Build it as its own
project or sequence from the long edit, never by damaging the original.

This skill is the method. `pixerate-video-editor` has the full tool reference; for music and
loudness see `pixerate-bgm-alignment`.

## Goal and quality bar

- The frame suits the platform: 1080 × 1920 (9:16) for Reels, TikTok, Shorts and stories;
  1080 × 1080 or 1080 × 1350 for a feed post. The picture fills it (no black bars).
- The hook plays in the first 1-3 seconds: the most striking image or line, not a logo or a
  slow build.
- The length fits the platform and the content: 7-15 s for a loop or teaser, up to 60 s for
  most short-form, cut tight (no dead air, `find_video_gaps` empty).
- Text is readable without sound: titles and captions large, high-contrast, inside the safe
  area (away from the top 250 px and bottom 350 px of a 1920-high frame, where the app's
  interface sits).
- `check_video_project` has no errors; the mix is at the delivery loudness (-14 LUFS).

## Inputs to confirm

- **Platform(s)** and so the frame and length.
- **The hook:** a moment, a line or a marker; ask when nothing in the footage stands out.
- **Words on screen:** captions of the speech, a title, a call to action.

## Working method

1. **Read.** `get_video_project`: frame size, clips, markers (a "Hook" marker or the user's
   notes), duration. With speech, `get_video_transcript` to find the best lines.
   **Check:** you know where the hook is in the source and how long the cut should be.
2. **Set the frame.** `set_video_settings` `width` / `height`; then each clip `fit: "cover"`
   (`update_video_clip`), and `transform` `x` to keep the subject in frame when it is off-centre.
   **Check:** `get_video_project` frame size; `get_video_frame` at a few times shows the subject.
3. **Open on the hook.** Trim and move so the first clip's `in` is at the hook (`edit_video`
   with its trim and move ops, or `extract_video_range` for what goes). Then the context, then
   the payoff.
   **Check:** the clip at 0 starts at the hook's source time.
4. **Cut to length.** Remove everything that does not move the story: `remove_video_ranges` for
   pauses and fillers (`pixerate-talking-head-edit`), `extract_video_range` for whole passages.
   Keep shots short (1-3 s for montage, as long as the line for speech).
   **Check:** `get_video_project` `duration` is in range; `find_video_gaps` is empty.
5. **Words.** A video track above the footage (`add_video_track` with `at: 0`), then text clips
   (`add_video_clip` `type: "text"`) with `transform.y` in the upper or lower safe area,
   `animateIn` / `animateOut` for motion. Captions follow the transcript's sentences.
   **Check:** text clips are on the top track and inside the safe area.
6. **Sound.** Music under, dialogue on top (`pixerate-bgm-alignment`); the first second should
   work without sound and with it.
7. **Check and export.** `check_video_project`; `export_video_ffmpeg` with the loudness target.

## Decision table

| Platform | Frame | Length |
| --- | --- | --- |
| Reels, TikTok, Shorts, stories | 1080 × 1920 | 7-60 s; under 15 s loops |
| Feed post | 1080 × 1350 or 1080 × 1080 | 15-60 s |
| Landscape (YouTube, web) | 1920 × 1080 | The content's length |

| Source | Reframe |
| --- | --- |
| Subject centred | `fit: "cover"` |
| Subject off-centre | `fit: "cover"` plus `transform.x` toward the subject |
| Subject moves across the frame | Keyframe `transform.x` (`set_video_keyframes`), or split and reposition per shot |
| Wide shot that loses everything when cropped | A blurred, scaled copy behind a `contain` copy, or choose another shot |

## Recipes

**Vertical from landscape.** `set_video_settings` `{ width: 1080, height: 1920 }` → for each
picture clip `update_video_clip` `{ set: { fit: "cover" } }` → `get_video_frame` to check.

**Hook first.** Source hook at `h` ms: `edit_video` `[{ op: "trim_clip", clip, edge: "start",
to: h }, { op: "trim_clip", clip, edge: "end", to: h + length }, { op: "move_clip", clip,
start: 0 }]`.

**Opening title.** `add_video_track` `{ kind: "video", at: 0 }` → `add_video_clip` on it with
`{ type: "text", text, start: 0, duration: 3000, transform: { y: -600 } }`.

## Pitfalls

- **Letterboxing.** A landscape clip in a vertical frame with `contain` shows black bars.
- **Slow openings.** A logo, a fade-in or a wide establishing shot loses the viewer.
- **Text in the interface zones** is covered by captions, buttons and the username.
- **Relying on sound.** Most feeds autoplay muted; put the message on screen too.
- **Editing the master.** Make the social cut separately so the long version stays intact.

## Tools used

- `get_video_project`, `get_video_transcript`, `get_video_frame`, `find_video_gaps`, `check_video_project`: read and check
- `set_video_settings`: the frame size
- `update_video_clip`, `set_video_keyframes`: fit, reframe and move the picture
- `edit_video`, `trim_video_clip`, `move_video_clip`, `extract_video_range`, `remove_video_ranges`: cut to the hook and to length
- `add_video_track`, `add_video_clip`: titles and captions on a track above
- `add_video_marker`: mark the hook and beats
- `export_video_ffmpeg`: deliver
