import { describe, expect, it } from 'vitest';
import { locatePlaybackChrome, playbackRectFromClient } from '../src/tools';

const box = (left: number, top: number, width: number, height: number) => ({ getBoundingClientRect: () => ({ left, top, width, height }) });

describe('playbackRectFromClient', () => {
	it('maps both corners through fromViewport', () => {
		const fromViewport = (p: { x: number; y: number }) => ({ x: (p.x - 60) / 2, y: (p.y - 20) / 2 });
		expect(playbackRectFromClient({ left: 110, top: 20, width: 20, height: 20 }, fromViewport)).toEqual({ x: 25, y: 0, width: 10, height: 10 });
	});

	it('is the client box without fromViewport, and null for an empty box', () => {
		expect(playbackRectFromClient({ left: 1, top: 2, width: 3, height: 4 })).toEqual({ x: 1, y: 2, width: 3, height: 4 });
		expect(playbackRectFromClient({ left: 1, top: 2, width: 0, height: 4 })).toBeNull();
		expect(playbackRectFromClient(null)).toBeNull();
	});
});

describe('locatePlaybackChrome', () => {
	const ref = { kind: 'control', id: 'zoom' };

	it('prefers locate, then maps locateElement', () => {
		expect(locatePlaybackChrome(ref, { locate: () => ({ x: 1, y: 1, width: 1, height: 1 }), locateElement: () => box(0, 0, 9, 9) })).toEqual({ x: 1, y: 1, width: 1, height: 1 });
		expect(locatePlaybackChrome(ref, { locate: () => null, locateElement: () => box(10, 10, 4, 4) }, (p) => ({ x: p.x - 10, y: p.y - 10 }))).toEqual({ x: 0, y: 0, width: 4, height: 4 });
	});

	it('is null when nothing finds the ref', () => {
		expect(locatePlaybackChrome(ref, undefined)).toBeNull();
		expect(locatePlaybackChrome(ref, {})).toBeNull();
		expect(locatePlaybackChrome(ref, { locateElement: () => null })).toBeNull();
	});
});
