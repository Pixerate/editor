import { describe, expect, it } from 'vitest';
import { PaintEditorController, createPaintEditorToolProvider, paintPlaybackPanel, planPaintToolPlayback, PaintDirector, PaintPresence } from '../src/paint-editor';
import { createInstantPresenceClock } from '../src/tools';

describe('paint playback', () => {
	it('opens the panel a write belongs to and points at its control', () => {
		expect(paintPlaybackPanel('set_paper')).toBe('paper');
		expect(paintPlaybackPanel('advance_wet_paint')).toBe('wet');
		expect(paintPlaybackPanel('add_layer')).toBe('layers');
		expect(paintPlaybackPanel('mix_colors')).toBe('color');
		expect(planPaintToolPlayback('mix_colors', {})).toEqual([
			{ type: 'open', ref: { kind: 'panel', id: 'color' } },
			{ type: 'target', ref: { kind: 'control', id: 'mixing-pad' } },
			{ type: 'press' },
			{ type: 'release' }
		]);
		expect(planPaintToolPlayback('set_symmetry', {})![0]).toEqual({ type: 'target', ref: { kind: 'control', id: 'symmetry' } });
		expect(planPaintToolPlayback('get_canvas_info', {})).toBeNull();
	});

	it('leaves strokes, fills and replays to the director when there is one', () => {
		const controller = new PaintEditorController();
		const director = new PaintDirector(controller, new PaintPresence(), { clock: createInstantPresenceClock(), linger: 0 });
		const directed = createPaintEditorToolProvider(controller, { director });
		expect(directed.playbackSurface).toBe('paint');
		const tools = typeof directed.tools === 'function' ? directed.tools() : directed.tools;
		expect(tools.filter((t) => t.playback === 'self').map((t) => t.name).sort()).toEqual(['fill_layer', 'paint_stroke', 'replay_strokes']);
		const plain = createPaintEditorToolProvider(controller);
		const plainTools = typeof plain.tools === 'function' ? plain.tools() : plain.tools;
		expect(plainTools.some((t) => t.playback === 'self')).toBe(false);
		expect(tools.filter((t) => !t.annotations?.readOnlyHint && t.playback !== 'self' && typeof t.plan !== 'function').map((t) => t.name)).toEqual([]);
	});
});
