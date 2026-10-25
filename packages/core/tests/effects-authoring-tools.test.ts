import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry, baseToolName } from '../src/tools';
import {
	createEffectAuthoringSession,
	createEffectAuthoringToolProvider,
	createFakeEffectProvider,
	type EffectAuthoringSession
} from '../src/effects';

describe('effect authoring agent tools', () => {
	const setup = async (options?: { withSource?: boolean; withCapture?: boolean; session?: EffectAuthoringSession | null }) => {
		const fakeProvider = createFakeEffectProvider();
		let session: any =
			options?.session !== undefined
				? options.session
				: await fakeProvider.openAuthoring!({ effectId: 'fake.invert' });

		if (session && options?.withSource) {
			session.setSource = vi.fn(async (src: string) => {
				if (src.includes('SYNTAX_ERROR')) {
					return {
						ok: true,
						issues: [{ severity: 'error' as const, message: 'Unexpected token', line: 10, column: 5 }]
					};
				}
				return { ok: true, issues: [] };
			});
		}

		const capture = options?.withCapture
			? vi.fn(async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')
			: undefined;

		const host = {
			session: () => session,
			capture
		};

		const provider = createEffectAuthoringToolProvider(host, { namespace: '' });
		const registry = new ToolRegistry();
		registry.register(provider);

		return {
			registry,
			host,
			session,
			capture,
			call: (tool: string, args: Record<string, any> = {}) => registry.callTool(tool, args)
		};
	};

	it('lists tools according to session and host capabilities', async () => {
		const full = await setup({ withSource: true, withCapture: true });
		const fullTools = full.registry.listTools().tools.map((t) => baseToolName(t.name));
		expect(fullTools).toHaveLength(15);
		expect(fullTools).toContain('effect_authoring_set_source');
		expect(fullTools).toContain('effect_authoring_view');

		const noSource = await setup({ withSource: false, withCapture: true });
		const noSourceTools = noSource.registry.listTools().tools.map((t) => baseToolName(t.name));
		expect(noSourceTools).not.toContain('effect_authoring_set_source');
		expect(noSourceTools).toContain('effect_authoring_view');
		expect(noSourceTools).toHaveLength(14);

		const noCapture = await setup({ withSource: true, withCapture: false });
		const noCaptureTools = noCapture.registry.listTools().tools.map((t) => baseToolName(t.name));
		expect(noCaptureTools).toContain('effect_authoring_set_source');
		expect(noCaptureTools).not.toContain('effect_authoring_view');
		expect(noCaptureTools).toHaveLength(14);
	});

	it('refuses all tools when no session is open', async () => {
		const { call } = await setup({ session: null, withCapture: true });

		const resDescribe = await call('effect_authoring_describe');
		expect(resDescribe.isError).toBe(true);
		expect((resDescribe.content[0] as any).text).toContain('No effect authoring session is currently open');

		const resValues = await call('effect_authoring_set_values', { values: { amount: 0.5 } });
		expect(resValues.isError).toBe(true);
		expect((resValues.content[0] as any).text).toContain('No effect authoring session is currently open');

		const resUndo = await call('effect_authoring_undo');
		expect(resUndo.isError).toBe(true);
		expect((resUndo.content[0] as any).text).toContain('No effect authoring session is currently open');
	});

	it('describes the open effect', async () => {
		const { call } = await setup({ withSource: true });
		const res = await call('effect_authoring_describe');
		expect(res.isError).toBeUndefined();

		const content = res.structuredContent as any;
		expect(content.name).toBe('Invert');
		expect(content.kind).toBe('shader');
		expect(content.controls).toBeDefined();
		expect(content.values).toMatchObject({ amount: 1 });
		expect(Array.isArray(content.presets)).toBe(true);
		expect(content.duration).toBe(1000);
		expect(content.loop).toBe(false);
		expect(content.issues).toEqual([]);
	});

	it('gets effect source code or errors when no source is available', async () => {
		const { call, session } = await setup();
		// Invert in fake provider has sourceLanguage: null
		const noSourceRes = await call('effect_authoring_get_source');
		expect(noSourceRes.isError).toBe(true);
		expect((noSourceRes.content[0] as any).text).toContain('does not use shader or script source code');

		// Now test with a session where source is present
		const stateWithSource = {
			...session.getState(),
			sourceLanguage: 'glsl' as const,
			source: 'void main() {}'
		};
		vi.spyOn(session, 'getState').mockReturnValue(stateWithSource);
		const hasSourceRes = await call('effect_authoring_get_source');
		expect(hasSourceRes.isError).toBeUndefined();
		expect(hasSourceRes.structuredContent).toEqual({
			language: 'glsl',
			source: 'void main() {}'
		});
	});

	it('sets effect source and returns compile issues', async () => {
		const { call, session } = await setup({ withSource: true });
		const okRes = await call('effect_authoring_set_source', { source: 'void main() { gl_FragColor = vec4(1.0); }' });
		expect(okRes.isError).toBeUndefined();
		expect(okRes.structuredContent).toEqual({ issues: [] });
		expect(session.setSource).toHaveBeenCalledWith('void main() { gl_FragColor = vec4(1.0); }');

		const errRes = await call('effect_authoring_set_source', { source: 'SYNTAX_ERROR' });
		expect(errRes.isError).toBeUndefined();
		expect(errRes.structuredContent).toMatchObject({
			issues: [{ severity: 'error', message: 'Unexpected token', line: 10, column: 5 }]
		});
	});

	it('sets values with all-or-nothing validation', async () => {
		const { call } = await setup();

		// Valid value
		const validRes = await call('effect_authoring_set_values', { values: { amount: 0.4 } });
		expect(validRes.isError).toBeUndefined();
		expect((validRes.structuredContent as any).values).toMatchObject({ amount: 0.4 });

		// Out of range (amount max is 1)
		const outOfRange = await call('effect_authoring_set_values', { values: { amount: 5 } });
		expect(outOfRange.isError).toBe(true);

		// Unknown control
		const unknownControl = await call('effect_authoring_set_values', { values: { nonExistent: 123 } });
		expect(unknownControl.isError).toBe(true);
	});

	it('resets values to schema defaults', async () => {
		const { call } = await setup();
		await call('effect_authoring_set_values', { values: { amount: 0.2 } });

		// Reset with specific name
		const resetSpecific = await call('effect_authoring_reset_values', { names: ['amount'] });
		expect(resetSpecific.isError).toBeUndefined();
		expect((resetSpecific.structuredContent as any).values).toMatchObject({ amount: 1 });

		// Reset all
		await call('effect_authoring_set_values', { values: { amount: 0.5 } });
		const resetAll = await call('effect_authoring_reset_values');
		expect(resetAll.isError).toBeUndefined();
		expect((resetAll.structuredContent as any).values).toMatchObject({ amount: 1 });
	});

	it('saves and applies presets', async () => {
		const { call } = await setup();
		await call('effect_authoring_set_values', { values: { amount: 0.3 } });

		const saveRes = await call('effect_authoring_save_preset', { name: 'subtle-invert' });
		expect(saveRes.isError).toBeUndefined();
		expect(saveRes.structuredContent).toMatchObject({
			name: 'subtle-invert',
			values: { amount: 0.3 }
		});

		// Reset to default
		await call('effect_authoring_reset_values');

		// Apply preset
		const applyRes = await call('effect_authoring_apply_preset', { name: 'subtle-invert' });
		expect(applyRes.isError).toBeUndefined();
		expect((applyRes.structuredContent as any).values).toMatchObject({ amount: 0.3 });

		// Unknown preset fails
		const badPreset = await call('effect_authoring_apply_preset', { name: 'missing' });
		expect(badPreset.isError).toBe(true);
	});

	it('manages keyframes on animation tracks', async () => {
		const { call } = await setup();

		// Add keyframe at 0ms
		const kf0 = await call('effect_authoring_set_keyframe', {
			control: 'amount',
			time: 0,
			value: 0
		});
		expect(kf0.isError).toBeUndefined();
		expect(kf0.structuredContent).toMatchObject({
			control: 'amount',
			keyframes: [{ time: 0, value: 0 }]
		});

		// Add keyframe at 1000ms with easing
		const kf1 = await call('effect_authoring_set_keyframe', {
			control: 'amount',
			time: 1000,
			value: 1,
			easing: 'ease-in-out'
		});
		expect(kf1.isError).toBeUndefined();
		expect((kf1.structuredContent as any).keyframes).toHaveLength(2);

		// Seeking to midpoint (500ms) interpolates
		const seekMid = await call('effect_authoring_seek', { time: 500 });
		expect(seekMid.isError).toBeUndefined();
		expect((seekMid.structuredContent as any).values.amount).toBeCloseTo(0.5, 1);

		// Remove keyframe at 0ms
		const remKf = await call('effect_authoring_remove_keyframe', {
			control: 'amount',
			time: 0
		});
		expect(remKf.isError).toBeUndefined();
		expect((remKf.structuredContent as any).keyframes).toHaveLength(1);

		// Clear track
		const clearRes = await call('effect_authoring_clear_track', { control: 'amount' });
		expect(clearRes.isError).toBeUndefined();
		expect((clearRes.structuredContent as any).control).toBe('amount');

		// Negative time rejected
		const negTime = await call('effect_authoring_set_keyframe', {
			control: 'amount',
			time: -100
		});
		expect(negTime.isError).toBe(true);

		// Unknown control rejected
		const unknownControl = await call('effect_authoring_set_keyframe', {
			control: 'nope',
			time: 100,
			value: 1
		});
		expect(unknownControl.isError).toBe(true);
	});

	it('sets timing duration and loop', async () => {
		const { call } = await setup();
		const res = await call('effect_authoring_set_timing', { duration: 2500, loop: true });
		expect(res.isError).toBeUndefined();
		expect(res.structuredContent).toEqual({ duration: 2500, loop: true });

		// Fails if neither argument provided
		const empty = await call('effect_authoring_set_timing', {});
		expect(empty.isError).toBe(true);

		// Fails with non-positive duration
		const badDur = await call('effect_authoring_set_timing', { duration: 0 });
		expect(badDur.isError).toBe(true);
	});

	it('seeks playhead and clamps within duration', async () => {
		const { call } = await setup();
		const res = await call('effect_authoring_seek', { time: 500 });
		expect(res.isError).toBeUndefined();
		expect((res.structuredContent as any).time).toBe(500);

		const clampRes = await call('effect_authoring_seek', { time: 99999 });
		expect(clampRes.isError).toBeUndefined();
		expect((clampRes.structuredContent as any).time).toBe(1000);

		// Negative time rejected
		const negRes = await call('effect_authoring_seek', { time: -10 });
		expect(negRes.isError).toBe(true);
	});

	it('undoes and redoes edits', async () => {
		const { call } = await setup();
		await call('effect_authoring_set_values', { values: { amount: 0.1 } });

		const undoRes = await call('effect_authoring_undo');
		expect(undoRes.isError).toBeUndefined();
		expect((undoRes.structuredContent as any).changed).toBe(true);

		const descAfterUndo = await call('effect_authoring_describe');
		expect((descAfterUndo.structuredContent as any).values.amount).toBe(1);

		const redoRes = await call('effect_authoring_redo');
		expect(redoRes.isError).toBeUndefined();
		expect((redoRes.structuredContent as any).changed).toBe(true);

		const descAfterRedo = await call('effect_authoring_describe');
		expect((descAfterRedo.structuredContent as any).values.amount).toBe(0.1);
	});

	it('captures preview image via effect_authoring_view', async () => {
		const { call, capture } = await setup({ withCapture: true });
		const viewRes = await call('effect_authoring_view', { time: 250 });
		expect(viewRes.isError).toBeUndefined();
		expect(capture).toHaveBeenCalled();
		expect(viewRes.content).toEqual([
			{
				type: 'image',
				data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
				mimeType: 'image/png'
			},
			{
				type: 'text',
				text: 'Captured effect preview at 250ms.'
			}
		]);
	});
});
