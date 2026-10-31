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
  type ImageEditorTool,
} from '../src/image-editor';

const ALL_TOOLS: ImageEditorTool[] = [
  'select', 'crop', 'pen', 'rect', 'circle', 'arrow', 'line', 'text', 'watermark', 'move', 'brush',
  'eraser', 'mixer', 'clone', 'heal', 'spot-heal', 'smudge', 'dodge', 'burn', 'sponge', 'blur',
  'sharpen', 'history', 'shape', 'type', 'path-select', 'direct-select', 'path-pen',
];

describe('image tool groups', () => {
  it('offers every drawable tool once', () => {
    const grouped = IMAGE_TOOL_GROUPS.flatMap((g) => g.tools);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(ALL_TOOLS.filter((t) => t !== 'text' && t !== 'watermark').sort());
  });

  it('finds a tool’s group, falling back to the first', () => {
    expect(imageToolGroup('burn').id).toBe('tone');
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
    expect(imageToolForShortcut('q')).toBeNull();
  });

  it('gives each tool its canvas mode and options panel', () => {
    expect(imageToolCanvasMode('move')).toBe('transform');
    expect(imageToolCanvasMode('brush')).toBe('paint');
    expect(imageToolCanvasMode('select')).toBe('select');
    expect(imageToolCanvasMode('crop')).toBe('crop');
    expect(imageToolCanvasMode('shape')).toBe('annotate');
    expect(imageToolPanel('move')).toBeNull();
    expect(imageToolPanel('heal')).toBe('paint');
    expect(imageToolPanel('crop')).toBe('canvas-size');
    expect(imageToolPanel('type')).toBe('type');
    expect(imageToolPanel('arrow')).toBeNull();
  });

  it('picks the first tool for a panel', () => {
    expect(imagePanelTool('paint')).toBe('brush');
    expect(imagePanelTool('selection')).toBe('select');
    expect(imagePanelTool('properties')).toBeNull();
  });
});
