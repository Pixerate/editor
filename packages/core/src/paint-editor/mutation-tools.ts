/**
 * Agent tools for mutation paint (`createMutationTools`, included in `createPaintEditorToolProvider`):
 * `list_mutations`, `read_mutation`, `answer_mutation`, and `decline_mutation`.
 */

import type { PresenceActorInfo } from '../animation/presence';
import { BRUSH_PATCH_PROPERTIES, type BrushPatch } from '../brushes/patch';
import { PAINT_SOURCE_JSON_SCHEMA } from '../paint/gradient-paint';
import { normalizePaintBrush } from './brushes';
import type { PaintEditorController } from './controller';
import type { PenPoint } from './engine';
import type { PaintAgentTool } from './hosted';
import type { PaintDirector } from './presence';
import { brushStickerRefs } from './stamp-tip';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const SET = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const POINTS = {
  type: 'array',
  minItems: 1,
  maxItems: 20000,
  description: 'The path in document pixels (raw samples; the brush smooths them). One point paints one dab.',
  items: {
    type: 'object',
    properties: {
      x: { type: 'number', description: 'Document x in pixels.' },
      y: { type: 'number', description: 'Document y in pixels.' },
      pressure: { type: 'number', minimum: 0, maximum: 1, description: 'Pen pressure 0..1 (default 1).' },
      t: { type: 'number', description: 'Time in milliseconds (optional; drives velocity dynamics).' },
      tiltX: { type: 'number', minimum: -90, maximum: 90, description: 'Pen tilt in degrees towards +x (Pointer Events tiltX).' },
      tiltY: { type: 'number', minimum: -90, maximum: 90, description: 'Pen tilt in degrees towards +y (Pointer Events tiltY).' },
      altitude: { type: 'number', minimum: 0, maximum: 1.5708, description: 'Pen altitude in radians: 1.5708 upright, 0 lying flat (overrides tiltX / tiltY).' },
      azimuth: { type: 'number', minimum: 0, maximum: 6.2832, description: 'Where the pen leans, radians clockwise from +x (with altitude).' },
      twist: { type: 'number', minimum: 0, maximum: 359, description: 'Barrel rotation in degrees (brushes with rotation barrel).' },
    },
    required: ['x', 'y'],
    additionalProperties: false,
  },
} as const;

export interface MutationToolsOptions {
  director?: PaintDirector;
  actor?: PresenceActorInfo;
}

export function createMutationTools(c: PaintEditorController, options: MutationToolsOptions = {}): PaintAgentTool[] {
  return [
    {
      name: 'list_mutations',
      title: 'List pending mutations',
      description:
        'Lists mutation exchanges waiting for an agent (or all of them when includeAll is true): each with id, state ("settling" | "pending" | "claimed" | "answered" | "declined"), layerId, medium ("wet" | "dry"), bounds in document pixels, strokeCount, age in seconds, settle, patience and fade. Use an id with read_mutation or decline_mutation.',
      inputSchema: {
        type: 'object',
        properties: {
          includeAll: {
            type: 'boolean',
            description: 'Include settling, claimed, answered and declined mutations as well as pending ones (default false).',
          },
        },
        additionalProperties: false,
      },
      annotations: { title: 'List pending mutations', ...READ },
      coordinates: { out: ['mutations[].bounds'] },
      handler: (a) => ({ mutations: c.listMutations({ includeAll: Boolean(a.includeAll) }) }),
    },
    {
      name: 'read_mutation',
      title: 'Read and claim a mutation',
      description:
        'Claims a mutation by id and starts its fade so the user’s stroke sinks away as you read it. Returns the mutation’s id, state ("claimed"), layerId, medium, bounds, fade duration in seconds, the strokes (id, color, brushId, brushName, size, points and bounds in document pixels), cropPng (base64 PNG and rect of the area around the strokes) and canvasPng (base64 PNG preview of the whole painting so you can choose where to answer). Refused if already claimed, answered or declined. Follow with answer_mutation or decline_mutation.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Mutation id from list_mutations (e.g. "m1").',
          },
          padding: {
            type: 'integer',
            minimum: 0,
            maximum: 512,
            description: 'Padding around the mutation bounds for cropPng, in document pixels (default 32).',
          },
          maxSide: {
            type: 'integer',
            minimum: 64,
            maximum: 2048,
            description: 'Longest side of the canvasPng preview in pixels (default 512).',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { title: 'Read and claim a mutation', ...WRITE },
      coordinates: { out: ['bounds', 'strokes[].bounds', 'strokes[].points[]', 'cropPng.rect'] },
      handler: (a) =>
        c.readMutation(a.id as string, {
          actor: options.actor?.id,
          padding: a.padding as number | undefined,
          maxSide: a.maxSide as number | undefined,
        }),
    },
    {
      name: 'answer_mutation',
      title: 'Answer a mutation with strokes',
      description:
        'Paints your answer to a claimed mutation (from read_mutation). Pass one or more strokes (each with points in document pixels, and optional brushId, brush facets, color, paint, layerId and seed). When a director is attached, your cursor glides across the canvas and paints live; all strokes commit as one undo step with origin agent:<id>. A second answer to the same mutation id is refused. Returns the mutation id, state ("answered"), layerId, new strokeIds, painted bounds and dab count.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Claimed mutation id from read_mutation (e.g. "m1").',
          },
          strokes: {
            type: 'array',
            minItems: 1,
            maxItems: 200,
            description: 'The strokes that form the answer, painted in order as one undo step.',
            items: {
              type: 'object',
              properties: {
                points: POINTS,
                layerId: {
                  type: 'string',
                  description: 'Layer id from list_layers for this stroke (default the answer layerId or the mutation layerId).',
                },
                brushId: {
                  type: 'string',
                  description: 'Brush id from list_brush_presets (default the active brush).',
                },
                brush: {
                  type: 'object',
                  description: 'Facets to change for this stroke only, laid over brushId or the active brush (as set_brush takes them).',
                  properties: BRUSH_PATCH_PROPERTIES,
                  additionalProperties: false,
                },
                color: {
                  type: 'string',
                  pattern: '^#[0-9a-fA-F]{6}$',
                  description: 'Paint colour #rrggbb (default the paint colour).',
                },
                paint: {
                  ...PAINT_SOURCE_JSON_SCHEMA,
                  description: 'Colour or gradient paint for this stroke.',
                },
                seed: {
                  type: 'integer',
                  minimum: 0,
                  description: 'Jitter seed for reproducible marks (default a new one).',
                },
                snapToPerspective: {
                  type: 'boolean',
                  description: 'Snap the points to the perspective guide (default false).',
                },
              },
              required: ['points'],
              additionalProperties: false,
            },
          },
          layerId: {
            type: 'string',
            description: 'Default pixel layer id from list_layers for the answer strokes (default the mutation’s layerId).',
          },
          note: {
            type: 'string',
            description: 'Short note shown next to the agent cursor while painting (optional).',
          },
        },
        required: ['id', 'strokes'],
        additionalProperties: false,
      },
      annotations: { title: 'Answer a mutation with strokes', ...WRITE },
      coordinates: { in: ['strokes[].points[]'], out: ['bounds'] },
      handler: async (a) => {
        await c.wetIdle();
        const rawStrokes = a.strokes as Array<{
          points: PenPoint[];
          layerId?: string;
          brushId?: string;
          brush?: BrushPatch;
          color?: string;
          paint?: unknown;
          seed?: number;
          snapToPerspective?: boolean;
        }>;
        const strokes = [];
        for (const s of rawStrokes) {
          const base = s.brushId ? c.getBrush(s.brushId) : c.getState().brush;
          const brush = s.brush ? c.brushChanges(s.brush, s.brushId) : undefined;
          if (base) {
            const refs = brushStickerRefs(normalizePaintBrush({ ...(brush ?? {}), id: base.id }, base));
            if (refs.length) await c.prepareStickers(refs);
          }
          strokes.push({
            points: s.points,
            ...(s.layerId !== undefined ? { layerId: s.layerId } : {}),
            ...(s.brushId !== undefined ? { brushId: s.brushId } : {}),
            ...(brush !== undefined ? { brush } : {}),
            ...(s.color !== undefined ? { color: s.color } : {}),
            ...(s.paint !== undefined ? { paint: s.paint as string } : {}),
            ...(s.seed !== undefined ? { seed: s.seed } : {}),
            ...(s.snapToPerspective !== undefined ? { snapToPerspective: s.snapToPerspective } : {}),
          });
        }
        return c.answerMutation(
          a.id as string,
          {
            strokes,
            ...(a.layerId !== undefined ? { layerId: a.layerId as string } : {}),
            ...(a.note !== undefined ? { note: a.note as string } : {}),
          },
          { director: options.director, actor: options.actor }
        );
      },
    },
    {
      name: 'decline_mutation',
      title: 'Decline a mutation',
      description:
        'Declines a mutation without answering so the user’s paint stays as ordinary paint (wet strokes stay in the wet layer and dry temporary layers merge down into their target layer). Returns the updated mutation info.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Mutation id from list_mutations (e.g. "m1").',
          },
          reason: {
            type: 'string',
            description: 'Why the mutation was declined (optional).',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { title: 'Decline a mutation', ...SET },
      coordinates: { out: ['bounds'] },
      handler: (a) => c.declineMutation(a.id as string, a.reason as string | undefined),
    },
  ];
}
