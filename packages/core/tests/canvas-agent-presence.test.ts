import { describe, it, expect } from 'vitest';
import {
	hashString,
	getAgentCardAnchor,
	calculateCurvedPath,
	getNaturalMovementTiming,
	getCursorTransitionDuration,
	calculateCursorArrowRotation,
	formatAgentCursorName,
	isAgentCursor
} from '../src/canvas';

describe('agent presence math (core)', () => {
	it('computes deterministic hashes with hashString', () => {
		const h1 = hashString('agent-1:node-2:header');
		const h2 = hashString('agent-1:node-2:header');
		const h3 = hashString('agent-2:node-2:header');
		expect(h1).toBe(h2);
		expect(h1).toBeGreaterThanOrEqual(0);
		expect(h1).not.toBe(h3);
	});

	it('computes distinct card inspection anchors per agent and zone', () => {
		const headerAnchor = getAgentCardAnchor('agent-alpha', 'node-1', 'header');
		const footerAnchor = getAgentCardAnchor('agent-alpha', 'node-1', 'footer');
		expect(headerAnchor.zoneName).toBe('header');
		expect(footerAnchor.zoneName).toBe('footer');
		expect(headerAnchor.y).toBeLessThan(footerAnchor.y);

		// Numeric zone index wraps cleanly
		const numericAnchor = getAgentCardAnchor('agent-alpha', 'node-1', 2);
		expect(numericAnchor.zoneName).toBe('body');
	});

	it('calculates parabolic curved path with lift at mid-flight', () => {
		const start = calculateCurvedPath(0, 100, 200, 100, 0, { arcHeight: -40 });
		const mid = calculateCurvedPath(0, 100, 200, 100, 0.5, { arcHeight: -40 });
		const end = calculateCurvedPath(0, 100, 200, 100, 1, { arcHeight: -40 });

		expect(start).toEqual({ x: 0, y: 100 });
		expect(mid.x).toBeCloseTo(100);
		expect(mid.y).toBeCloseTo(60); // lifted upward by -40px at p=0.5
		expect(end.x).toBeCloseTo(200);
		expect(end.y).toBeCloseTo(100);
	});

	it('computes natural movement timing and cursor transition duration', () => {
		const timing = getNaturalMovementTiming(500, 'agent-seed');
		expect(timing.duration).toBeGreaterThanOrEqual(500);
		expect(timing.duration).toBeLessThanOrEqual(1000);
		expect(timing.arcHeight).toBeLessThan(0);

		const shortDur = getCursorTransitionDuration(30, 'seed');
		const longDur = getCursorTransitionDuration(600, 'seed');
		expect(shortDur).toBeLessThan(longDur);
	});

	it('calculates cursor arrow rotation toward target node center with shortest-path unwrapping', () => {
		const noTarget = calculateCursorArrowRotation({ x: 0, y: 0 }, null, true);
		expect(noTarget).toEqual({ shouldPoint: false, rotationDeg: 0 });

		// Target directly to the right (angleDeg = 0 -> rawTargetDeg = 135)
		const rightRot = calculateCursorArrowRotation({ x: 0, y: 0 }, { x: 100, y: 0 }, true, false, 0);
		expect(rightRot.shouldPoint).toBe(true);
		expect(rightRot.rotationDeg).toBeCloseTo(135);

		// Shortest angular path unwrapping near 180/-180 boundary
		const unwrapped = calculateCursorArrowRotation({ x: 0, y: 0 }, { x: 0, y: 100 }, true, false, 200);
		expect(unwrapped.shouldPoint).toBe(true);
		expect(Math.abs(unwrapped.rotationDeg - 200)).toBeLessThanOrEqual(180);
	});

	it('formats agent cursor names and detects agent cursors', () => {
		expect(formatAgentCursorName('@@director-agent ')).toBe('director-agent');
		expect(formatAgentCursorName('')).toBe('Agent');
		expect(isAgentCursor({ id: 'agent-1', username: 'Director' })).toBe(true);
		expect(isAgentCursor({ id: 'user-1', role: 'Autonomous Specialist' })).toBe(true);
		expect(isAgentCursor({ id: 'user-1', username: 'Alice' })).toBe(false);
	});
});
