import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AnimationEditorController, createAnimationEditorToolProvider, createMotionScene, motionContactSheetSvg, motionFrameToSvg, type MotionScene } from '../src/animation-editor';
import { ToolRegistry } from '../src/tools';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 160"><rect id="card" x="20" y="20" width="120" height="80" fill="#e2e8f0"/><circle id="dot" cx="60" cy="60" r="12" fill="#f43f5e"/><path id="tick" d="M50 60 L58 68 L72 52" fill="none" stroke="#0f172a" stroke-width="4"/><path id="route" d="M60 60 C120 0 200 120 280 60" fill="none" stroke="none"/></svg>';

const tools = () => {
	const controller = new AnimationEditorController({ scene: createMotionScene({ width: 320, height: 160, nodes: [] }, { name: 'task' }) });
	const registry = new ToolRegistry();
	registry.register(createAnimationEditorToolProvider(controller));
	const call = async (name: string, args: Record<string, unknown>) => {
		const r = await registry.callTool(name, args);
		if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`);
		return r.structuredContent as any;
	};
	return { controller, registry, call };
};

// Tasks an agent would be given, done only through the tools, checked only through the tools.
describe('agent tasks, through the tools only', () => {
	it('builds a logo reveal from SVG: enter, draw, follow, check, export', async () => {
		const { call } = tools();
		const art = await call('set_animation_artwork_svg', { svg: SVG });
		expect(art.elements.map((e: { id: string }) => e.id)).toEqual(expect.arrayContaining(['card', 'dot', 'tick', 'route']));
		await call('set_animation_settings', { name: 'logo-reveal', target: [2, 5] });
		const batch = await call('edit_animation', {
			ops: [
				{ op: 'insert_shots', shots: [{ id: 'in', run: [{ type: 'enter', targets: ['card'], style: 'rise' }] }] },
				{ op: 'add_commands', shot: '$0.shots[0]', commands: [{ type: 'enter', targets: ['dot'], style: 'pop' }, { type: 'draw', targets: ['tick'] }] },
				// Edit the command op 2 added first, by reference.
				{ op: 'update_command', shot: '$last.shot', command: '$1.indexes[0]', set: { with: 'previous', delay: 150 } },
				{ op: 'insert_shots', shots: [{ id: 'fly', run: [{ type: 'follow', targets: ['dot'], path: 'route', rotate: true }] }] }
			]
		});
		expect(batch.outcomes).toEqual([{ op: 'insert_shots', shots: ['in'] }, { op: 'add_commands', shot: 'in', indexes: [1, 2] }, { op: 'update_command', shot: 'in' }, { op: 'insert_shots', shots: ['fly'] }]);
		const read = await call('get_animation', {});
		expect(read.shots[0].commands[1]).toMatchObject({ type: 'enter', with: 'previous', delay: 150 });
		const check = await call('check_animation', {});
		expect(check.errors).toBe(0);
		const sheet = await call('render_animation_frame', { times: [0, 400, 900, 1800], columns: 2 });
		expect(sheet.svg).toMatch(/^<svg[^>]*viewBox="0 0 \d+ \d+"/);
		expect(sheet.svg.match(/<svg x=/g)).toHaveLength(4);
		expect(sheet.svg).toContain('0.90 s · in');
		const flair = await call('export_flair_effect', { category: 'icon' });
		expect(flair).toMatchObject({ kind: 'vector', id: 'logo-reveal' });
		const lottie = await call('export_lottie', {});
		expect(lottie.lottie.markers.map((m: { cm: string }) => m.cm)).toEqual(['in', 'fly']);
	});

	it('refuses a batch with a bad reference, changing nothing', async () => {
		const { call, registry, controller } = tools();
		await call('set_animation_artwork_svg', { svg: SVG });
		const before = controller.getScene();
		const bad = await registry.callTool('edit_animation', { ops: [{ op: 'insert_shots', shots: [{ id: 'a', run: [] }] }, { op: 'delete_commands', shot: 'a', commands: ['$0.indexes[0]'] }] });
		expect(bad.isError).toBe(true);
		expect(JSON.stringify(bad.content)).toMatch(/op 2 \(delete_commands\): \\"\$0.indexes\[0\]\\" has no value; op 1 made/);
		const ahead = await registry.callTool('edit_animation', { ops: [{ op: 'update_shot', shot: '$1.shot', set: { hold: 0 } }, { op: 'insert_shots', shots: [{ id: 'b', run: [] }] }] });
		expect(JSON.stringify(ahead.content)).toMatch(/only ops before this one/);
		expect(controller.getScene()).toBe(before);
	});

	it('reuses motion: a clip played on several elements, copied, then fitted to a length', async () => {
		const { call } = tools();
		await call('set_animation_artwork_svg', { svg: SVG });
		await call('set_animation_clip', { name: 'nudge', clip: { run: [{ type: 'move', targets: ['$'], by: { x: 10, y: 0 }, duration: 200 }, { type: 'move', targets: ['$'], by: { x: -10, y: 0 }, duration: 200 }] } });
		await call('insert_shots', { shots: [{ id: 'one', run: [{ type: 'play', targets: ['card', 'dot'], clip: 'nudge', stagger: 100 }] }] });
		await call('copy_animation', { from: 'dot', to: ['tick'] });
		const fit = await call('fit_animation', { seconds: 2 });
		expect(fit.duration).toBeCloseTo(2000, -1);
	});
});

// Golden fingerprints of frames (as the chart goldens, after filmcraft's golden tests): any change to
// how a scene draws shows up here. Regenerate with `vitest -u` after checking the change is wanted.
describe('golden frames', () => {
	const SCENE: MotionScene = {
		version: 1,
		name: 'golden',
		artwork: { width: 200, height: 100, background: '#ffffff', nodes: [{ id: 'box', type: 'path', fill: '#ef4444', stroke: '#111111', strokeWidth: 2, subpaths: [{ closed: true, anchors: [{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }] }] }] },
		shots: [
			{ id: 'a', run: [{ type: 'enter', targets: ['box'], style: 'pop' }, { type: 'draw', targets: ['box'], with: 'previous' }] },
			{ id: 'b', camera: { x: 0, y: 0, width: 100, height: 50 }, run: [{ type: 'move', targets: ['box'], via: [{ x: 100, y: 20 }], to: { x: 160, y: 60 } }, { type: 'wiggle', targets: ['box'], seed: 7, with: 'previous' }, { type: 'color-pulse', targets: ['box'], color: '#22c55e' }] }
		]
	};
	const TIMES = [0, 150, 300, 600, 900, 1400, 1900, 2600];
	const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

	it('draws the same frames as when they were blessed', async () => {
		const now = Object.fromEntries(TIMES.map((t) => [String(t), hash(motionFrameToSvg(SCENE, t, { pretty: false }))]));
		now.sheet = hash(motionContactSheetSvg(SCENE, [0, 600, 1400], { pretty: false }));
		await expect(`${JSON.stringify(now, null, 2)}\n`).toMatchFileSnapshot('./__goldens__/animation-frames.json');
	});
});
