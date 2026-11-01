import { describe, expect, it } from 'vitest';
import { ImageEditorController, createImageEditorToolProvider, imagePlaybackPanel } from '../src/image-editor';

/** Write tools that change no panel's content: history, the document's mode and depth, PSD import. */
const NO_PANEL = new Set(['undo_image', 'redo_image', 'set_bit_depth', 'set_color_mode', 'import_psd']);

describe('image playback panels', () => {
  it('plays every write tool in a panel, so a new tool shows where its change happens', () => {
    const fake = { width: 20, height: 10, naturalWidth: 20, naturalHeight: 10 } as unknown as HTMLImageElement;
    const tools = createImageEditorToolProvider(new ImageEditorController({ image: fake })).tools;
    const missing = tools.filter((t) => !t.annotations?.readOnlyHint && !NO_PANEL.has(t.name) && imagePlaybackPanel(t.name) === null).map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it('plays the selection diff, recipe and Separate Subject in Select, and edge colour in Layers', () => {
    for (const name of ['compare_selections', 'edit_selection_step', 'insert_selection_step', 'remove_selection_step', 'freeze_selection', 'separate_subject']) {
      expect(imagePlaybackPanel(name), name).toBe('select');
    }
    for (const name of ['set_edge_decontamination', 'set_edge_despill', 'set_edge_ambient']) expect(imagePlaybackPanel(name), name).toBe('layers');
  });
});
