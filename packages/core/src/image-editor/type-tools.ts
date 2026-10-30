import type { AgentTool } from '../tools/registry.js';
import type { ImageEditorController, TextLayerInit, TypeMaskInit } from './controller';
import { BLEND_MODES, type BlendMode } from './blend';
import { findLayer } from './layers/model';
import { LayerOperationError } from './layers/ops';
import { requireTypeLayer } from './layers/text';
import { describeLayer } from './layer-tools';
import { selectionArea } from './selection/mask';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const LAYER_ID = { type: 'string', description: 'Type layer id from list_layers (type type) or add_text_layer.' } as const;
const START = { type: 'integer', minimum: 0, description: 'Start of the range in UTF-16 code units, as get_text_layer counts them (default 0).' } as const;
const END = { type: 'integer', minimum: 0, description: 'End of the range, exclusive (default the end of the text).' } as const;

const STYLE = {
  fontFamily: { type: 'string', description: 'Font family name (list_fonts shows what is available; a missing family falls back, with a warning).' },
  fontWeight: { type: 'integer', minimum: 1, maximum: 1000, description: 'Weight 100..900 (400 regular, 700 bold).' },
  italic: { type: 'boolean', description: 'Italic.' },
  fontSize: { type: 'number', minimum: 0.5, maximum: 5000, description: 'Size in document pixels.' },
  color: { type: 'string', description: 'Colour (#rrggbb, or a CSS colour; its alpha becomes opacity).' },
  opacity: { type: ['number', 'null'], minimum: 0, maximum: 1, description: 'Text opacity 0..1 (null resets to 1).' },
  tracking: { type: ['number', 'null'], minimum: -1000, maximum: 10000, description: 'Letter spacing in 1/1000 em (null resets to 0).' },
  leading: { type: ['number', 'null'], minimum: 0, maximum: 10000, description: 'Baseline-to-baseline distance in pixels (null = auto, the paragraph autoLeading × size).' },
  baselineShift: { type: ['number', 'null'], minimum: -5000, maximum: 5000, description: 'Pixels; positive raises the text (null resets to 0).' },
  underline: { type: 'boolean', description: 'Underline.' },
  strikethrough: { type: 'boolean', description: 'Strike through.' },
  upright: { type: 'boolean', description: 'Vertical text only: set Latin and other horizontal-script characters upright, one under the other, instead of turned sideways (default false).' },
} as const;

const ORIENTATION = {
  type: 'string',
  enum: ['horizontal', 'vertical'],
  description: 'horizontal (default): lines left to right, stacked down. vertical: columns top to bottom, stacked right to left; CJK stands upright, Latin turns sideways unless styled upright.',
} as const;

const PARAGRAPH = {
  align: { type: 'string', enum: ['left', 'center', 'right', 'justify'], description: 'Alignment (justify stretches paragraph-box lines but the last).' },
  autoLeading: { type: ['number', 'null'], minimum: 0.1, maximum: 10, description: 'Auto leading as a multiple of the font size (default 1.2).' },
  firstLineIndent: { type: ['number', 'null'], description: 'First-line indent in pixels.' },
  startIndent: { type: ['number', 'null'], description: 'Left indent in pixels.' },
  endIndent: { type: ['number', 'null'], description: 'Right indent in pixels.' },
  spaceBefore: { type: ['number', 'null'], description: 'Space above the paragraph in pixels (not before the first).' },
  spaceAfter: { type: ['number', 'null'], description: 'Space below the paragraph in pixels.' },
} as const;

function pick(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (args[k] !== undefined) out[k] = args[k];
  return out;
}

/**
 * Agent tools for type layers in the image editor: `list_fonts`, `get_text_layer`,
 * `add_text_layer`, `set_text`, `set_text_style`, `set_paragraph_style`, `set_text_frame`,
 * `set_text_orientation` and `convert_text_to_shape`. Every write is one undo step, validates first and returns the layer as
 * it is afterwards (with any missing fonts).
 */
export function createImageTypeTools(controller: ImageEditorController): AgentTool[] {
  const typeId = (id: unknown) => {
    if (typeof id !== 'string' || !id) throw new LayerOperationError('layerId is required (a type layer id from list_layers).');
    requireTypeLayer(controller.getLayers(), id);
    return id;
  };
  const layerSummary = (id: string) => {
    const s = controller.getState();
    const loc = findLayer(s.layers, id);
    return loc ? { ...describeLayer(loc.layer, s.activeLayerId, (x) => controller.getLayerBounds(x.id)), parentId: loc.parent?.id ?? null, index: loc.index } : null;
  };
  const range = (args: Record<string, unknown>) => ({ start: args.start as number | undefined, end: args.end as number | undefined });

  const listFonts: AgentTool = {
    name: 'list_fonts',
    title: 'List fonts',
    description: 'Returns the font families type layers can use here (generic families such as sans-serif always work). Changes nothing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List fonts', ...READ },
    handler: () => ({ families: controller.listFonts(), shaper: controller.getTextShaper()?.id ?? null }),
  };

  const get: AgentTool = {
    name: 'get_text_layer',
    title: 'Read a type layer',
    description:
      'Returns a type layer’s text, its character runs and paragraphs as [start, end) ranges in UTF-16 code units with their styles, the frame (point text, or a paragraph box with its size), the orientation (horizontal or vertical), the text-to-document transform, the laid-out lines (range, baseline, width), the rendered bounds, missing fonts and whether the pixels are live or stored from a file. Call before editing text you did not write, to get the ranges. Changes nothing.',
    inputSchema: { type: 'object', properties: { layerId: LAYER_ID }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Read a type layer', ...READ },
    handler: ({ layerId }) => controller.getTextLayer(typeId(layerId)),
  };

  const add: AgentTool = {
    name: 'add_text_layer',
    title: 'Add a type layer',
    description:
      'Adds a live type layer and makes it active: point text whose origin (x, y) is the first line’s baseline at its alignment edge, or paragraph text wrapped in box {width, height} with its top-left at (x, y). orientation vertical sets columns running down from (x, y) (the top of the first column’s centre line; a box fills from its right edge), stacked right to left. Line breaks in text start paragraphs. Style and paragraph settings apply to the whole text (change ranges later with set_text_style). Default style: 24 px sans-serif in the foreground colour. One undo step. Returns the layer and the text layer, including missingFonts.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text; \\n starts a new paragraph.' },
        x: { type: 'number', description: 'Document x of the origin, pixels.' },
        y: { type: 'number', description: 'Document y of the origin (point text: the first baseline), pixels.' },
        box: {
          type: 'object',
          description: 'Make it paragraph (area) text wrapped in this box, pixels.',
          properties: { width: { type: 'number', minimum: 1, description: 'Box width, pixels.' }, height: { type: 'number', minimum: 1, description: 'Box height, pixels.' } },
          required: ['width', 'height'],
          additionalProperties: false,
        },
        style: { type: 'object', description: 'Character style.', properties: STYLE, additionalProperties: false },
        paragraph: { type: 'object', description: 'Paragraph style.', properties: PARAGRAPH, additionalProperties: false },
        orientation: ORIENTATION,
        rotation: { type: 'number', description: 'Degrees clockwise about the origin (default 0).' },
        name: { type: 'string', description: 'Layer name (default the start of the text).' },
        opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Layer opacity 0..1 (default 1).' },
        blend: { type: 'string', enum: BLEND_MODES.map((m) => m.id), description: 'Blend mode (default normal).' },
        aboveId: { type: 'string', description: 'Put the layer directly above this layer (default above the active layer).' },
        belowId: { type: 'string', description: 'Put the layer directly below this layer.' },
        parentId: { type: 'string', description: 'Put the layer inside this group.' },
        index: { type: 'integer', minimum: 0, description: 'Position among the siblings, 0 = bottom.' },
      },
      required: ['text', 'x', 'y'],
      additionalProperties: false,
    },
    annotations: { title: 'Add a type layer', ...WRITE },
    handler: (args) => {
      const init = pick(args, ['text', 'x', 'y', 'box', 'style', 'paragraph', 'orientation', 'rotation', 'name', 'opacity', 'blend', 'aboveId', 'belowId', 'parentId', 'index']) as unknown as TextLayerInit;
      if (init.blend !== undefined) init.blend = init.blend as BlendMode;
      const id = controller.addTextLayer(init);
      return { layer: layerSummary(id), text: controller.getTextLayer(id) };
    },
  };

  const setText: AgentTool = {
    name: 'set_text',
    title: 'Edit text',
    description:
      'Replaces the text in [start, end) (default all of it) with text; inserted text takes the style of the character at start. Use start = end to insert. Returns the text layer with its new runs.',
    inputSchema: { type: 'object', properties: { layerId: LAYER_ID, text: { type: 'string', description: 'Replacement text (\\n starts a paragraph; empty deletes the range).' }, start: START, end: END }, required: ['layerId', 'text'], additionalProperties: false },
    annotations: { title: 'Edit text', ...WRITE },
    handler: (args) => controller.setText(typeId(args.layerId), args.text as string, range(args)),
  };

  const setStyle: AgentTool = {
    name: 'set_text_style',
    title: 'Style a range of text',
    description:
      'Sets character style fields (font, weight, italic, size, colour, tracking, leading, baseline shift, underline, strike-through) over [start, end) of a type layer (default all of it); fields not given keep their values per run. Returns the text layer with its runs and missingFonts.',
    inputSchema: { type: 'object', properties: { layerId: LAYER_ID, start: START, end: END, ...STYLE }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Style a range of text', ...WRITE_IDEMPOTENT },
    handler: (args) => {
      const style = pick(args, Object.keys(STYLE));
      if (!Object.keys(style).length) throw new LayerOperationError(`Give at least one style field: ${Object.keys(STYLE).join(', ')}.`);
      return controller.setTextStyle(typeId(args.layerId), style, range(args));
    },
  };

  const setParagraph: AgentTool = {
    name: 'set_paragraph_style',
    title: 'Style paragraphs',
    description: 'Sets paragraph fields (alignment, auto leading, indents, spacing) on every paragraph that [start, end) touches (default all). Returns the text layer.',
    inputSchema: { type: 'object', properties: { layerId: LAYER_ID, start: START, end: END, ...PARAGRAPH }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Style paragraphs', ...WRITE_IDEMPOTENT },
    handler: (args) => {
      const style = pick(args, Object.keys(PARAGRAPH));
      if (!Object.keys(style).length) throw new LayerOperationError(`Give at least one paragraph field: ${Object.keys(PARAGRAPH).join(', ')}.`);
      return controller.setParagraphStyle(typeId(args.layerId), style, range(args));
    },
  };

  const setFrame: AgentTool = {
    name: 'set_text_frame',
    title: 'Point or paragraph text',
    description:
      'Converts between point text (kind point: one line per paragraph) and paragraph text (kind box: wrapped in width × height pixels, its top-left where the first line starts), or resizes a paragraph box. The first line stays in place. Returns the text layer with its new lines.',
    inputSchema: {
      type: 'object',
      properties: {
        layerId: LAYER_ID,
        kind: { type: 'string', enum: ['point', 'box'], description: 'point or box.' },
        width: { type: 'number', minimum: 1, description: 'Box width in pixels (kind box).' },
        height: { type: 'number', minimum: 1, description: 'Box height in pixels (kind box).' },
      },
      required: ['layerId', 'kind'],
      additionalProperties: false,
    },
    annotations: { title: 'Point or paragraph text', ...WRITE_IDEMPOTENT },
    handler: ({ layerId, kind, width, height }) => {
      const id = typeId(layerId);
      if (kind === 'box' && (width === undefined || height === undefined)) throw new LayerOperationError('kind box needs width and height in pixels.');
      return controller.setTextFrame(id, kind === 'box' ? { kind: 'box', width: width as number, height: height as number } : { kind: 'point' });
    },
  };

  const setOrientation: AgentTool = {
    name: 'set_text_orientation',
    title: 'Horizontal or vertical type',
    description:
      'Type › Orientation: sets a type layer horizontal (lines left to right) or vertical (columns top to bottom, right to left). The text, styles, frame and origin stay. One undo step. Returns the text layer with its orientation and new lines (columns).',
    inputSchema: { type: 'object', properties: { layerId: LAYER_ID, orientation: { ...ORIENTATION, description: 'horizontal or vertical.' } }, required: ['layerId', 'orientation'], additionalProperties: false },
    annotations: { title: 'Horizontal or vertical type', ...WRITE_IDEMPOTENT },
    handler: ({ layerId, orientation }) => controller.setTextOrientation(typeId(layerId), orientation as 'horizontal' | 'vertical'),
  };

  const toShape: AgentTool = {
    name: 'convert_text_to_shape',
    title: 'Convert text to a shape',
    description:
      'Type › Convert to Shape: the text’s glyph outlines become a shape layer (same id, name, mask, effects, opacity, blend) that can be edited with the shape tools; the text is no longer editable. Needs a font shaper that gives outlines (the browser’s canvas cannot). The fill is the first run’s colour. One undo step. Returns the layer and warnings.',
    inputSchema: { type: 'object', properties: { layerId: LAYER_ID }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Convert text to a shape', ...DESTRUCTIVE },
    handler: ({ layerId }) => {
      const { layerId: id, warnings } = controller.convertTextToShape(typeId(layerId));
      return { layer: layerSummary(id), shape: controller.getShapeLayer(id), warnings };
    },
  };

  const typeMask: AgentTool = {
    name: 'select_text_shape',
    title: 'Select the shape of text',
    description:
      'Horizontal / Vertical Type Mask: selects the shape of text laid out as add_text_layer would place it (font family, size, weight, tracking, box, rotation; colour is ignored), combined with the current selection by mode. No layer is added. Vertical lays the text out as vertical type: columns down from (x, y), stacked right to left, CJK upright and Latin turned sideways. Use it to cut text out of an image (layer_via_copy), fill letters with a photo (add_layer_mask), or mask an adjustment. Check fonts with list_fonts first. One undo step. Returns the selection.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, description: 'The text; \\n starts a new line (vertical: a new column).' },
        x: { type: 'number', description: 'Document x of the origin, pixels (vertical: the first column\u2019s centre).' },
        y: { type: 'number', description: 'Document y of the origin, pixels (horizontal: the first baseline; vertical: the top of the first column).' },
        orientation: { ...ORIENTATION, description: 'horizontal (default) or vertical: columns top to bottom, right to left, as vertical type layers (CJK upright, Latin turned sideways unless styled upright).' },
        box: {
          type: 'object',
          description: 'Wrap in this box, pixels (vertical: columns fill it from its right edge).',
          properties: { width: { type: 'number', minimum: 1, description: 'Box width, pixels.' }, height: { type: 'number', minimum: 1, description: 'Box height, pixels.' } },
          required: ['width', 'height'],
          additionalProperties: false,
        },
        style: { type: 'object', description: 'Character style (size in px, family, weight, tracking…; colour is ignored).', properties: STYLE, additionalProperties: false },
        paragraph: { type: 'object', description: 'Paragraph style (alignment, leading…).', properties: PARAGRAPH, additionalProperties: false },
        rotation: { type: 'number', description: 'Degrees clockwise about the origin (default 0).' },
        mode: { type: 'string', enum: ['replace', 'add', 'subtract', 'intersect'], description: 'How it combines with the current selection (default replace).' },
        feather: { type: 'number', minimum: 0, maximum: 1000, description: 'Feather radius in px (default 0).' },
        antiAlias: { type: 'boolean', description: 'Soft glyph edges (default true).' },
      },
      required: ['text', 'x', 'y'],
      additionalProperties: false,
    },
    annotations: { title: 'Select the shape of text', ...WRITE },
    handler: (args) => {
      const init = pick(args, ['text', 'x', 'y', 'orientation', 'box', 'style', 'paragraph', 'rotation', 'mode', 'feather', 'antiAlias']) as unknown as TypeMaskInit;
      controller.selectTextShape(init);
      const sel = controller.getSelection();
      return { empty: !sel, bounds: sel?.bounds ?? null, area: Math.round(sel ? selectionArea(sel) : 0) };
    },
  };

  return [listFonts, get, add, setText, setStyle, setParagraph, setFrame, setOrientation, toShape, typeMask];
}
