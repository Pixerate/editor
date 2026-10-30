---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Image editor: alpha channels (saved selections) and an editable Quick Mask.

- **Alpha channels:**
  - `state.channels` holds `AlphaChannel { id, name, mask, color, opacity, indicates, visible }`. Channels are part of undo history and are saved in `toJSON` (RLE, like the selection).
  - Controller: `saveSelection`, `loadSelectionFromChannel`, `setChannelProperties`, `duplicateChannel`, `deleteChannel`, `getChannels` and `describeChannels`.
  - Visible channels draw as their tint (`QuickMaskStyle.indicates` covers the selected or masked area).
  - Agent tools: `list_channels`, `save_selection`, `load_selection_from_channel`, `set_channel_properties`, `duplicate_channel` and `delete_channel`.
- **PSD:** alpha channels are written and read as extra merged-image planes, with their names (resources 1006 and 1045) and colour, opacity and what the colour indicates (1077). `PsdImportResult.alphaChannels` and `PsdExportInput.alphaChannels` carry them.
- **Quick Mask mode:**
  - `setQuickMaskMode(on)` / `quickMaskEditing`, and the tool `set_quick_mask`.
  - While it is on, `paint_stroke`, `fill_pixels`, `clear_pixels`, `stroke_selection` and the retouch tools, called without a layer, paint the selection itself through the new `quick-mask` paint target. White selects and black deselects, and each edit is one undo step.
  - An empty selection shows fully tinted.
  - Q toggles the mode on the canvas (`handleQuickMaskKey`, and in `handlePaintShortcut`).
- **React and Svelte:** a new `ChannelsPanel` in the Select & Mask tab.
  - It has thumbnails and an eye to show each channel.
  - A click loads a channel (Shift adds, Alt subtracts); a double-click renames it.
  - Buttons: Save Selection, Add to Channel, Duplicate, Delete and Quick Mask.
- **Skills:** both image skills cover channels and Quick Mask.
