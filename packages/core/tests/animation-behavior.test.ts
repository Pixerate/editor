import { describe, expect, it } from 'vitest';
import { behaviorProgress, isMotionBehavior, motionSeedFromId, type MotionBehavior } from '../src/animation';

// Values computed by @pixerate/flair's own `behaviorProgress` (0.38, src/vector/motion.ts): the
// editor's port must give the same numbers, so behaviours exported to Flair play the same frames.
const FLAIR: [MotionBehavior, number, number, number, number][] = [
	[{ type: 'pulse', count: 2 }, 0.3, 0, 800, 0.9045084971874737],
	[{ type: 'oscillate', count: 3, decay: 1 }, 0.37, 0, 500, 0.4015771135416742],
	[{ type: 'oscillate', count: 2, wave: 'triangle' }, 0.61, 0, 1000, 0.8799999999999999],
	[{ type: 'wriggle', frequency: 3, octaves: 2, seed: 12345 }, 0.42, 0, 1500, -0.8816374191001599],
	[{ type: 'wriggle', frequency: 3, octaves: 2, seed: 12345 }, 0.42, 1, 1500, 0.1583722442561553],
	[{ type: 'wriggle', frequency: 2, octaves: 3, seed: 7 }, 0.08, 2, 1200, -0.16261818212231438],
	[{ type: 'overshoot', cycles: 3, damping: 4 }, 0.25, 0, 600, 1.2601300475114443]
];

describe('motion behaviours', () => {
	it("give Flair's numbers", () => {
		for (const [behavior, t, index, ms, expected] of FLAIR) expect(behaviorProgress(behavior, t, index, ms)).toBeCloseTo(expected, 12);
	});

	it('start at rest, and pulses, settling oscillations and wriggles end there', () => {
		for (const b of [{ type: 'pulse' }, { type: 'oscillate', decay: 1 }, { type: 'wriggle' }, { type: 'overshoot' }] as MotionBehavior[]) expect(behaviorProgress(b, 0)).toBeCloseTo(0, 9);
		for (const b of [{ type: 'pulse', count: 3 }, { type: 'oscillate', count: 2, decay: 1 }, { type: 'wriggle', seed: 9 }] as MotionBehavior[]) expect(behaviorProgress(b, 1)).toBeCloseTo(0, 9);
		expect(behaviorProgress({ type: 'overshoot' }, 1)).toBe(1);
	});

	it('seed a wriggle from an id as Flair does', () => {
		expect(motionSeedFromId('logo')).toBe(1795351707);
		expect(motionSeedFromId('logo')).not.toBe(motionSeedFromId('mark'));
	});

	it('validate their shape', () => {
		expect(isMotionBehavior({ type: 'oscillate', count: 2, decay: 1, wave: 'square' })).toBe(true);
		expect(isMotionBehavior({ type: 'oscillate', wave: 'zigzag' })).toBe(false);
		expect(isMotionBehavior({ type: 'pulse', count: 0 })).toBe(false);
		expect(isMotionBehavior({ type: 'wriggle', seed: 1.5 })).toBe(false);
		expect(isMotionBehavior({ type: 'spin' })).toBe(false);
	});
});
