/**
 * The image editor's tools as a toolbar shows them: grouped by what each tool is for (a slot per
 * group, the rest of the group in a flyout or the host's tool options), with labels and shortcuts,
 * the canvas mode each tool draws in and the layer panel (`layerPanels`) holding its options. Hosts
 * build their toolbar from these instead of listing tools themselves, so new tools show up without
 * host changes.
 */

import type { ImageEditorTool } from './types';
import { PAINT_TOOLS, isPaintTool } from './layers/paint-ui';
import { SELECTION_TOOLS, type SelectionToolKind } from './selection/tool-options';
import { SHAPE_KIND_LABELS } from './layers/shape-type-ui';
import { LIVE_SHAPE_KINDS, type ImageLayer, type LiveShapeKind } from './layers/model';
import { layerPanels, type LayerPanelDescriptor, type LayerPanelsOptions } from './layers/panel';

/** Tools of a group shown together under a heading (Retouch's Fix, Tone and Detail). */
export interface ImageToolSection {
  label: string;
  tools: readonly ImageEditorTool[];
}

export interface ImageToolGroup {
  id: string;
  label: string;
  tools: readonly ImageEditorTool[];
  /** The group's tools split by purpose, in `tools` order; absent when the group is one set. */
  sections?: readonly ImageToolSection[];
}

/**
 * Every tool a toolbar offers, in toolbar order, grouped by intent: choose (Move, Select, Crop),
 * put paint down (Draw), take it away (Erase), retouch (Fix, Tone, Detail), build shapes, paths and
 * type, and pick colours (Eyedropper). The `text` and `watermark` annotations are left out: they
 * are added through the API (`addAnnotation`), not drawn. So are the `line`, `arrow`, `rect` and
 * `circle` annotations, which the Shape tool's live shapes cover (they still draw for API callers).
 */
export const IMAGE_TOOL_GROUPS: readonly ImageToolGroup[] = [
  { id: 'move', label: 'Move', tools: ['move'] },
  { id: 'select', label: 'Select', tools: ['select'] },
  { id: 'crop', label: 'Crop', tools: ['crop'] },
  { id: 'draw', label: 'Draw', tools: ['brush', 'pen', 'mixer'] },
  { id: 'erase', label: 'Erase', tools: ['eraser', 'history'] },
  {
    id: 'retouch',
    label: 'Retouch',
    tools: ['spot-heal', 'heal', 'clone', 'dodge', 'burn', 'sponge', 'blur', 'sharpen', 'smudge'],
    sections: [
      { label: 'Fix', tools: ['spot-heal', 'heal', 'clone'] },
      { label: 'Tone', tools: ['dodge', 'burn', 'sponge'] },
      { label: 'Detail', tools: ['blur', 'sharpen', 'smudge'] },
    ],
  },
  { id: 'shape', label: 'Shape', tools: ['shape'] },
  { id: 'paths', label: 'Paths', tools: ['path-pen', 'path-select', 'direct-select'] },
  { id: 'type', label: 'Type', tools: ['type'] },
  { id: 'eyedropper', label: 'Eyedropper', tools: ['eyedropper'] },
];

/**
 * One way of using a tool that a toolbar offers as a tool of its own: a selection tool (`select`
 * with `SelectionToolOptions.tool`) or a shape kind (`shape` with `ShapeToolOptions.kind`).
 */
export type ImageToolVariant =
  | { tool: 'select'; id: SelectionToolKind; label: string }
  | { tool: 'shape'; id: LiveShapeKind; label: string };

/** The variants a tool offers (the selection tools, the shape kinds), or none. */
export function imageToolVariants(tool: ImageEditorTool): readonly ImageToolVariant[] {
  if (tool === 'select') return SELECTION_TOOLS.map((t) => ({ tool: 'select' as const, id: t.id, label: t.label }));
  if (tool === 'shape') return LIVE_SHAPE_KINDS.map((kind) => ({ tool: 'shape' as const, id: kind, label: SHAPE_KIND_LABELS[kind] }));
  return [];
}

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
  pen: 'Pencil',
  line: 'Line',
  arrow: 'Arrow',
  rect: 'Rectangle',
  circle: 'Ellipse',
  text: 'Text',
  watermark: 'Watermark',
  eyedropper: 'Eyedropper',
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
  eyedropper: 'I',
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
export type ImageToolCanvasMode = 'transform' | 'crop' | 'select' | 'paint' | 'annotate' | 'sample';

/**
 * The canvas mode a tool works in. Move picks and transforms layers; shapes, type, the path tools
 * and the annotations draw in `annotate`; the Eyedropper picks colours in `sample`.
 */
export function imageToolCanvasMode(tool: ImageEditorTool): ImageToolCanvasMode {
  if (tool === 'move') return 'transform';
  if (isPaintTool(tool)) return 'paint';
  if (tool === 'select') return 'select';
  if (tool === 'crop') return 'crop';
  if (tool === 'eyedropper') return 'sample';
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

/**
 * The panels that work with a tool: the one holding its options (`imageToolPanel`) and, for the
 * selection tools, Channels (where a selection is saved and loaded).
 */
export function imageToolPanelIds(tool: ImageEditorTool): string[] {
  const own = imageToolPanel(tool);
  if (!own) return [];
  return own === 'selection' ? [own, 'channels'] : [own];
}

/** The first tool whose panels include `panel` (in toolbar order), or null. */
export function imagePanelTool(panel: string): ImageEditorTool | null {
  for (const group of IMAGE_TOOL_GROUPS) {
    for (const tool of group.tools) if (imageToolPanelIds(tool).includes(panel)) return tool;
  }
  return null;
}

/** Panels that only hold a tool's options, so they show while one of their tools is active. */
const TOOL_ONLY_PANELS: ReadonlySet<string> = new Set(['paint', 'selection', 'canvas-size', 'channels', 'paths']);

const TOOL_PANEL_TITLES: Record<string, string> = {
  paint: 'Brush Options',
  selection: 'Selection',
  'canvas-size': 'Composition Size',
  channels: 'Channels',
  paths: 'Paths',
  shape: 'Shape Options',
  type: 'Typography',
};

/**
 * The panels a sidebar shows for the active tool and layer: the tool's own panels first
 * (`imageToolPanelIds`: Brush Options only with a paint tool, Selection and Channels with Select,
 * Composition Size with Crop, Paths with the path tools, Shape Options or Typography with Shape or
 * Type), then the active layer's (`layerPanels`: its properties, effects, colour adjustments, mask,
 * and its shape or type options when it is a shape or type layer). Move shows the layer's panels only.
 */
export function imageToolPanels(
  tool: ImageEditorTool,
  layer: ImageLayer | null,
  options: LayerPanelsOptions = {},
): LayerPanelDescriptor[] {
  const own = imageToolPanelIds(tool);
  const listed = layerPanels(layer, options);
  const first = own.map((id) => listed.find((p) => p.id === id) ?? { id, title: TOOL_PANEL_TITLES[id] ?? id });
  const rest = listed.filter((p) => !own.includes(p.id) && !TOOL_ONLY_PANELS.has(p.id));
  return [...first, ...rest];
}

/**
 * Tools that put down a colour the host chooses: the brush and mixer (the paint foreground), the
 * pencil and annotations, shapes and type (their fill or colour), and the Eyedropper that picks it.
 * Hosts show their colour picker or palette for these.
 */
export function imageToolUsesColor(tool: ImageEditorTool): boolean {
  return (
    tool === 'brush' || tool === 'mixer' || tool === 'pen' || tool === 'line' || tool === 'arrow' || tool === 'rect' ||
    tool === 'circle' || tool === 'shape' || tool === 'type' || tool === 'eyedropper'
  );
}
