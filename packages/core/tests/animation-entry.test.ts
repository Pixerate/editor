import { describe, it, expect } from 'vitest';
import * as animation from '../src/animation/index.js';
import * as canvas from '../src/canvas/index.js';

const PUBLIC_API = [
	'resolveEasing',
	'evaluateEasing',
	'cubicBezierAt',
	'springAt',
	'ANIMATION_EASING_PRESETS',
	'ANIMATION_EASING_LABELS',
	'CUBIC_BEZIER_PRESETS',
	'parseCssEasing',
	'easingToCss',
	'evaluateTrack',
	'interpolateAnimationValue',
	'normalizeKeyframes',
	'mixColorsOklab',
	'parseOklab',
	'formatOklab',
	'rgbToOklab',
	'oklabToRgb',
	'AnimationPlayer',
	'createAnimationPlayer',
	'ManualClock',
	'realClock'
] as const;

describe('@pixerate/editor/animation', () => {
	it.each(PUBLIC_API)('exports %s, the same binding /canvas re-exports', (name) => {
		expect(animation[name]).toBeDefined();
		expect((canvas as Record<string, unknown>)[name]).toBe(animation[name]);
	});

	it('exports nothing that needs canvas nodes', () => {
		for (const name of ['applyAnimation', 'evaluateAnimation', 'getNodeAnimation', 'ANIMATABLE_PROPERTIES', 'createCanvasAnimationController']) {
			expect(name in animation).toBe(false);
		}
	});

	it('evaluates a plain track without any node', () => {
		const track: animation.AnimationTrack = {
			keyframes: [
				{ time: 1000, value: 10 },
				{ time: 0, value: 0, easing: 'linear' }
			]
		};
		expect(animation.evaluateTrack(track, 500)).toBe(5);
		expect(animation.evaluateTrack(track, -1)).toBe(0);
		expect(animation.evaluateTrack(track, 2000)).toBe(10);
		expect(animation.evaluateTrack({ keyframes: [{ time: 0, value: '#000000' }, { time: 100, value: '#ffffff' }] }, 50, 'color')).toBe(
			animation.mixColorsOklab('#000000', '#ffffff', 0.5)
		);
	});

	it('plays on a ManualClock', async () => {
		const clock = new animation.ManualClock();
		const player = animation.createAnimationPlayer({ clock, duration: 100 });
		player.play();
		await clock.advance(40);
		expect(player.currentTime).toBe(40);
		await clock.advance(100);
		expect(player.currentTime).toBe(100);
		expect(player.isPlaying).toBe(false);
	});
});
