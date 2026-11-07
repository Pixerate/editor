/**
 * Agent tools for evolutionary strokes (`breed_strokes`, `breed_proposal`, `get_proposal_genome`).
 * Accepting or dismissing bred variants reuses `accept_paint_proposal` and `reject_paint_proposal`.
 */

import type { AgentToolProvider } from '../tools/registry.js';
import type { PaintEditorController } from './controller';
import type { PaintAgentTool } from './hosted';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const UNIT = (description: string) => ({ type: 'number', minimum: 0, maximum: 1, description }) as const;

export const EVOLUTION_MUTATION_SCHEMA = {
  type: 'object',
  description: 'How strongly each part of a stroke genome mutates (each 0..1; 0 keeps that part unchanged).',
  properties: {
    geometry: UNIT('Whole-stroke transform (move, scale, rotate, pressure scale) and smoothed point jitter along the path, 0..1 (default 0.35).'),
    color: UNIT('Perceptual colour drift in OKLCH lightness, chroma and hue, kept in sRGB gamut, 0..1 (default 0.35).'),
    brush: UNIT('Drift of each brush facet within its schema range, 0..1 (default 0.35).'),
    seed: UNIT('Reroll the stroke seed for dab jitter, scatter, bristles and particles, 0..1 (default 0.5; 0 keeps the seed).'),
  },
  additionalProperties: false,
} as const;

export function createPaintEvolutionTools(c: PaintEditorController): PaintAgentTool[] {
  return [
    {
      name: 'breed_strokes',
      title: 'Breed stroke variants',
      description:
        'Breeds mutated variants from 1..16 recorded strokes as pending paint proposals, generated one after another through previewPaint so each has its ghost over the canvas. Refuses unknown stroke ids and brushes that cannot be redrawn on their own (wet, impasto, sticker, eraser, blender, smudge, light or pickup brushes). Use get_proposal_genome to inspect a variant’s full stroke records, breed_proposal to evolve or cross variants further, and accept_paint_proposal (one undo step) or reject_paint_proposal to accept or dismiss one. Returns proposalIds and proposals (each with proposalId, title, seed, bounds in document pixels, diff and changes).',
      inputSchema: {
        type: 'object',
        properties: {
          strokeIds: {
            type: 'array',
            minItems: 1,
            maxItems: 16,
            items: { type: 'string', description: 'Stroke id from list_strokes.' },
            description: '1..16 stroke ids from list_strokes to breed variants from.',
          },
          count: {
            type: 'integer',
            minimum: 2,
            maximum: 12,
            description: 'How many mutated variants to propose, 2..12 (default 4).',
          },
          mutation: EVOLUTION_MUTATION_SCHEMA,
          seed: {
            type: 'integer',
            minimum: 0,
            description: 'Deterministic seed for the variants (default 1); the same seed gives the same genomes.',
          },
        },
        required: ['strokeIds'],
        additionalProperties: false,
      },
      annotations: { title: 'Breed stroke variants', ...WRITE },
      coordinates: { out: ['proposals[].bounds'] },
      handler: ({ strokeIds, count, mutation, seed }, context) => {
        const actor = (context as { actor?: { id?: string } } | undefined)?.actor?.id;
        return c.breedStrokes({
          strokeIds,
          count,
          mutation,
          seed,
          ...(actor ? { origin: `agent:${actor}` } : {}),
        });
      },
    },
    {
      name: 'breed_proposal',
      title: 'Breed from paint proposals',
      description:
        'Breeds new stroke variants from pending paint proposals: pass one proposalId to mutate its stroke genome further, or two proposalIds to cross their genomes over (resampling points, mixing colours in OKLab/OKLCH and blending brush facets) and mutate the offspring. Generated one after another through previewPaint. Returns proposalIds and proposals (each with proposalId, title, seed, bounds in document pixels, diff and changes).',
      inputSchema: {
        type: 'object',
        properties: {
          proposalIds: {
            type: 'array',
            minItems: 1,
            maxItems: 2,
            items: { type: 'string', description: 'Pending proposal id from breed_strokes, breed_proposal or list_paint_proposals.' },
            description: '1 proposal id to mutate it further, or 2 proposal ids to cross them over and mutate.',
          },
          count: {
            type: 'integer',
            minimum: 2,
            maximum: 12,
            description: 'How many mutated variants to propose, 2..12 (default 4).',
          },
          mutation: EVOLUTION_MUTATION_SCHEMA,
          seed: {
            type: 'integer',
            minimum: 0,
            description: 'Deterministic seed for the variants (default 1); the same seed gives the same genomes.',
          },
        },
        required: ['proposalIds'],
        additionalProperties: false,
      },
      annotations: { title: 'Breed from paint proposals', ...WRITE },
      coordinates: { out: ['proposals[].bounds'] },
      handler: ({ proposalIds, count, mutation, seed }, context) => {
        const actor = (context as { actor?: { id?: string } } | undefined)?.actor?.id;
        return c.breedProposal({
          proposalIds,
          count,
          mutation,
          seed,
          ...(actor ? { origin: `agent:${actor}` } : {}),
        });
      },
    },
    {
      name: 'get_proposal_genome',
      title: 'Get a proposal’s stroke genome',
      description:
        'Returns a pending paint proposal’s full stroke records (id, layerId, facet brush, colour, points in document pixels, seed and optional copies, load, stencils and paint) plus its title and bounds. Read-only: changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          proposalId: {
            type: 'string',
            description: 'Pending proposal id from breed_strokes, breed_proposal or list_paint_proposals.',
          },
        },
        required: ['proposalId'],
        additionalProperties: false,
      },
      annotations: { title: 'Get a proposal’s stroke genome', ...READ },
      coordinates: { out: ['bounds', 'strokes[].points[]'] },
      handler: ({ proposalId }) => c.getProposalGenome(proposalId),
    },
  ];
}

export const createEvolutionTools = createPaintEvolutionTools;

export interface PaintEvolutionToolProviderOptions {
  /** Provider id (unique per registry). Default `paint-evolution`. */
  id?: string;
  /** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
  namespace?: string;
}

/** Standalone tool provider for evolutionary strokes (also included in `createPaintEditorToolProvider`). */
export function createPaintEvolutionToolProvider(
  controller: PaintEditorController,
  options: PaintEvolutionToolProviderOptions = {}
): AgentToolProvider {
  return {
    id: options.id ?? 'paint-evolution',
    namespace: options.namespace,
    title: 'Paint evolutionary strokes',
    description: 'Breed and mutate stroke variants as paint proposals, cross proposals over and inspect proposal genomes.',
    skill: 'pixerate-paint-editor',
    tools: createPaintEvolutionTools(controller),
  };
}

