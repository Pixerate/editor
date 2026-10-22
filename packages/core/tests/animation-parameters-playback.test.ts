import { describe, expect, it } from 'vitest';
import { PresenceStore, ToolRegistry, createAgentPlayback, createInstantPresenceClock, type PlaybackRef } from '../src/tools';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { AnimationEditorController, createAnimationEditorToolProvider, createMotionScene, planAnimationToolPlayback } from '../src/animation-editor';
import { ParametersController, createParameterCommands, planParameterSetPlayback } from '../src/parameters';

const surface = (rects: Record<string, { x: number; y: number }>) => ({
	presence: new PresenceStore(),
	locate: (ref: PlaybackRef) => {
		const at = rects[`${ref.kind}:${ref.id}`];
		return at ? { ...at, width: 20, height: 10 } : null;
	},
	bounds: () => ({ x: 0, y: 0, width: 500, height: 300 })
});

describe('planAnimationToolPlayback', () => {
	it('clicks the shot, then visits the elements its commands animate', () => {
		expect(planAnimationToolPlayback('add_commands', { shot: 'finale', commands: [{ type: 'teeter', targets: ['check'] }, { type: 'pulse', targets: ['badge', 'check'] }] })).toEqual([
			{ type: 'target', ref: { kind: 'shot', id: 'finale' } },
			{ type: 'press' },
			{ type: 'release' },
			{ type: 'target', ref: { kind: 'element', id: 'check' } },
			{ type: 'target', ref: { kind: 'element', id: 'badge' } }
		]);
		expect(planAnimationToolPlayback('insert_shots', { shots: [{ id: 'a', run: [{ type: 'fade', targets: ['ring'] }] }] })).toEqual([{ type: 'target', ref: { kind: 'element', id: 'ring' } }]);
		expect(planAnimationToolPlayback('get_animation', {})).toBeNull();
	});

	it('plays an animation tool call on the animation surface', async () => {
		const controller = new AnimationEditorController({ scene: createMotionScene({ width: 320, height: 160, nodes: [] }, { name: 'task' }) });
		const registry = new ToolRegistry();
		const provider = createAnimationEditorToolProvider(controller);
		expect(provider.playbackSurface).toBe('animation');
		registry.register(provider);
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		playback.install(registry);
		const added = await registry.callTool('animation__insert_shots', { shots: [{ id: 'intro', run: [] }] });
		expect(added.isError).toBeFalsy();
		const shot = 'intro';
		const s = surface({ [`shot:${shot}`]: { x: 100, y: 200 } });
		playback.attach('animation', s);
		const steps = playback.record();
		const res = await registry.callTool('animation__update_shot', { shot, set: { label: 'Opening' } });
		expect(res.isError).toBeFalsy();
		expect(steps.map((r) => r.step.type)).toEqual(['target', 'press', 'release', 'commit']);
		expect(s.presence.get('agent')).toMatchObject({ x: 110, y: 205 });
	});
});

describe('parameters playback', () => {
	it('visits each control parameters.set changes and types its value', () => {
		expect(planParameterSetPlayback({ shape: 'rings', count: 12 })).toEqual([
			{ type: 'target', ref: { kind: 'parameter', id: 'shape' } },
			{ type: 'press' },
			{ type: 'release' },
			{ type: 'type', text: 'rings' },
			{ type: 'target', ref: { kind: 'parameter', id: 'count' } },
			{ type: 'press' },
			{ type: 'release' },
			{ type: 'type', text: '12' }
		]);
		expect(planParameterSetPlayback(null)).toBeNull();
	});

	it('plays parameters.set on the parameters surface and keeps the live schema', async () => {
		const params = new ParametersController({ schema: { fields: [{ id: 'speed', type: 'number', min: 0, max: 4, default: 1 }] } });
		const specs = createParameterCommands(params);
		expect(specs.every((sp) => sp.playbackSurface === 'parameters')).toBe(true);
		const set = specs.find((sp) => sp.id === 'parameters.set')!;
		// Its params are still a getter that follows the schema.
		expect(Object.getOwnPropertyDescriptor(set, 'params')?.get).toBeTypeOf('function');
		const commands = new CommandRegistry();
		commands.register(specs);
		const registry = new ToolRegistry();
		registry.register(createCommandToolProvider(commands, { id: 'commands' }));
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		playback.install(registry);
		playback.attach('parameters', surface({ 'parameter:speed': { x: 10, y: 40 } }));
		const steps = playback.record();
		const res = await registry.callTool('commands__run_command', { id: 'parameters.set', params: { values: { speed: 2.5 } } });
		expect(res.isError).toBeFalsy();
		expect(params.getState().values.speed).toBe(2.5);
		expect(steps.map((r) => r.step.type)).toEqual(['target', 'press', 'release', 'type', 'commit']);
	});
});
