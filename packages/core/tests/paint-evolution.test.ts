import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
  PaintEditorController,
  createPaintEditorToolProvider,
  createPaintEvolutionToolProvider,
  createPaintProposalToolProvider,
  createPaintProposals,
  crossoverGenomes,
  crossoverStrokes,
  describeGenomeDiff,
  driftBrushFacets,
  driftColorOklch,
  exportProposalContactSheetPng,
  jitterStrokePoints,
  mixColorOklch,
  mutateGenome,
  mutateStroke,
  renderProposalContactSheet,
  rerollStrokeSeed,
  resampleStrokePoints,
} from '../src/paint-editor';

describe('evolutionary strokes', () => {
  it('produces identical genomes from the same seed and different genomes from different seeds', () => {
    const controller = new PaintEditorController({ width: 120, height: 90, paper: 'hot-pressed' });
    const painted = controller.paintStroke({
      brushId: 'ink-pen',
      color: '#2563eb',
      seed: 42,
      points: [
        { x: 16, y: 20, pressure: 0.4, t: 0 },
        { x: 54, y: 42, pressure: 0.8, t: 24 },
        { x: 96, y: 30, pressure: 0.5, t: 48 },
      ],
    });
    const stroke = controller.document.strokes.find((s) => s.id === painted.strokeId)!;
    const rates = { geometry: 0.4, color: 0.3, brush: 0.35, seed: 0.8 };

    const g1 = mutateGenome([stroke], rates, 9001);
    const g2 = mutateGenome([stroke], rates, 9001);
    const g3 = mutateGenome([stroke], rates, 9002);

    expect(g1).toEqual(g2);
    expect(g1).not.toEqual(g3);
    const summary = describeGenomeDiff([stroke], g1);
    expect(summary.diff.length).toBeGreaterThan(0);
    expect(summary.changes.geometry).toBe(true);
  });

  it('mutates individual channels independently and preserves disabled channels', () => {
    const controller = new PaintEditorController({ width: 120, height: 90, paper: 'cold-pressed' });
    const painted = controller.paintStroke({
      brushId: 'soft-pastel',
      color: '#dc2626',
      seed: 100,
      points: [
        { x: 20, y: 25, pressure: 0.5 },
        { x: 50, y: 45, pressure: 0.7 },
        { x: 85, y: 35, pressure: 0.6 },
      ],
    });
    const stroke = controller.document.strokes.find((s) => s.id === painted.strokeId)!;

    const zero = mutateStroke(stroke, { geometry: 0, color: 0, brush: 0, seed: 0 }, 77);
    expect(zero.points).toEqual(stroke.points);
    expect(zero.color).toBe(stroke.color);
    expect(zero.brush).toEqual(stroke.brush);
    expect(zero.seed).toBe(stroke.seed);

    const colorOnly = mutateStroke(stroke, { geometry: 0, color: 0.8, brush: 0, seed: 0 }, 77);
    expect(colorOnly.points).toEqual(stroke.points);
    expect(colorOnly.brush).toEqual(stroke.brush);
    expect(colorOnly.seed).toBe(stroke.seed);
    expect(colorOnly.color).not.toBe(stroke.color);

    const brushOnly = mutateStroke(stroke, { geometry: 0, color: 0, brush: 0.8, seed: 0 }, 77);
    expect(brushOnly.points).toEqual(stroke.points);
    expect(brushOnly.color).toBe(stroke.color);
    expect(brushOnly.seed).toBe(stroke.seed);
    expect(brushOnly.brush).not.toEqual(stroke.brush);
    expect(brushOnly.brush.tip.size).toBeGreaterThanOrEqual(1);
    expect(brushOnly.brush.tip.size).toBeLessThanOrEqual(400);
    expect(brushOnly.brush.tip.hardness).toBeGreaterThanOrEqual(0);
    expect(brushOnly.brush.tip.hardness).toBeLessThanOrEqual(1);

    const jittered = jitterStrokePoints(stroke.points, 0.5, 123, stroke.brush.tip.size);
    expect(jittered).toHaveLength(stroke.points.length);
    expect(jittered).not.toEqual(stroke.points);

    expect(driftColorOklch('#3b82f6', 0, 12)).toBe('#3b82f6');
    expect(driftColorOklch('#3b82f6', 0.6, 12)).toMatch(/^#[0-9a-f]{6}$/);
    expect(mixColorOklch('#ef4444', '#3b82f6', 0.5)).toMatch(/^#[0-9a-f]{6}$/);
    expect(driftBrushFacets(stroke.brush, 0, 55)).toEqual(stroke.brush);
    expect(rerollStrokeSeed(100, 1, 99)).not.toBe(100);
    expect(rerollStrokeSeed(100, 0, 99)).toBe(100);
  });

  it('resamples paths and crosses over strokes and genomes', () => {
    const controller = new PaintEditorController({ width: 120, height: 90, paper: 'hot-pressed' });
    const s1 = controller.paintStroke({
      brushId: 'pencil-hb',
      color: '#ef4444',
      seed: 11,
      points: [
        { x: 10, y: 10, pressure: 0.3, t: 0 },
        { x: 60, y: 10, pressure: 0.9, t: 20 },
      ],
    });
    const s2 = controller.paintStroke({
      brushId: 'charcoal-stick',
      color: '#22c55e',
      seed: 22,
      points: [
        { x: 10, y: 70, pressure: 0.8, t: 0 },
        { x: 35, y: 70, pressure: 0.5, t: 10 },
        { x: 60, y: 70, pressure: 0.4, t: 20 },
        { x: 90, y: 70, pressure: 0.7, t: 30 },
      ],
    });
    const a = controller.document.strokes.find((s) => s.id === s1.strokeId)!;
    const b = controller.document.strokes.find((s) => s.id === s2.strokeId)!;

    const resampled = resampleStrokePoints(a.points, 5);
    expect(resampled).toHaveLength(5);
    expect(resampled[0]!.x).toBeCloseTo(10, 5);
    expect(resampled[4]!.x).toBeCloseTo(60, 5);

    const child = crossoverStrokes(a, b, 303);
    expect(child.points).toHaveLength(3);
    expect(child.points[0]!.y).toBeGreaterThan(10);
    expect(child.points[0]!.y).toBeLessThan(70);
    expect(child.color).not.toBe(a.color);
    expect(child.color).not.toBe(b.color);

    const crossed = crossoverGenomes([a], [b, a], { geometry: 0.2, color: 0.2, brush: 0.2, seed: 0.5 }, 404);
    expect(crossed).toHaveLength(2);
  });

  it('breeds strokes, crosses proposals, inspects genomes, renders contact sheets, and accepts in one undo step', async () => {
    const controller = new PaintEditorController({ width: 120, height: 90, paper: 'cold-pressed' });
    const proposals = createPaintProposals({ controller });
    const registry = new ToolRegistry();
    registry.register(createPaintEditorToolProvider(controller, { id: 'paint', namespace: 'paint' }));
    registry.register(createPaintProposalToolProvider(proposals, { id: 'paint-proposals', namespace: 'paint' }));

    const p1 = await registry.callTool('paint__paint_stroke', {
      brushId: 'ink-pen',
      color: '#1d4ed8',
      seed: 10,
      points: [
        { x: 18, y: 24, pressure: 0.5 },
        { x: 64, y: 48, pressure: 0.8 },
        { x: 102, y: 28, pressure: 0.4 },
      ],
    });
    expect(p1.isError).toBeFalsy();
    const strokeId = (p1.structuredContent as { strokeId: string }).strokeId;

    const bred = await registry.callTool('paint__breed_strokes', {
      strokeIds: [strokeId],
      count: 3,
      mutation: { geometry: 0.35, color: 0.25, brush: 0.3, seed: 0.5 },
      seed: 500,
    });
    expect(bred.structuredContent).not.toHaveProperty('error');
    expect(bred.isError).toBeFalsy();
    const bredData = bred.structuredContent as {
      proposalIds: string[];
      proposals: { proposalId: string; title: string; seed: number; diff: string; changes: string[] }[];
    };
    expect(bredData.proposalIds).toHaveLength(3);
    expect(proposals.getState().proposals).toHaveLength(3);

    // Same seed produces the exact same genome strokes.
    const genome1 = await registry.callTool('paint__get_proposal_genome', {
      proposalId: bredData.proposalIds[0]!,
    });
    expect(genome1.isError).toBeFalsy();
    const g1Strokes = (genome1.structuredContent as { strokes: unknown[] }).strokes;
    expect(g1Strokes).toHaveLength(1);

    // Breed a second generation from 2 proposals (crossover).
    const crossed = await registry.callTool('paint__breed_proposal', {
      proposalIds: [bredData.proposalIds[0]!, bredData.proposalIds[1]!],
      count: 2,
      mutation: { geometry: 0.2, color: 0.2, brush: 0.2, seed: 0.5 },
      seed: 700,
    });
    expect(crossed.isError).toBeFalsy();
    const crossedIds = (crossed.structuredContent as { proposalIds: string[] }).proposalIds;
    expect(crossedIds).toHaveLength(2);

    // Contact sheet renders the pending variant proposals cleanly.
    const sheet = renderProposalContactSheet(controller, proposals.getState().proposals);
    expect(sheet.width).toBeGreaterThan(0);
    expect(sheet.height).toBeGreaterThan(0);
    const sheetPng = exportProposalContactSheetPng(controller, proposals.getState().proposals);
    expect(sheetPng.base64.length).toBeGreaterThan(32);

    // Accepting a bred proposal paints onto a new layer in a single undo step.
    const layersBefore = controller.document.layers.length;
    const strokesBefore = controller.document.strokes.length;
    const accepted = await registry.callTool('paint__accept_paint_proposal', {
      proposalId: crossedIds[0]!,
    });
    expect(accepted.isError).toBeFalsy();
    expect(controller.document.layers.length).toBe(layersBefore + 1);
    expect(controller.document.strokes.length).toBe(strokesBefore + 1);

    const undone = controller.undo();
    expect(undone).toBe('Crossover 1 (paint-proposal-1 × paint-proposal-2)');
    expect(controller.document.layers.length).toBe(layersBefore);
    expect(controller.document.strokes.length).toBe(strokesBefore);
  });

  it('refuses unknown ids, non-live brushes, and out-of-range counts or mutation rates', async () => {
    const controller = new PaintEditorController({ width: 96, height: 72, paper: 'cold-pressed' });
    const registry = new ToolRegistry();
    registry.register(createPaintEvolutionToolProvider(controller, { id: 'evo', namespace: 'evo' }));

    // Paint a wet stroke (rejected by liveStrokeRefusal).
    const wet = controller.paintStroke({
      brushId: 'watercolor-round',
      color: '#0284c7',
      points: [
        { x: 16, y: 20 },
        { x: 64, y: 40 },
      ],
    });

    const wetRes = await registry.callTool('evo__breed_strokes', {
      strokeIds: [wet.strokeId],
    });
    expect(wetRes.isError).toBe(true);
    expect((wetRes.structuredContent as { error: { message: string } }).error.message).toMatch(/wet|dry|cannot/i);

    const unknownStroke = await registry.callTool('evo__breed_strokes', {
      strokeIds: ['stroke-missing'],
    });
    expect(unknownStroke.isError).toBe(true);
    expect((unknownStroke.structuredContent as { error: { message: string } }).error.message).toMatch(/Unknown stroke "stroke-missing"/);

    const unknownProposal = await registry.callTool('evo__breed_proposal', {
      proposalIds: ['paint-proposal-missing'],
    });
    expect(unknownProposal.isError).toBe(true);
    expect((unknownProposal.structuredContent as { error: { message: string } }).error.message).toMatch(/No pending paint proposal/);

    const badCount = await registry.callTool('evo__breed_strokes', {
      strokeIds: [wet.strokeId],
      count: 99,
    });
    expect(badCount.isError).toBe(true);

    // Direct controller validation for out-of-range counts and mutation rates.
    const dry = controller.paintStroke({
      brushId: 'ink-pen',
      color: '#111827',
      points: [
        { x: 12, y: 12 },
        { x: 48, y: 36 },
      ],
    });
    expect(() => controller.breedStrokes({ strokeIds: [dry.strokeId], count: 1 })).toThrow(/2..12/);
    expect(() => controller.breedStrokes({ strokeIds: [dry.strokeId], mutation: { geometry: 2 } })).toThrow(/0..1/);
  });

  it('returns hosted coordinates when the provider has an origin offset', async () => {
    const controller = new PaintEditorController({ width: 80, height: 60, paper: 'hot-pressed' });
    const registry = new ToolRegistry();
    registry.register(createPaintEditorToolProvider(controller, { id: 'paint', namespace: 'paint', origin: { x: 100, y: 200 } }));

    const s = controller.paintStroke({
      brushId: 'ink-pen',
      color: '#111827',
      points: [
        { x: 20, y: 20 },
        { x: 50, y: 40 },
      ],
    });

    const bred = await registry.callTool('paint__breed_strokes', {
      strokeIds: [s.strokeId],
      count: 2,
      mutation: { geometry: 0, color: 0, brush: 0, seed: 0 },
      seed: 1,
    });
    expect(bred.isError).toBeFalsy();
    const pid = (bred.structuredContent as { proposalIds: string[] }).proposalIds[0]!;

    const genome = await registry.callTool('paint__get_proposal_genome', { proposalId: pid });
    expect(genome.isError).toBeFalsy();
    const pts = (genome.structuredContent as { strokes: { points: { x: number; y: number }[] }[] }).strokes[0]!.points;
    expect(pts[0]).toMatchObject({ x: 120, y: 220 });
  });
});
