/**
 * Painting alongside an agent: a change feed that says what the user (or an agent) just painted,
 * and proposals, the paint an agent suggests without painting it. A proposal is a few operations
 * (strokes, a wash, an echo of strokes already on the canvas) that `previewPaint` renders as a
 * ghost the user sees over the canvas; accepting paints them as one undo step recorded as the
 * proposer's, on a layer of their own, and dismissing changes nothing. The canvas equivalents are
 * `createCanvasChangeFeed` and `createCanvasProposals`.
 */

import type { RasterRect } from '../raster/surface';
import type { PaintBrush } from './brushes';
import { PaintEditorError, type PaintCommitEvent, type PaintEditorController } from './controller';
import type { PaintEvent } from './document';
import type { RecordedStroke } from './strokes';

// --- Change feed ---------------------------------------------------------------------

/** A layer as the feed reports it. */
export interface PaintChangeLayer {
  id: string;
  name: string;
}

/** What changed in the painting since the feed's last report. */
export interface PaintChange {
  /** Counts up from 1 for each change reported. */
  seq: number;
  /** `user`, or `agent:<id>` when an agent's step made it (see `PaintEditorController.withOrigin`). */
  origin: string;
  /** The history step behind it, when there was one. */
  commit?: PaintCommitEvent;
  addedStrokes: RecordedStroke[];
  removedStrokes: RecordedStroke[];
  /** Fills, clears and other recorded operations that aren't strokes. */
  events: PaintEvent[];
  addedLayers: PaintChangeLayer[];
  removedLayers: PaintChangeLayer[];
  /** Layers whose name, visibility, opacity or blend changed, with the fields. */
  changedLayers: (PaintChangeLayer & { fields: string[] })[];
  /** A stroke is being painted: more of the same gesture will follow. */
  inGesture: boolean;
  /** A stroke started since the last report (reported even when nothing else changed). */
  gestureStarted?: true;
  /** The stroke in progress ended (reported even when it painted nothing). */
  gestureEnded?: true;
  /** Milliseconds since the epoch. */
  at: number;
}

export interface PaintChangeFeed {
  /** Compares the painting with the last snapshot and reports the change, if any. Runs on every controller change. */
  check(): PaintChange | null;
  subscribe(listener: (change: PaintChange) => void): () => void;
  /** Takes a new snapshot without reporting the difference (e.g. after opening a document). */
  reset(): void;
  dispose(): void;
}

const LAYER_FIELDS = ['name', 'visible', 'opacity', 'blend'] as const;

/**
 * What changed in a painting, after each controller change: strokes added or removed (undo
 * included), fills and clears, layers added, removed or changed, and the start and end of each
 * stroke, tagged with who made it. Agents that paint alongside the user read it.
 */
export function createPaintChangeFeed(controller: PaintEditorController, options: { now?: () => number } = {}): PaintChangeFeed {
  const now = options.now ?? (() => Date.now());
  const listeners = new Set<(change: PaintChange) => void>();
  let seq = 0;
  let pending: PaintCommitEvent | undefined;

  type Snapshot = { doc: unknown; strokes: Map<string, RecordedStroke>; events: number; layers: Map<string, Record<string, unknown>>; stroking: boolean };
  const take = (): Snapshot => {
    const state = controller.getState();
    const doc = state.document;
    const layers = new Map<string, Record<string, unknown>>();
    for (const l of controller.listLayers()) layers.set(l.id, { name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend });
    return { doc, strokes: new Map(doc.strokes.map((s) => [s.id, s])), events: doc.paintEvents?.length ?? 0, layers, stroking: state.stroking };
  };
  let last = take();

  const check = (): PaintChange | null => {
    const state = controller.getState();
    if (state.document === last.doc && state.stroking === last.stroking) return null;
    const next = take();
    const addedStrokes = [...next.strokes.values()].filter((s) => !last.strokes.has(s.id));
    const removedStrokes = [...last.strokes.values()].filter((s) => !next.strokes.has(s.id));
    const allEvents = (state.document.paintEvents ?? []) as PaintEvent[];
    const events = next.events > last.events ? allEvents.slice(last.events) : [];
    const addedLayers: PaintChangeLayer[] = [];
    const changedLayers: (PaintChangeLayer & { fields: string[] })[] = [];
    for (const [id, l] of next.layers) {
      const before = last.layers.get(id);
      if (!before) addedLayers.push({ id, name: String(l.name) });
      else {
        const fields = LAYER_FIELDS.filter((f) => before[f] !== l[f]);
        if (fields.length) changedLayers.push({ id, name: String(l.name), fields });
      }
    }
    const removedLayers = [...last.layers].filter(([id]) => !next.layers.has(id)).map(([id, l]) => ({ id, name: String(l.name) }));
    const gestureStarted = next.stroking && !last.stroking;
    const gestureEnded = !next.stroking && last.stroking;
    last = next;
    const edited = addedStrokes.length + removedStrokes.length + events.length + addedLayers.length + removedLayers.length + changedLayers.length > 0;
    if (!edited && !gestureStarted && !gestureEnded) return null;
    const commit = edited ? pending : undefined;
    if (edited) pending = undefined;
    const change: PaintChange = {
      seq: ++seq,
      origin: commit?.origin ?? 'user',
      ...(commit ? { commit } : {}),
      addedStrokes,
      removedStrokes,
      events,
      addedLayers,
      removedLayers,
      changedLayers,
      inGesture: next.stroking,
      ...(gestureStarted ? { gestureStarted: true as const } : {}),
      ...(gestureEnded ? { gestureEnded: true as const } : {}),
      at: now(),
    };
    listeners.forEach((l) => l(change));
    return change;
  };

  const offCommit = controller.onCommit((event) => {
    pending = event;
  });
  const offState = controller.subscribe(() => {
    check();
  });

  return {
    check,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      last = take();
      pending = undefined;
    },
    dispose() {
      offCommit();
      offState();
      listeners.clear();
    },
  };
}

// --- Proposals -----------------------------------------------------------------------

/** A stroke to paint: pen samples in document pixels. */
export interface PaintProposalStrokeOp {
  kind: 'stroke';
  points: { x: number; y: number; pressure?: number }[];
  /** A dry brush from the library (default the editor's brush). */
  brushId?: string;
  /** #rrggbb (default the editor colour). */
  color?: string;
  /** Brush size in document pixels (default the brush's). */
  size?: number;
}

/** A wash over the suggestion's whole layer, like a ground or a glaze. */
export interface PaintProposalWashOp {
  kind: 'wash';
  color: string;
  /** 0..1 (default 0.35). */
  opacity?: number;
  /** Paper grain response 0..1 (default 0.4). */
  grain?: number;
}

/** Strokes already on the canvas, painted again moved, turned, scaled or mirrored. */
export interface PaintProposalEchoOp {
  kind: 'echo';
  strokeIds: string[];
  dx?: number;
  dy?: number;
  /** Degrees clockwise about the strokes' centre (default 0). */
  rotate?: number;
  scale?: number;
  flipX?: boolean;
  /** Repeat the move this many times, each on top of the last (default 1). */
  repeat?: number;
  /** Recolour (default each stroke's colour). */
  color?: string;
}

export type PaintProposalOp = PaintProposalStrokeOp | PaintProposalWashOp | PaintProposalEchoOp;

/** Where accepted paint goes: a new layer of its own (above a layer, on top, or at the bottom, behind everything). */
export interface PaintProposalPlacement {
  /** Default `top`. `above` needs `layerId`. */
  place?: 'top' | 'bottom' | 'above';
  layerId?: string;
  /** The new layer's name (default the proposal's title). */
  layerName?: string;
}

export interface PaintProposalInput extends PaintProposalPlacement {
  /** What the suggestion adds, in a few words. Also the undo step's name once accepted. */
  title: string;
  /** Why it fits what the user is doing, in a sentence. */
  rationale?: string;
  /** Who suggests it (`agent:<id>`); defaults to the store's `origin`. */
  origin?: string;
  ops: PaintProposalOp[];
}

export interface PaintProposal {
  id: string;
  title: string;
  rationale?: string;
  origin: string;
  ops: PaintProposalOp[];
  placement: PaintProposalPlacement;
  /** Where the ghost sits (document pixels), or `null` when it painted nothing. */
  bounds: RasterRect | null;
  /** The ghost: the picture as it would look, inside `bounds` (straight RGBA). */
  ghost: Uint8ClampedArray;
  /** Strokes on the canvas it builds on (echo ops). */
  anchors: string[];
  createdAt: number;
}

export interface PaintProposalAcceptResult {
  proposalId: string;
  layerId: string;
  /** The strokes it painted. */
  strokeIds: string[];
  /** The undo step's name. */
  label: string;
}

export interface PaintProposalsState {
  proposals: readonly PaintProposal[];
}

export interface PaintProposals {
  getState(): PaintProposalsState;
  subscribe(listener: (state: PaintProposalsState) => void): () => void;
  /** Validates and previews a suggestion, and adds it to the pending list. Throws, changing nothing, when it can't be painted. */
  propose(input: PaintProposalInput): PaintProposal;
  /** Paints a pending proposal as one undo step recorded as the proposer's. The active layer stays the user's. */
  accept(id: string): PaintProposalAcceptResult;
  /** Drops a pending proposal; the painting is unchanged. */
  reject(id: string): PaintProposal;
  /** Drops every pending proposal (or those of one origin). Returns the ids dropped. */
  clear(origin?: string): string[];
  get(id: string): PaintProposal | undefined;
  /** Strokes an echo builds on that are no longer on the canvas (it can't be accepted until re-proposed). */
  missing(id: string): string[];
}

export interface PaintProposalsOptions {
  controller: PaintEditorController;
  /** Origin of proposals that name none (default `agent:anonymous`). */
  origin?: string;
  /** The most points one proposal may paint (default 4000). */
  maxPoints?: number;
  now?: () => number;
  idGenerator?: () => string;
}

const HEX = /^#[0-9a-f]{6}$/i;
const DRY_ENGINES = new Set(['dab', 'particle', 'bristle', 'mixer']);

/** Why `brush` can't paint a suggestion, or `null`. Suggestions are previewed, so they must be dry and paint on their own. */
function suggestionBrushRefusal(brush: PaintBrush): string | null {
  if (!DRY_ENGINES.has(brush.engine)) return `The ${brush.name} brush (${brush.engine}) can't paint a suggestion: suggestions are dry paint on a layer of their own. Use a dab, particle, bristle or mixer brush.`;
  if (brush.behavior.pickup > 0) return `The ${brush.name} brush picks up paint, which a suggestion on its own layer can't; choose a brush without pickup.`;
  return null;
}

/** A store of paint an agent suggests (see the module comment). */
export function createPaintProposals(options: PaintProposalsOptions): PaintProposals {
  const { controller } = options;
  const now = options.now ?? (() => Date.now());
  const maxPoints = options.maxPoints ?? 4000;
  let seq = 0;
  const makeId = options.idGenerator ?? (() => `paint-proposal-${++seq}`);
  let state: PaintProposalsState = { proposals: [] };
  const listeners = new Set<(state: PaintProposalsState) => void>();
  const set = (proposals: readonly PaintProposal[]) => {
    state = { proposals };
    listeners.forEach((l) => l(state));
  };
  const find = (id: string) => {
    const p = state.proposals.find((x) => x.id === id);
    if (!p) throw new PaintEditorError(`No pending paint proposal "${id}". Call list_paint_proposals for the ids.`);
    return p;
  };
  const strokeIds = () => new Set(controller.getStrokes().map((s) => s.id));

  const validate = (input: PaintProposalInput) => {
    if (!input.title?.trim()) throw new PaintEditorError('A proposal needs a title: what it adds, in a few words.');
    if (!Array.isArray(input.ops) || !input.ops.length) throw new PaintEditorError('A proposal needs at least one op (stroke, wash or echo).');
    const place = input.place ?? 'top';
    if (place === 'above') {
      if (!input.layerId) throw new PaintEditorError('place "above" needs layerId: the layer to put the suggestion above (list_layers).');
      if (!controller.listLayers().some((l) => l.id === input.layerId)) throw new PaintEditorError(`Unknown layer "${input.layerId}". Call list_layers for the ids.`);
    }
    const known = strokeIds();
    let points = 0;
    input.ops.forEach((op, i) => {
      const at = `ops[${i}]`;
      if (op.kind === 'stroke') {
        if (!op.points?.length) throw new PaintEditorError(`${at}: a stroke needs points in document pixels.`);
        points += op.points.length;
        if (op.color !== undefined && !HEX.test(op.color)) throw new PaintEditorError(`${at}: color "${op.color}" is not #rrggbb.`);
        const brush = op.brushId ? controller.getBrush(op.brushId) : controller.getState().brush;
        if (!brush) throw new PaintEditorError(`${at}: unknown brush "${op.brushId}". Call list_brush_presets for the ids.`);
        const refusal = suggestionBrushRefusal(brush);
        if (refusal) throw new PaintEditorError(`${at}: ${refusal}`);
        if (op.size !== undefined && !(op.size > 0)) throw new PaintEditorError(`${at}: size must be above 0 (document pixels).`);
      } else if (op.kind === 'wash') {
        if (!HEX.test(op.color ?? '')) throw new PaintEditorError(`${at}: a wash needs color as #rrggbb.`);
        if (op.opacity !== undefined && !(op.opacity > 0 && op.opacity <= 1)) throw new PaintEditorError(`${at}: opacity must be in (0, 1].`);
      } else if (op.kind === 'echo') {
        if (!op.strokeIds?.length) throw new PaintEditorError(`${at}: an echo needs strokeIds (list_strokes).`);
        const unknown = op.strokeIds.filter((id) => !known.has(id));
        if (unknown.length) throw new PaintEditorError(`${at}: unknown stroke ${unknown.map((u) => `"${u}"`).join(', ')}. Call list_strokes for the ids.`);
        if (op.color !== undefined && !HEX.test(op.color)) throw new PaintEditorError(`${at}: color "${op.color}" is not #rrggbb.`);
        if (op.repeat !== undefined && !(Number.isInteger(op.repeat) && op.repeat >= 1 && op.repeat <= 50)) throw new PaintEditorError(`${at}: repeat must be a whole number from 1 to 50.`);
        for (const id of op.strokeIds) {
          const stroke = controller.getStrokes().find((s) => s.id === id)!;
          const refusal = suggestionBrushRefusal(stroke.brush);
          if (refusal) throw new PaintEditorError(`${at}: stroke "${id}": ${refusal}`);
          points += stroke.points.length * (op.repeat ?? 1);
        }
      } else {
        throw new PaintEditorError(`${at}: unknown kind "${(op as { kind?: string }).kind}"; use stroke, wash or echo.`);
      }
    });
    if (points > maxPoints) throw new PaintEditorError(`The proposal paints ${points} points; the most is ${maxPoints}. Suggest less, or echo fewer strokes.`);
  };

  /** Paints the ops onto `layerId`. */
  const paint = (ops: readonly PaintProposalOp[], layerId: string): string[] => {
    const before = strokeIds();
    for (const op of ops) {
      if (op.kind === 'stroke') {
        controller.paintStroke({
          layerId,
          points: op.points,
          ...(op.brushId ? { brushId: op.brushId } : {}),
          ...(op.color ? { color: op.color } : {}),
          ...(op.size ? { brush: { tip: { size: op.size } } } : {}),
          stencils: false,
        });
      } else if (op.kind === 'wash') {
        controller.fillLayer({ layerId, color: op.color, opacity: op.opacity ?? 0.35, grain: op.grain ?? 0.4 });
      } else {
        const { kind: _kind, strokeIds: ids, color, repeat, ...variation } = op;
        controller.replayStrokes({ strokeIds: ids, layerId, ...(color ? { color } : {}), ...(repeat ? { repeat } : {}), ...variation });
      }
    }
    return controller.getStrokes().map((s) => s.id).filter((id) => !before.has(id));
  };

  const missing = (id: string): string[] => {
    const p = state.proposals.find((x) => x.id === id);
    if (!p) return [];
    const known = strokeIds();
    return p.anchors.filter((a) => !known.has(a));
  };

  const placementOf = (input: PaintProposalPlacement): PaintProposalPlacement => ({
    place: input.place ?? 'top',
    ...(input.layerId ? { layerId: input.layerId } : {}),
    ...(input.layerName ? { layerName: input.layerName } : {}),
  });
  const topLayerId = () => controller.listLayers().find((l) => l.parentId === null)?.id;

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    propose(input) {
      validate(input);
      const placement = placementOf(input);
      const preview = controller.previewPaint(
        (layerId) => {
          paint(input.ops, layerId);
        },
        placement.place === 'bottom' ? { bottom: true } : { aboveId: placement.place === 'above' ? placement.layerId : topLayerId() }
      );
      const proposal: PaintProposal = {
        id: makeId(),
        title: input.title.trim().slice(0, 120),
        ...(input.rationale ? { rationale: input.rationale } : {}),
        origin: input.origin ?? options.origin ?? 'agent:anonymous',
        ops: input.ops.map((op) => ({ ...op })) as PaintProposalOp[],
        placement,
        bounds: preview.bounds,
        ghost: preview.composite,
        anchors: [...new Set(input.ops.flatMap((op) => (op.kind === 'echo' ? op.strokeIds : [])))],
        createdAt: now(),
      };
      set([...state.proposals, proposal]);
      return proposal;
    },
    accept(id) {
      const p = find(id);
      const gone = missing(id);
      if (gone.length) throw new PaintEditorError(`Paint proposal "${p.title}" echoes strokes that are no longer on the canvas (${gone.join(', ')}); dismiss it or propose it again.`);
      const placement = p.placement;
      if (placement.place === 'above' && !controller.listLayers().some((l) => l.id === placement.layerId)) {
        throw new PaintEditorError(`Paint proposal "${p.title}" goes above layer "${placement.layerId}", which is gone; dismiss it or propose it again.`);
      }
      const active = controller.getState().document.activeLayerId;
      const result = controller.withOrigin(p.origin, () =>
        controller.group(p.title, () => {
          const layer = controller.addLayer({ name: placement.layerName ?? p.title, ...(placement.place === 'above' ? { aboveId: placement.layerId } : placement.place === 'top' ? { aboveId: topLayerId() } : {}) });
          if (placement.place === 'bottom') controller.moveLayer(layer.id, 0, null);
          return { layerId: layer.id, strokeIds: paint(p.ops, layer.id) };
        })
      );
      // The suggestion's layer is Pixie's; keep the user on the layer they were painting.
      if (active && controller.listLayers().some((l) => l.id === active)) controller.setActiveLayer(active);
      set(state.proposals.filter((x) => x.id !== id));
      return { proposalId: id, layerId: result.layerId, strokeIds: result.strokeIds, label: p.title };
    },
    reject(id) {
      const p = find(id);
      set(state.proposals.filter((x) => x.id !== id));
      return p;
    },
    clear(origin) {
      const dropped = state.proposals.filter((p) => !origin || p.origin === origin);
      if (dropped.length) set(state.proposals.filter((p) => !dropped.includes(p)));
      return dropped.map((p) => p.id);
    },
    get: (id) => state.proposals.find((p) => p.id === id),
    missing,
  };
}

/**
 * Where to draw a proposal's ghost and its pixels, for a canvas element placed at `bounds` in
 * document pixels (`new ImageData(data, width, height)`), or `null` when it paints nothing.
 */
export function paintProposalGhost(proposal: PaintProposal): { x: number; y: number; width: number; height: number; data: Uint8ClampedArray } | null {
  const b = proposal.bounds;
  if (!b || !b.width || !b.height || proposal.ghost.length !== b.width * b.height * 4) return null;
  return { x: b.x, y: b.y, width: b.width, height: b.height, data: proposal.ghost };
}
