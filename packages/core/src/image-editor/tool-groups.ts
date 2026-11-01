/**
 * The image editor's tools as a toolbar shows them: grouped like Photoshop's (a slot per group, the
 * rest of the group in a flyout), with labels and shortcuts, the canvas mode each tool draws in and
 * the layer panel (`layerPanels`) holding its options. Hosts build their toolbar from these instead
 * of listing tools themselves, so new tools show up without host changes.
 */

import type { ImageEditorTool } from './types';
import { PAINT_TOOLS, isPaintTool } from './layers/paint-ui';

export interface ImageToolGroup {
  id: string;
  label: string;
  tools: readonly ImageEditorTool[];
}

/**
 * Every tool a toolbar offers, in toolbar order. The `text` and `watermark` annotations are left
 * out: they are added through the API (`addAnnotation`), not drawn.
 */
export const IMAGE_TOOL_GROUPS: readonly ImageToolGroup[] = [
  { id: 'move', label: 'Move', tools: ['move'] },
  { id: 'select', label: 'Select', tools: ['select'] },
  { id: 'crop', label: 'Crop', tools: ['crop'] },
  { id: 'brush', label: 'Brush', tools: ['brush', 'mixer'] },
  { id: 'eraser', label: 'Eraser', tools: ['eraser'] },
  { id: 'repair', label: 'Repair', tools: ['spot-heal', 'heal', 'clone'] },
  { id: 'history', label: 'History Brush', tools: ['history'] },
  { id: 'focus', label: 'Blur & Sharpen', tools: ['blur', 'sharpen', 'smudge'] },
  { id: 'tone', label: 'Dodge & Burn', tools: ['dodge', 'burn', 'sponge'] },
  { id: 'shape', label: 'Shape', tools: ['shape'] },
  { id: 'pen', label: 'Pen', tools: ['path-pen'] },
  { id: 'type', label: 'Type', tools: ['type'] },
  { id: 'path-select', label: 'Path Selection', tools: ['path-select', 'direct-select'] },
  { id: 'annotate', label: 'Annotate', tools: ['pen', 'line', 'arrow', 'rect', 'circle'] },
];

/** The group a tool is in (the first group for a tool no group holds). */
export function imageToolGroup(tool: ImageEditorTool): ImageToolGroup {
  return IMAGE_TOOL_GROUPS.find((group) => group.tools.includes(tool)) ?? IMAGE_TOOL_GROUPS[0];
}

const OTHER_TOOL_LABELS: Partial<Record<ImageEditorTool, string>> = {
  select: 'Select',
  crop: 'Crop',
  shape: 'Shape',
  type: 'Type',
  'path-pen': 'Pen',
  'path-select': 'Path Selection',
  'direct-select': 'Direct Selection',
  pen: 'Freehand',
  line: 'Line',
  arrow: 'Arrow',
  rect: 'Rectangle',
  circle: 'Ellipse',
  text: 'Text',
  watermark: 'Watermark',
};

export function imageToolLabel(tool: ImageEditorTool): string {
  return PAINT_TOOLS.find((t) => t.id === tool)?.label ?? OTHER_TOOL_LABELS[tool] ?? tool;
}

/** Photoshop's shortcuts, as the paint tools' keys handle them (`Shift+B` and so on). */
export const IMAGE_TOOL_SHORTCUTS: Partial<Record<ImageEditorTool, string>> = {
  ...Object.fromEntries(PAINT_TOOLS.filter((t) => t.shortcut).map((t) => [t.id, t.shortcut])),
  select: 'M',
  crop: 'C',
  shape: 'U',
  type: 'T',
  'path-pen': 'P',
  'path-select': 'A',
  'direct-select': 'Shift+A',
};

/** The tool a shortcut picks (the first tool listed for a shared key), or null. */
export function imageToolForShortcut(key: string, shift = false): ImageEditorTool | null {
  const shortcut = `${shift ? 'Shift+' : ''}${key.toUpperCase()}`;
  for (const group of IMAGE_TOOL_GROUPS) {
    for (const tool of group.tools) if (IMAGE_TOOL_SHORTCUTS[tool] === shortcut) return tool;
  }
  return null;
}

/** How a canvas handles pointer gestures for a tool (the Svelte and React canvases' `mode`). */
export type ImageToolCanvasMode = 'transform' | 'crop' | 'select' | 'paint' | 'annotate';

/**
 * The canvas mode a tool works in. Move picks and transforms layers; shapes, type, the path tools
 * and the annotations draw in `annotate`.
 */
export function imageToolCanvasMode(tool: ImageEditorTool): ImageToolCanvasMode {
  if (tool === 'move') return 'transform';
  if (isPaintTool(tool)) return 'paint';
  if (tool === 'select') return 'select';
  if (tool === 'crop') return 'crop';
  return 'annotate';
}

/** The `layerPanels` panel holding a tool's options, or null when it has none. */
export function imageToolPanel(tool: ImageEditorTool): string | null {
  if (tool === 'move') return null;
  if (isPaintTool(tool)) return 'paint';
  if (tool === 'select') return 'selection';
  if (tool === 'path-pen' || tool === 'path-select' || tool === 'direct-select') return 'paths';
  if (tool === 'crop') return 'canvas-size';
  if (tool === 'shape' || tool === 'type') return tool;
  return null;
}

/** The first tool whose options are in a panel (in toolbar order), or null. */
export function imagePanelTool(panel: string): ImageEditorTool | null {
  for (const group of IMAGE_TOOL_GROUPS) {
    for (const tool of group.tools) if (imageToolPanel(tool) === panel) return tool;
  }
  return null;
}
