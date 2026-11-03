/**
 * Agent tools for paint proposals: `propose_paint`, `list_paint_proposals`,
 * `accept_paint_proposal` and `reject_paint_proposal`. An agent suggests paint as a ghost the user
 * can take or leave, instead of painting it outright. They drive a {@link PaintProposals} store.
 */

import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { PaintProposal, PaintProposals } from './collaboration.js';

export interface PaintProposalToolProviderOptions {
  /** Provider id (unique per registry). Default `paint-proposals`. */
  id?: string;
  /** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
  namespace?: string;
  /** Accepting is not allowed: `accept_paint_proposal` refuses with this reason (a sentence). */
  readOnly?: boolean | string | (() => boolean | string);
  /** Origin of proposals from calls that name no actor (default the store's). */
  fallbackOrigin?: string;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const proposalIdArg = {
  type: 'object',
  properties: { proposalId: { type: 'string', minLength: 1, description: 'Id of a pending paint proposal, from propose_paint or list_paint_proposals.' } },
  required: ['proposalId'],
  additionalProperties: false,
} as const;

const hex = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } as const;

const opSchema = {
  type: 'object',
  description:
    'One thing to paint. kind "stroke": a stroke along points with a dry brush. kind "wash": an even wash over the suggestion\'s layer (a ground, a glaze). kind "echo": strokes already on the canvas painted again, moved, turned, scaled or mirrored (grass along a horizon, rain, hatching).',
  properties: {
    kind: { type: 'string', enum: ['stroke', 'wash', 'echo'], description: 'What this op paints (see above).' },
    points: {
      type: 'array',
      minItems: 1,
      description: 'stroke: pen samples in document pixels, in drawing order.',
      items: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Document x in pixels.' },
          y: { type: 'number', description: 'Document y in pixels.' },
          pressure: { type: 'number', minimum: 0, maximum: 1, description: 'Pen pressure 0..1 (default 0.5).' },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
    },
    brushId: { type: 'string', description: 'stroke: a dry brush id from list_brush_presets (dab, particle, bristle or mixer without pickup). Default the editor brush.' },
    size: { type: 'number', exclusiveMinimum: 0, description: "stroke: brush size in document pixels. Default the brush's." },
    color: { ...hex, description: 'stroke and echo: #rrggbb (stroke default the editor colour; echo default each stroke\'s colour). wash: required.' },
    opacity: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'wash: 0..1 (default 0.35).' },
    grain: { type: 'number', minimum: 0, maximum: 1, description: 'wash: how much it catches the paper grain, 0..1 (default 0.4).' },
    strokeIds: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'echo: ids of strokes on the canvas (list_strokes).' },
    dx: { type: 'number', description: 'echo: move right by this many document pixels (default 0).' },
    dy: { type: 'number', description: 'echo: move down by this many document pixels (default 0).' },
    rotate: { type: 'number', description: "echo: turn this many degrees clockwise about the strokes' centre (default 0)." },
    scale: { type: 'number', exclusiveMinimum: 0, description: 'echo: scale about the centre; brush size scales too (default 1).' },
    flipX: { type: 'boolean', description: 'echo: mirror horizontally about the centre (default false).' },
    repeat: { type: 'integer', minimum: 1, maximum: 50, description: 'echo: repeat the move this many times, each on top of the last (default 1).' },
  },
  required: ['kind'],
  additionalProperties: false,
} as const;

/** The proposal tools for a paint editor (see the module comment). */
export function createPaintProposalToolProvider(proposals: PaintProposals, options: PaintProposalToolProviderOptions = {}): AgentToolProvider {
  const readOnlyReason = (): string | null => {
    const ro = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
    return ro ? (typeof ro === 'string' ? ro : 'The painting is read-only: paint proposals can be made and rejected but not accepted.') : null;
  };
  const describe = (p: PaintProposal) => ({
    id: p.id,
    title: p.title,
    ...(p.rationale ? { rationale: p.rationale } : {}),
    origin: p.origin,
    ops: p.ops.map((op) => op.kind),
    placement: p.placement,
    bounds: p.bounds,
    anchors: p.anchors,
    missing: proposals.missing(p.id),
    createdAt: new Date(p.createdAt).toISOString(),
  });

  const proposeTool: AgentTool = {
    name: 'propose_paint',
    title: 'Propose paint',
    description:
      'Suggests paint without painting it: the user sees it as a ghost over the canvas and accepts or dismisses it, so use it for contributions they did not ask for. Accepted, it is painted on a new layer of its own (on top by default, at the bottom for a ground, or above a layer) as one undo step recorded as yours. Prefer what agents do well: a wash or ground, an echo of the user\'s strokes, a few deliberate strokes. Dry brushes only. Returns the proposal id, where the ghost sits (bounds, document pixels) and the strokes it builds on. Follow with accept_paint_proposal only when the user asked for it.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 120, description: 'What the suggestion adds, in a few words, e.g. "Warm ground behind the figure". The undo step\'s name once accepted.' },
        rationale: { type: 'string', description: 'Why it fits what the user is painting, in one sentence. Shown beside the ghost.' },
        ops: { type: 'array', minItems: 1, items: opSchema, description: 'What to paint, in order, onto the suggestion\'s layer.' },
        place: { type: 'string', enum: ['top', 'bottom', 'above'], description: 'Where the new layer goes: top (default), bottom (behind everything: grounds and washes), or above layerId.' },
        layerId: { type: 'string', description: 'With place "above": the layer to put it above (list_layers).' },
        layerName: { type: 'string', description: "The new layer's name (default the title)." },
      },
      required: ['title', 'ops'],
      additionalProperties: false,
    },
    annotations: { title: 'Propose paint', ...WRITE },
    handler: (args, context) => {
      const origin = context.actor?.id ? `agent:${context.actor.id}` : options.fallbackOrigin;
      const proposal = proposals.propose({ ...args, ...(origin ? { origin } : {}) } as Parameters<PaintProposals['propose']>[0]);
      const { id: _id, missing: _missing, createdAt: _createdAt, ...rest } = describe(proposal);
      return { proposalId: proposal.id, ...rest };
    },
  };

  const listTool: AgentTool = {
    name: 'list_paint_proposals',
    title: 'List paint proposals',
    description:
      'Lists the pending paint proposals (ghost paint not yet on the canvas): id, title, rationale, who proposed it, its op kinds, where it goes, where the ghost sits, the strokes it echoes and any of those since removed (missing: it can no longer be accepted), and whether accepting is allowed. Call before accept_paint_proposal or reject_paint_proposal.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List paint proposals', ...READ },
    handler: () => ({ proposals: proposals.getState().proposals.map(describe), readOnly: readOnlyReason() }),
  };

  const acceptTool: AgentTool = {
    name: 'accept_paint_proposal',
    title: 'Accept a paint proposal',
    description:
      "Paints a pending proposal on a new layer as one undo step, recorded as made by whoever proposed it, and drops it from the pending list; the user's active layer stays theirs. Refuses, changing nothing, when the painting is read-only or a stroke it echoes was removed. Returns the new layer id, the stroke ids painted and the undo step name.",
    inputSchema: proposalIdArg,
    annotations: { title: 'Accept a paint proposal', ...WRITE },
    handler: (args) => {
      const reason = readOnlyReason();
      if (reason) throw new Error(reason);
      return proposals.accept(args.proposalId);
    },
  };

  const rejectTool: AgentTool = {
    name: 'reject_paint_proposal',
    title: 'Reject a paint proposal',
    description: 'Dismisses a pending paint proposal: its ghost disappears and the painting and its history are unchanged. Use it to withdraw a suggestion that no longer fits. Returns the dismissed proposal id and title.',
    inputSchema: proposalIdArg,
    annotations: { title: 'Reject a paint proposal', ...WRITE },
    handler: (args) => {
      const p = proposals.reject(args.proposalId);
      return { proposalId: p.id, title: p.title, rejected: true };
    },
  };

  return {
    id: options.id ?? 'paint-proposals',
    ...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
    title: 'Paint proposals',
    description: 'Suggest paint as a ghost the user accepts or dismisses, and accept or reject pending suggestions.',
    skill: 'pixerate-paint-editor',
    tools: [proposeTool, listTool, acceptTool, rejectTool],
  };
}
