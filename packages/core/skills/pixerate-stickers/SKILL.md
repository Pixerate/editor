---
name: pixerate-stickers
description: How to find, check and use stickers from the Pixerate sticker library through find_stickers and describe_sticker - the editor's own stamps (editor:star, editor:heart, ...) or any library a host plugged in (brand packs, uploads, third-party APIs), with refs (provider:id), categories, collections, tags, tintable art, light / dark variants, AI-generated labels and licences. Use when asked to add, spray, place, search for or credit stickers, or when find_stickers or describe_sticker are available.
---

# Stickers

A sticker library is a `StickerProvider` the host plugs in (`@pixerate/editor/stickers`); with
none, it is the editor's own stamps (`editorStickers()`: `editor:dot`, `editor:star`,
`editor:heart`, `editor:leaf`, `editor:flower`, `editor:confetti`, `editor:splat`,
`editor:sparkle`, `editor:ring`, all MIT and tintable). Every sticker is named by a **ref**,
`provider:id`; the editors' sticker tools take refs.

## Working method

1. **Find.** `find_stickers` with a few words (`query`) and, when the result's `categories`
   suggest one, a `category`. When the result lists `collections` (themed sets, such as one per
   brand) and the job names one, pass its id as `collection`. Pages are small: pass `next` as
   `after` for more, or narrow the query. Filter with `commercial: true` for anything that will
   be sold or used in marketing.
2. **Check.** `describe_sticker` when the choice matters: its licence (and the attribution line
   it asks for), whether the art is `aiGenerated`, its `variants`, dominant colours and outline.
3. **Use.** Pass refs to the editor that places them: in the paint editor, a sticker brush
   (`set_brush` `tip.stamps`, then `paint_stroke`) sprays them and `add_stickers` places
   them exactly. In the vector, image and canvas editors, `insert_sticker` puts one in (`x`,
   `y` centre, `width`): vector, a group of editable paths; image, a pixel layer; canvas, a
   shape node from its outline in one colour. A provider's art loads before it is drawn.
4. **Colour.** Tintable stickers (flat, single-colour art) take the paint colour or a sticker's
   `color`; the rest keep their own colours. A sticker whose `variants` include `dark` has art
   drawn for dark backgrounds: `insert_sticker` uses it when the host's canvas or theme is dark
   (or pass `variant`), and the paint editor's sticker brush sprays it on a dark colour scheme
   (each sticker keeps the variant it was drawn in).
5. **Treat it with an effect.** In the image editor, `insert_sticker` returns the layer `id`;
   `apply_effect` with that `target` and any effect whose `describe_effect` inputs take an
   image (`appliesHere`) uses the sticker as its picture (holo foil, cut-out). For a whole set,
   repeat the two calls per sticker.

## Best practices

- Keep refs exactly as `find_stickers` returns them; a bare editor stamp (`star`) also works
  and means `editor:star`.
- Credit stickers whose licence has an `attribution` wherever the work is published.
- Say when art is `aiGenerated: true` if the user asked for hand-made art or must disclose AI
  content; absent means the provider didn't say, not that it is hand-made.
- Leave `variant` out of `insert_sticker` unless the user asked for one: the default matches the
  background.
- Prefer tintable stickers when they must match a palette.
- Animated stickers (`animated: true`, with `frameCount` and `frameDelay` in ms) are drawn one
  frame at a time: a paint sticker brush picks frames with `marks.frameMode` (`perform` by stroke
  time, `random` seeded), and `add_stickers` / `update_sticker` take a `frame` below `frameCount`.
- Vector stickers need SVG art and canvas stickers an outline (`silhouette`); `find_stickers`
  lists `formats`, and `describe_sticker` the outline. The image editor takes either.

## Pitfalls

- An unknown ref is refused with the closest refs: pick one of those or search again.
- A category or collection that the library doesn't have is refused with the list of its
  categories or collections. In a combined library, collection ids are `provider:collection`.
- `variant: "dark"` on a sticker without a dark variant is refused; check `variants` first.
- `limit` is 1..100; results beyond a page need `after`, not a larger limit.
- `color` on a sticker that is not tintable is refused; leave it out.
- On the canvas, multi-colour art becomes its outline in its dominant colour; for the art itself,
  use the image editor (the vector and canvas editors take effects on stickers in a later change).

## Tool reference

| Tool | Use |
| --- | --- |
| `find_stickers` | Search or list the library: `query`, `category`, `collection`, `tags`, `commercial`, `limit`, `after`. Returns `items` (each `ref`, name, category, collection, tags, width, height, formats, tintable, aiGenerated, variants, animated, frameCount, frameDelay, licence), `total`, `next`, `categories`, `collections`. Changes nothing. |
| `insert_sticker` | Put one sticker (`ref`) into the vector, image or canvas editor, centred at `x`, `y` (default the middle), `width` wide (default natural), tinted with `color` when tintable, in its dark `variant` on a dark background (or the one passed). One undo step. Returns the new group, layer or node `id`, the size, the `variant` used and the licence. |
| `describe_sticker` | One sticker by `ref`: everything `find_stickers` returns plus `silhouette` (SVG path data) and `colours`. Unknown refs are refused with the closest ones. Changes nothing. |
