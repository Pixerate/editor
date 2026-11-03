---
name: pixerate-stickers
description: How to find, check and use stickers from the Pixerate sticker library through find_stickers and describe_sticker - the editor's own stamps (editor:star, editor:heart, ...) or any library a host plugged in (brand packs, uploads, third-party APIs), with refs (provider:id), categories, tags, tintable art and licences. Use when asked to add, spray, place, search for or credit stickers, or when find_stickers or describe_sticker are available.
---

# Stickers

A sticker library is a `StickerProvider` the host plugs in (`@pixerate/editor/stickers`); with
none, it is the editor's own stamps (`editorStickers()`: `editor:dot`, `editor:star`,
`editor:heart`, `editor:leaf`, `editor:flower`, `editor:confetti`, `editor:splat`,
`editor:sparkle`, `editor:ring`, all MIT and tintable). Every sticker is named by a **ref**,
`provider:id`; the editors' sticker tools take refs.

## Working method

1. **Find.** `find_stickers` with a few words (`query`) and, when the result's `categories`
   suggest one, a `category`. Pages are small: pass `next` as `after` for more, or narrow the
   query. Filter with `commercial: true` for anything that will be sold or used in marketing.
2. **Check.** `describe_sticker` when the choice matters: its licence (and the attribution line
   it asks for), dominant colours, variants and outline.
3. **Use.** Pass refs to the editor that places them: in the paint editor, a sticker brush
   (`set_brush` `sticker.stamps`, then `paint_stroke`) sprays them and `add_stickers` places
   them exactly. A provider's art loads before it is drawn.
4. **Colour.** Tintable stickers (flat, single-colour art) take the paint colour or a sticker's
   `color`; the rest keep their own colours.

## Best practices

- Keep refs exactly as `find_stickers` returns them; a bare editor stamp (`star`) also works
  and means `editor:star`.
- Credit stickers whose licence has an `attribution` wherever the work is published.
- Prefer tintable stickers when they must match a palette.

## Pitfalls

- An unknown ref is refused with the closest refs: pick one of those or search again.
- A category that the library doesn't have is refused with the list of its categories.
- `limit` is 1..100; results beyond a page need `after`, not a larger limit.

## Tool reference

| Tool | Use |
| --- | --- |
| `find_stickers` | Search or list the library: `query`, `category`, `tags`, `commercial`, `limit`, `after`. Returns `items` (each `ref`, name, category, tags, width, height, formats, tintable, licence), `total`, `next`, `categories`. Changes nothing. |
| `describe_sticker` | One sticker by `ref`: everything `find_stickers` returns plus `silhouette` (SVG path data), `colours` and `variants`. Unknown refs are refused with the closest ones. Changes nothing. |
