import { describe, expect, it } from 'vitest';
import {
  IMAGE_TOOL_GROUPS,
  IMAGE_TOOL_SHORTCUTS,
  imagePanelTool,
  imageToolCanvasMode,
  imageToolForShortcut,
  imageToolGroup,
  imageToolLabel,
  imageToolPanel,
  imageToolPanelIds,
  imageToolPanels,
  imageToolUsesColor,
  imageToolVariants,
  SELECTION_TOOLS,
  LIVE_SHAPE_KINDS,
  type ImageEditorTool,
  type ImageLayer,
} from '../src/image-editor';

const ALL_TOOLS: ImageEditorTool[] = [
  'select', 'crop', 'pen', 'rect', 'circle', 'arrow', 'line', 'text', 'watermark', 'move', 'brush',
  'eraser', 'mixer', 'clone', 'heal', 'spot-heal', 'smudge', 'dodge', 'burn', 'sponge', 'blur',
  'sharpen', 'history', 'shape', 'type', 'path-select', 'direct-select', 'path-pen', 'eyedropper',
];
/** Drawn through the API, not the toolbar: the Shape tool's live shapes cover these annotations. */
const API_ONLY: ImageEditorTool[] = ['text', 'watermark', 'rect', 'circle', 'arrow', 'line'];

describe('image tool groups', () => {
  it('offers every drawable tool once', () => {
    const grouped = IMAGE_TOOL_GROUPS.flatMap((g) => g.tools);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(ALL_TOOLS.filter((t) => !API_ONLY.includes(t)).sort());
  });

  it('groups by intent, with Retouch split into Fix, Tone and Detail', () => {
    expect(IMAGE_TOOL_GROUPS.map((g) => g.id)).toEqual(['move', 'select', 'crop', 'draw', 'erase', 'retouch', 'shape', 'paths', 'type', 'eyedropper']);
    expect(imageToolGroup('pen').id).toBe('draw');
    expect(imageToolGroup('history').id).toBe('erase');
    const retouch = imageToolGroup('dodge');
    expect(retouch.sections?.map((s) => s.label)).toEqual(['Fix', 'Tone', 'Detail']);
    expect(retouch.sections?.flatMap((s) => s.tools)).toEqual(retouch.tools);
    expect(imageToolLabel('pen')).toBe('Pencil');
  });

  it('offers the selection tools and shape kinds as variants', () => {
    expect(imageToolVariants('select').map((v) => v.id)).toEqual(SELECTION_TOOLS.map((t) => t.id));
    expect(imageToolVariants('shape').map((v) => v.id)).toEqual([...LIVE_SHAPE_KINDS]);
    expect(imageToolVariants('shape')[0]).toEqual({ tool: 'shape', id: 'rect', label: 'Rectangle' });
    expect(imageToolVariants('brush')).toEqual([]);
  });

  it('says which tools put down a colour', () => {
    expect(imageToolUsesColor('brush')).toBe(true);
    expect(imageToolUsesColor('shape')).toBe(true);
    expect(imageToolUsesColor('eyedropper')).toBe(true);
    expect(imageToolUsesColor('eraser')).toBe(false);
    expect(imageToolUsesColor('move')).toBe(false);
  });

  it('finds a tool’s group, falling back to the first', () => {
    expect(imageToolGroup('burn').id).toBe('retouch');
    expect(imageToolGroup('text').id).toBe(IMAGE_TOOL_GROUPS[0].id);
  });

  it('labels every tool', () => {
    for (const tool of ALL_TOOLS) expect(imageToolLabel(tool)).not.toBe(tool);
    expect(imageToolLabel('spot-heal')).toBe('Spot Heal');
  });

  it('maps shortcuts to tools', () => {
    expect(IMAGE_TOOL_SHORTCUTS.brush).toBe('B');
    expect(imageToolForShortcut('b')).toBe('brush');
    expect(imageToolForShortcut('b', true)).toBe('mixer');
    expect(imageToolForShortcut('m')).toBe('select');
    expect(imageToolForShortcut('i')).toBe('eyedropper');
    expect(imageToolForShortcut('q')).toBeNull();
  });

  it('gives each tool its canvas mode and options panel', () => {
    expect(imageToolCanvasMode('move')).toBe('transform');
    expect(imageToolCanvasMode('brush')).toBe('paint');
    expect(imageToolCanvasMode('select')).toBe('select');
    expect(imageToolCanvasMode('crop')).toBe('crop');
    expect(imageToolCanvasMode('shape')).toBe('annotate');
    expect(imageToolCanvasMode('eyedropper')).toBe('sample');
    expect(imageToolPanel('eyedropper')).toBeNull();
    expect(imageToolPanel('move')).toBeNull();
    expect(imageToolPanel('heal')).toBe('paint');
    expect(imageToolPanel('crop')).toBe('canvas-size');
    expect(imageToolPanel('type')).toBe('type');
    expect(imageToolPanel('arrow')).toBeNull();
    expect(imageToolPanel('path-pen')).toBe('paths');
    expect(imageToolPanel('direct-select')).toBe('paths');
  });

  it('picks the first tool for a panel', () => {
    expect(imagePanelTool('paint')).toBe('brush');
    expect(imagePanelTool('selection')).toBe('select');
    expect(imagePanelTool('channels')).toBe('select');
    expect(imagePanelTool('properties')).toBeNull();
  });

  describe('tool panels', () => {
    const pixel = { id: 'p', type: 'pixel', name: 'Paint' } as unknown as ImageLayer;
    const shape = { id: 's', type: 'shape', name: 'Shape' } as unknown as ImageLayer;
    const ids = (tool: ImageEditorTool, layer: ImageLayer | null) => imageToolPanels(tool, layer).map((p) => p.id);

    it('shows a tool’s own panels first and hides other tools’ options', () => {
      expect(imageToolPanelIds('select')).toEqual(['selection', 'channels']);
      expect(ids('move', pixel)).toEqual(['properties', 'color']);
      expect(ids('brush', pixel)).toEqual(['paint', 'properties', 'color']);
      expect(ids('select', pixel)).toEqual(['selection', 'channels', 'properties', 'color']);
      expect(ids('crop', pixel)).toEqual(['canvas-size', 'properties', 'color']);
      expect(ids('path-pen', null)).toEqual(['paths']);
      expect(ids('move', null)).toEqual([]);
    });

    it('keeps a shape or type layer’s own options with any tool', () => {
      expect(ids('move', shape)).toEqual(['properties', 'shape']);
      expect(ids('shape', shape)).toEqual(['shape', 'properties']);
      expect(ids('shape', null)).toEqual(['shape']);
      expect(imageToolPanels('shape', null)[0].title).toBe('Shape Options');
    });
  });
});
