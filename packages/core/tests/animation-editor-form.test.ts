import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../src/tools/index.js';
import {
	formatMotionDrivers,
	parseMotionDrivers,
	AnimationEditorController,
	MOTION_COMMAND_TYPES,
	createAnimationEditorToolProvider,
	defaultMotionCommand,
	duplicateMotionCommandEdit,
	fitMotionSceneEdits,
	formatMotionNarration,
	highlightMotionSvg,
	motionCommandFields,
	motionCommandRows,
	motionCueChoices,
	motionCueFromKey,
	motionCueKey,
	motionEaseKey,
	motionEasingCurve,
	motionEasingPath,
	motionFieldEdit,
	motionNodeAtElement,
	motionRulerTicks,
	parseMotionFieldInput,
	parseMotionNarration,
	applyMotionEdits,
	fromFlairVectorEffect,
	type MotionScene
} from '../src/animation-editor/index.js';

const square = (x: number) => [{ closed: true, anchors: [{ x, y: 10 }, { x: x + 40, y: 10 }, { x: x + 40, y: 50 }, { x, y: 50 }] }];
const SCENE: MotionScene = {
	version: 1,
	name: 'demo',
	artwork: {
		width: 200,
		height: 100,
		nodes: [
			{ id: 'box', type: 'path', fill: '#ef4444', subpaths: square(10) },
			{ id: 'route', type: 'path', visible: false, fill: null, stroke: '#000', subpaths: [{ closed: false, anchors: [{ x: 0, y: 0 }, { x: 100, y: 50 }] }] }
		]
	},
	shots: [
		{
			id: 'intro',
			run: [
				{ type: 'enter', targets: ['box'], duration: 400 },
				{ type: 'pulse', targets: ['box'] },
				{ type: 'wait', duration: 100 }
			],
			hold: 0
		},
		{ id: 'away', run: [{ type: 'move', targets: ['box'], by: { x: 100, y: 0 }, duration: 400 }], hold: 0 }
	]
};

describe('animation editor form helpers', () => {
	it('builds a field list for every command type from the tool schema', () => {
		for (const type of MOTION_COMMAND_TYPES) {
			const fields = motionCommandFields(type);
			expect(fields.length, type).toBeGreaterThan(0);
			for (const f of fields) expect(f.description, `${type}.${f.name}`).not.toBe('');
		}
		const enter = motionCommandFields('enter');
		expect(enter[0]).toMatchObject({ name: 'targets', kind: 'targets', required: true, group: 'main' });
		expect(enter.find((f) => f.name === 'style')).toMatchObject({ kind: 'enum', options: expect.arrayContaining(['pop', 'wipe']) });
		expect(enter.find((f) => f.name === 'duration')).toMatchObject({ kind: 'number', unit: 'ms', min: 0, group: 'timing' });
		expect(enter.find((f) => f.name === 'ease')).toMatchObject({ kind: 'ease' });
		expect(motionCommandFields('rotate').find((f) => f.name === 'by')).toMatchObject({ unit: '°' });
		expect(motionCommandFields('follow').find((f) => f.name === 'path')).toMatchObject({ kind: 'node', required: true });
		expect(motionCommandFields('move').find((f) => f.name === 'by')).toMatchObject({ kind: 'point' });
		expect(motionCommandFields('style').find((f) => f.name === 'fill')).toMatchObject({ kind: 'color' });
		expect(motionCommandFields('fade').find((f) => f.name === 'to')).toMatchObject({ kind: 'number', unit: '0–1', min: 0, max: 1, required: true });
		expect(motionCommandFields('pulse').find((f) => f.name === 'count')).toMatchObject({ kind: 'integer', min: 1 });
		const main = enter.findIndex((f) => f.group === 'timing');
		expect(enter.slice(main).every((f) => f.group === 'timing')).toBe(true);
	});

	it('parses field input into a value, a removal or a reason', () => {
		const count = motionCommandFields('pulse').find((f) => f.name === 'count')!;
		expect(parseMotionFieldInput(count, '3')).toEqual({ set: 3 });
		expect(parseMotionFieldInput(count, '')).toEqual({ remove: true });
		expect(parseMotionFieldInput(count, '1.5')).toEqual({ error: expect.stringMatching(/whole number/) });
		expect(parseMotionFieldInput(count, '0')).toEqual({ error: expect.stringMatching(/at least 1/) });
		expect(parseMotionFieldInput(count, 'lots')).toEqual({ error: expect.stringMatching(/must be a number/) });
		const to = motionCommandFields('fade').find((f) => f.name === 'to')!;
		expect(parseMotionFieldInput(to, '')).toEqual({ error: 'To is required.' });
		expect(parseMotionFieldInput(to, '2')).toEqual({ error: expect.stringMatching(/at most 1/) });
		const by = motionCommandFields('move').find((f) => f.name === 'by')!;
		expect(parseMotionFieldInput(by, { x: '4', y: '-2' })).toEqual({ set: { x: 4, y: -2 } });
		expect(parseMotionFieldInput(by, { x: '', y: '' })).toEqual({ remove: true });
		const targets = motionCommandFields('move').find((f) => f.name === 'targets')!;
		expect(parseMotionFieldInput(targets, [])).toEqual({ error: expect.stringMatching(/at least one target/) });
		const rotate = motionCommandFields('follow').find((f) => f.name === 'rotate')!;
		expect(parseMotionFieldInput(rotate, true)).toEqual({ set: true });
		expect(parseMotionFieldInput(rotate, false)).toEqual({ remove: true });
		expect(motionFieldEdit('intro', 1, count, '4')).toEqual({ op: 'update_command', shot: 'intro', command: 1, set: { count: 4 } });
		expect(motionFieldEdit('intro', 1, count, '')).toEqual({ op: 'update_command', shot: 'intro', command: 1, remove: ['count'] });
	});

	it('makes new commands that pass the edit checks, or says what is missing', () => {
		for (const type of MOTION_COMMAND_TYPES) {
			const command = defaultMotionCommand(type, ['box'], SCENE);
			if ('error' in command) {
				expect(['effect', 'match', 'morph', 'play'], type).toContain(type);
				continue;
			}
			const result = applyMotionEdits(SCENE, { op: 'add_commands', shot: 'intro', commands: [command] });
			expect(result.ok, `${type}: ${!result.ok ? result.error : ''}`).toBe(true);
		}
		expect(defaultMotionCommand('follow', ['box'], SCENE)).toEqual({ type: 'follow', targets: ['box'], path: 'route' });
		expect(defaultMotionCommand('effect', ['box'], SCENE)).toEqual({ error: expect.stringMatching(/live path effect/) });
		expect(defaultMotionCommand('move', [], SCENE)).toEqual({ error: expect.stringMatching(/Pick a target/) });
	});

	it('lists a shot\'s commands with timing and Flair primitives, and duplicates them', () => {
		const rows = motionCommandRows(SCENE, 'intro');
		expect(rows.map((r) => [r.summary, r.flairPrimitive, r.start, r.end])).toEqual([
			['enter · box', 'entrance.fade', 0, 400],
			['pulse · box', 'emphasis.pulse', 400, 1000],
			['wait 100 ms', undefined, 1000, 1100]
		]);
		expect(motionCommandRows(SCENE, 'nope')).toEqual([]);
		const dup = applyMotionEdits(SCENE, duplicateMotionCommandEdit(SCENE, 'intro', 1));
		expect(dup.ok && dup.scene.shots[0].run.map((c) => c.type)).toEqual(['enter', 'pulse', 'pulse', 'wait']);
	});

	it('samples easings for a preview, springs until they settle', () => {
		const out = motionEasingCurve('ease-out-back', 20);
		expect(out.points).toHaveLength(21);
		expect(out.max).toBeGreaterThan(1);
		expect(out.points[20]).toEqual({ u: 1, v: 1 });
		const spring = motionEasingCurve('spring-bouncy');
		expect(spring.durationMs).toBeGreaterThan(300);
		expect(spring.max).toBeGreaterThan(1);
		expect(motionEasingCurve('hold').points.slice(0, -1).every((p) => p.v === 0)).toBe(true);
		expect(motionEasingPath(motionEasingCurve('linear', 2), 10, 10, 0)).toBe('M0 10 L5 5 L10 0');
		expect([motionEaseKey(undefined), motionEaseKey('spring-quick'), motionEaseKey({ type: 'spring' })]).toEqual(['', 'spring-quick', 'custom']);
	});

	it('finds the node a click landed on and marks picked nodes', () => {
		const el = (id: string | null, parent: any = null) => ({ getAttribute: (n: string) => (n === 'id' ? id : null), parentElement: parent });
		const root = el(null);
		const group = el('box', root);
		const inner = el('box--reveal', group);
		expect(motionNodeAtElement(SCENE, inner, root)).toBe('box');
		expect(motionNodeAtElement(SCENE, el('ae-ghost0-box', root), root)).toBe(null);
		const svg = highlightMotionSvg('<svg viewBox="0 0 1 1"><path id="box"/><path id="boxy"/></svg>', ['box']);
		expect(svg).toContain('<path id="box" data-picked=""/>');
		expect(svg).toContain('<path id="boxy"/>');
		expect(svg).toMatch(/<style>\[data-picked\]/);
	});

	it('ticks a ruler, fits to a length and picks cues', () => {
		const ticks = motionRulerTicks(2000, 400);
		expect(ticks.filter((t) => t.major).map((t) => t.label)).toEqual(['0.0s', '0.5s', '1.0s', '1.5s', '2.0s']);
		const edits = fitMotionSceneEdits(SCENE, 3000);
		expect(edits.every((e) => e.op === 'update_shot')).toBe(true);
		const fitted = applyMotionEdits(SCENE, edits);
		expect(fitted.ok).toBe(true);
		expect(() => fitMotionSceneEdits(SCENE, -1)).toThrow(/milliseconds/);
		const cued: MotionScene = { ...SCENE, beat: { bpm: 120 }, narration: { words: [{ text: 'hi', start: 300 }] } };
		const choices = motionCueChoices(cued);
		expect(choices[0]).toEqual({ value: 'beat:0', label: 'Beat 0 (bar 1.1) · 0.00 s', time: 0 });
		expect(choices.at(-1)).toEqual({ value: 'word:0', label: 'Word 0 “hi” · 0.30 s', time: 300 });
		expect(motionCueFromKey('beat:2.5')).toEqual({ beat: 2.5 });
		expect(motionCueFromKey('')).toBeUndefined();
		expect(motionCueKey({ word: 3 })).toBe('word:3');
	});

	it('reads and writes narration a word a line', () => {
		expect(parseMotionNarration('0 Meet\n320 the badge')).toEqual({ narration: { words: [{ text: 'Meet', start: 0 }, { text: 'the badge', start: 320 }] } });
		expect(parseMotionNarration('  ')).toEqual({ narration: null });
		expect(parseMotionNarration('hello')).toEqual({ error: expect.stringMatching(/Line 1/) });
		expect(parseMotionNarration('500 a\n100 b')).toEqual({ error: expect.stringMatching(/time order/) });
		expect(formatMotionNarration({ words: [{ text: 'a', start: 5 }] })).toBe('5 a');
	});
});

describe('move_command', () => {
	it('moves a command within its shot as one undo step', async () => {
		const controller = new AnimationEditorController({ scene: SCENE });
		const registry = new ToolRegistry();
		registry.register(createAnimationEditorToolProvider(controller));
		const done = await registry.callTool('move_command', { shot: 'intro', command: 2, to: 0 });
		expect(done.isError).toBeFalsy();
		expect(done.structuredContent).toMatchObject({ shot: 'intro', command: 0, from: 2 });
		expect(controller.getState().scene.shots[0].run.map((c) => c.type)).toEqual(['wait', 'enter', 'pulse']);
		controller.undo();
		expect(controller.getState().scene.shots[0].run.map((c) => c.type)).toEqual(['enter', 'pulse', 'wait']);
		const bad = await registry.callTool('move_command', { shot: 'intro', command: 5, to: 0 });
		expect(bad.isError).toBe(true);
		expect(JSON.stringify(bad.content)).toMatch(/has 3 commands/);
		const far = await registry.callTool('move_command', { shot: 'intro', command: 0, to: 3 });
		expect(JSON.stringify(far.content)).toMatch(/from 0 to 2/);
		const unknown = await registry.callTool('move_command', { shot: 'outro', command: 0, to: 1 });
		expect(JSON.stringify(unknown.content)).toMatch(/There is no shot.*outro/);
		const extra = await registry.callTool('move_command', { shot: 'intro', command: 0, to: 1, at: 2 });
		expect(extra.isError).toBe(true);
		controller.destroy();
	});
});

describe('Flair catalog presets', () => {
	it('reads preset colours written as [r, g, b] channels as hex', () => {
		const svg = '<svg viewBox="0 0 10 10"><rect id="dot" width="4" height="4" fill="{{accent: color default=#0EA5E9 label=\'Accent\'}}"/></svg>';
		const { scene } = fromFlairVectorEffect({
			kind: 'vector',
			id: 'dot',
			name: 'Dot',
			description: '',
			category: 'icon',
			tags: [],
			presets: [
				{ name: 'Green', values: { accent: [0.13, 0.7, 0.4], other: [1, 1, 1] } },
				{ name: 'Rose', values: { accent: '#F43F5E' } }
			],
			motion: { svg, animate: [{ id: 'dot', ms: 300, attrs: { opacity: [0, 1] } }] }
		});
		expect(scene.presets).toEqual([
			{ name: 'Green', values: { accent: '#21b366' } },
			{ name: 'Rose', values: { accent: '#f43f5e' } }
		]);
	});
});

describe('driver text', () => {
	it('reads and writes drivers one a line', () => {
		const text = 'dot.x <- box.x * 0.5\nline.opacity <- box.x * -0.01 + 0.2 [-0.8, 0]\nwheel.rotation <- wheel.x';
		const parsed = parseMotionDrivers(text);
		expect(parsed).toEqual({ drivers: [
			{ target: 'dot', property: 'x', source: { node: 'box', property: 'x' }, factor: 0.5 },
			{ target: 'line', property: 'opacity', source: { node: 'box', property: 'x' }, factor: -0.01, offset: 0.2, clamp: [-0.8, 0] },
			{ target: 'wheel', property: 'rotation', source: { node: 'wheel', property: 'x' } }
		] });
		expect(formatMotionDrivers('drivers' in parsed ? parsed.drivers : [])).toBe(text);
		expect(parseMotionDrivers('')).toEqual({ drivers: [] });
		expect(parseMotionDrivers('dot.x follows box')).toEqual({ error: expect.stringMatching(/should read "target.property <- source.property"/) });
		expect(parseMotionDrivers('dot.skew <- box.x')).toEqual({ error: expect.stringMatching(/"skew" is not a property/) });
	});
});
