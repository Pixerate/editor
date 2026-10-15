import { describe, it, expect, vi } from 'vitest';
import { HistoryManager } from '../src/history';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/agent';
import {
	ParametersController,
	ParameterSchemaError,
	checkParameterSchema,
	clampParameterNumber,
	coerceParameterValue,
	createParameterCommands,
	createParameterKeyframeStore,
	evaluateParameterCondition,
	formatParameterNumber,
	formatParameterValue,
	parseParameterNumberInput,
	getParameterDefaults,
	getParameterFields,
	getParameterVisibility,
	hexToRgba01,
	humanizeParameterId,
	normalizeHexColor,
	parameterSchemaFromShaderControls,
	parameterSchemaToJsonSchema,
	parameterStep,
	parameterValueFromShaderControl,
	rgba01ToHex,
	seededRandom,
	shaderControlValue,
	validateParameterValue,
	withParameterKeyframe,
	type ParameterSchema,
	type ShaderControlLike
} from '../src/parameters';

const schema: ParameterSchema = {
	title: 'Glow',
	fields: [
		{ id: 'speed', type: 'number', label: 'Speed', min: 0, max: 4, step: 0.1, default: 1, unit: 'x' },
		{ id: 'steps', type: 'int', min: 1, max: 64, default: 16 },
		{ id: 'grain', type: 'boolean', label: 'Film grain', default: true },
		{ id: 'mode', type: 'choice', options: ['soft', 'hard', { value: 'advanced', label: 'Advanced…' }], default: 'soft' },
		{
			type: 'group',
			id: 'look',
			label: 'Look',
			fields: [
				{ id: 'tint', type: 'color', default: '#77C16A' },
				{ id: 'glow', type: 'color', alpha: true, default: '#ffffff80' },
				{ id: 'center', type: 'vector', size: 2, min: -1, max: 1, default: [0, 0] }
			]
		},
		{
			type: 'group',
			id: 'advanced',
			collapsed: true,
			showIf: { mode: 'advanced' },
			fields: [
				{ id: 'threshold', type: 'number', min: 0, max: 1, default: 0.5, showIf: { steps: { gte: 8 } } },
				{ id: 'photo', type: 'image', default: '' },
				{ id: 'caption', type: 'text', default: 'hi', maxLength: 8, pattern: '[a-z ]*' }
			]
		}
	],
	presets: [{ name: 'Punchy', values: { speed: 3, mode: 'hard' } }]
};

describe('parameter schema helpers', () => {
	it('flattens fields, reads defaults and humanises ids', () => {
		expect(getParameterFields(schema).map((f) => f.id)).toEqual(['speed', 'steps', 'grain', 'mode', 'tint', 'glow', 'center', 'threshold', 'photo', 'caption']);
		expect(getParameterDefaults(schema)).toMatchObject({ speed: 1, center: [0, 0], tint: '#77c16a' });
		expect(humanizeParameterId('uFlowSpeed')).toBe('Flow speed');
		expect(humanizeParameterId('flow_speed')).toBe('Flow speed');
	});

	it('reports structural problems as sentences', () => {
		expect(checkParameterSchema(schema)).toEqual([]);
		const problems = checkParameterSchema({
			fields: [
				{ id: 'a', type: 'number', default: 5, max: 1 },
				{ id: 'a', type: 'boolean', default: true },
				{ id: 'c', type: 'choice', options: [], default: 'x' },
				{ id: 'v', type: 'vector', size: 5 as any, default: [0, 0, 0, 0, 0] }
			]
		});
		expect(problems).toEqual([
			'Field "a" has an invalid default: A must be at most 1.',
			'The id "a" is used twice.',
			'Field "c" needs at least one option.',
			'Field "v" must have 2 to 4 components.'
		]);
		expect(() => new ParametersController({ schema: { fields: [{ id: 'x', type: 'bogus' as any, default: 0 }] } })).toThrow(ParameterSchemaError);
	});

	it('validates values with sentences naming the field', () => {
		const [speed, steps, grain, mode, tint, glow, center, , photo, caption] = getParameterFields(schema);
		expect(validateParameterValue(speed, 5)?.message).toBe('Speed must be at most 4.');
		expect(validateParameterValue(speed, 'fast')?.message).toBe('Speed must be a number, not "fast".');
		expect(validateParameterValue(steps, 2.5)?.message).toBe('Steps must be a whole number.');
		expect(validateParameterValue(grain, 1)?.message).toBe('Film grain must be true or false.');
		expect(validateParameterValue(mode, 'loud')?.message).toBe('Mode must be one of "soft", "hard", "advanced", not "loud".');
		expect(validateParameterValue(tint, 'red')?.message).toBe('Tint must be a hex colour like "#77c16a".');
		expect(validateParameterValue(glow, '#fff')).toBeNull();
		expect(validateParameterValue(center, [0])?.message).toBe('Center must be a list of 2 numbers.');
		expect(validateParameterValue(center, [0, 2])).toEqual({ id: 'center', path: '/center/1', message: 'Center y must be at most 1.' });
		expect(validateParameterValue(photo, 3)?.message).toBe('Photo must be an image URL (or "" for none).');
		expect(validateParameterValue(caption, 'Hello')?.message).toBe('Caption must match the pattern [a-z ]*.');
		expect(validateParameterValue(caption, 'way too long')?.message).toBe('Caption must be at most 8 characters.');
	});

	it('coerces narrowly: ints round, colours normalise', () => {
		const [, steps, , , tint, glow] = getParameterFields(schema);
		expect(coerceParameterValue(steps, 2.6)).toEqual({ ok: true, value: 3 });
		expect(coerceParameterValue(tint, '#ABC')).toEqual({ ok: true, value: '#aabbcc' });
		expect(coerceParameterValue(glow, '#abc')).toEqual({ ok: true, value: '#aabbccff' });
		expect(coerceParameterValue(tint, '12').ok).toBe(false);
	});

	it('evaluates showIf conditions, including enclosing groups', () => {
		const values = getParameterDefaults(schema);
		expect(getParameterVisibility(schema, values)).toMatchObject({ advanced: false, threshold: false, tint: true });
		expect(getParameterVisibility(schema, { ...values, mode: 'advanced' })).toMatchObject({ advanced: true, threshold: true });
		expect(getParameterVisibility(schema, { ...values, mode: 'advanced', steps: 4 })).toMatchObject({ threshold: false, photo: true });
		expect(evaluateParameterCondition({ mode: ['soft', 'hard'] }, values)).toBe(true);
		expect(evaluateParameterCondition({ speed: { gt: 1 } }, values)).toBe(false);
		expect(evaluateParameterCondition({ grain: { truthy: true }, mode: { ne: 'hard' } }, values)).toBe(true);
		expect(evaluateParameterCondition((v) => v.speed === 1, values)).toBe(true);
	});

	it('formats, steps and clamps numbers', () => {
		const speed = getParameterFields(schema)[0] as any;
		expect(parameterStep(speed)).toBe(0.1);
		expect(formatParameterNumber(speed, 1.25)).toBe('1.3x');
		expect(formatParameterNumber(speed, 2)).toBe('2x');
		expect(parameterStep({ id: 'o', type: 'number', min: 0, max: 1, default: 0 })).toBe(0.01);
		expect(clampParameterNumber(speed, 9)).toBe(4);
		expect(clampParameterNumber({ id: 'i', type: 'int', default: 0 }, 2.4)).toBe(2);
		expect(parseParameterNumberInput(speed, ' 2.5x ')).toBe(2.5);
		expect(parseParameterNumberInput(speed, '1,5')).toBe(1.5);
		expect(parseParameterNumberInput(speed, '99')).toBe(4);
		expect(parseParameterNumberInput(speed, 'abc')).toBeNull();
		const fields = getParameterFields(schema);
		expect(formatParameterValue(fields[2], false)).toBe('Off');
		expect(formatParameterValue(fields[3], 'advanced')).toBe('Advanced…');
		expect(formatParameterValue(fields[6], [0.5, -1])).toBe('0.5, -1');
	});

	it('converts colours between hex and 0–1 components', () => {
		expect(normalizeHexColor('#77C16A')).toBe('#77c16a');
		expect(normalizeHexColor('77c16a80', true)).toBe('#77c16a80');
		expect(normalizeHexColor('#77c16a80')).toBe('#77c16a');
		expect(hexToRgba01('#ff0000')).toEqual([1, 0, 0]);
		expect(hexToRgba01('#ff000080', true)?.[3]).toBeCloseTo(0.502, 3);
		expect(rgba01ToHex([1, 0.5, 0])).toBe('#ff8000');
		expect(rgba01ToHex([1, 0, 0, 0], true)).toBe('#ff000000');
	});

	it('builds the JSON Schema agents see', () => {
		const json = parameterSchemaToJsonSchema(schema);
		expect(json.additionalProperties).toBe(false);
		expect(json.properties!.speed).toMatchObject({ type: 'number', minimum: 0, maximum: 4, description: 'Speed (x)' });
		expect(json.properties!.steps).toMatchObject({ type: 'integer' });
		expect(json.properties!.mode).toMatchObject({ enum: ['soft', 'hard', 'advanced'] });
		expect(json.properties!.center).toMatchObject({ type: 'array', minItems: 2, maxItems: 2, items: { minimum: -1, maximum: 1 } });
	});
});

describe('ParametersController', () => {
	it('keeps getState stable between changes and notifies subscribers', () => {
		const c = new ParametersController({ schema });
		const a = c.getState();
		expect(c.getState()).toBe(a);
		const listener = vi.fn();
		c.subscribe(listener);
		expect(c.setValue('speed', 2)).toEqual({ ok: true, value: 2 });
		const b = c.getState();
		expect(b).not.toBe(a);
		expect(b.values.speed).toBe(2);
		expect(c.getState()).toBe(b);
		expect(listener).toHaveBeenCalled();
		expect(b.canUndo).toBe(true);
		expect(b.undoLabel).toBe('Change Speed');
		expect(b.modified).toBe(true);
		// Setting the same value is not a change.
		listener.mockClear();
		c.setValue('speed', 2);
		expect(listener).not.toHaveBeenCalled();
	});

	it('rejects invalid values without storing them and reports them in errors', () => {
		const onChange = vi.fn();
		const c = new ParametersController({ schema, onChange });
		const result = c.setValue('speed', 10);
		expect(result).toMatchObject({ ok: false, message: 'Speed must be at most 4.' });
		expect(c.getValue('speed')).toBe(1);
		expect(c.getState().errors.speed).toBe('Speed must be at most 4.');
		expect(onChange).not.toHaveBeenCalled();
		c.setValue('speed', 3);
		expect(c.getState().errors.speed).toBeUndefined();
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ speed: 3 }), ['speed']);
		expect(c.setValue('nope', 1)).toMatchObject({ ok: false });
		expect((c.setValue('nope', 1) as any).message).toMatch(/^There is no parameter "nope"; expected one of "speed", "steps"/);
	});

	it('uses defaults for invalid starting values and reports them', () => {
		const c = new ParametersController({ schema, values: { speed: 99, steps: 3, tint: '#ABCDEF' } });
		expect(c.getValues()).toMatchObject({ speed: 1, steps: 3, tint: '#abcdef' });
		expect(c.getState().errors).toEqual({ speed: 'Speed must be at most 4.' });
	});

	it('sets several values all-or-nothing as one undo step', () => {
		const c = new ParametersController({ schema });
		const bad = c.setValues({ speed: 2, steps: 1000 });
		expect(bad).toMatchObject({ ok: false, message: 'Steps must be at most 64.' });
		expect(c.getValue('speed')).toBe(1);
		const good = c.setValues({ speed: 2, steps: 8, grain: true });
		expect(good).toEqual({ ok: true, values: { speed: 2, steps: 8, grain: true }, changed: ['speed', 'steps'] });
		expect(c.history.getState().undoCount).toBe(1);
		c.undo();
		expect(c.getValues()).toMatchObject({ speed: 1, steps: 16 });
		c.redo();
		expect(c.getValues()).toMatchObject({ speed: 2, steps: 8 });
	});

	it('merges a slider drag into one undo step', () => {
		const c = new ParametersController({ schema });
		c.beginGesture('speed');
		expect(c.getState().gesture).toBe('speed');
		for (const v of [1.2, 1.5, 2, 2.5]) c.setValue('speed', v);
		c.endGesture();
		c.beginGesture('speed');
		c.setValue('speed', 3);
		c.endGesture();
		expect(c.history.getState().undoCount).toBe(2);
		c.undo();
		expect(c.getValue('speed')).toBe(2.5);
		c.undo();
		expect(c.getValue('speed')).toBe(1);
		c.redo();
		expect(c.getValue('speed')).toBe(2.5);
	});

	it('records into a shared history', () => {
		const history = new HistoryManager();
		const c = new ParametersController({ schema, history });
		c.setValue('grain', false);
		expect(history.getState().undoName).toBe('Change Film grain');
		history.undo();
		expect(c.getValue('grain')).toBe(true);
		expect(c.getState().canRedo).toBe(true);
	});

	it('resets and randomizes as single steps', () => {
		const c = new ParametersController({ schema });
		c.setValues({ speed: 3, steps: 2, tint: '#000000' });
		c.reset(['speed']);
		expect(c.getValue('speed')).toBe(1);
		expect(c.getState().undoLabel).toBe('Reset Speed');
		c.reset();
		expect(c.getState().modified).toBe(false);
		expect(c.reset(['nope'])).toMatchObject({ ok: false });

		const r1 = c.randomize({ seed: 7 });
		const values1 = { ...c.getValues() };
		expect(r1.ok).toBe(true);
		// Hidden fields (the advanced group) and image/text fields are left alone.
		expect(values1.threshold).toBe(0.5);
		expect(values1.caption).toBe('hi');
		for (const id of ['speed', 'steps', 'center'] as const) expect(c.getState().errors[id]).toBeUndefined();
		expect((values1.speed as number) % 0.1).toBeLessThan(1e-6 + 0.1);
		expect(values1.steps).toSatisfy((n: number) => Number.isInteger(n) && n >= 1 && n <= 64);
		expect(values1.glow).toMatch(/^#[0-9a-f]{6}80$/);
		c.undo();
		c.randomize({ seed: 7 });
		expect(c.getValues()).toEqual(values1);
		expect(seededRandom(1)()).toBe(seededRandom(1)());
	});

	it('applies, saves and deletes presets', () => {
		const c = new ParametersController({ schema });
		expect(c.getState().activePreset).toBeNull();
		c.setValue('steps', 4);
		c.applyPreset('Punchy');
		// Fields the preset leaves out return to their defaults.
		expect(c.getValues()).toMatchObject({ speed: 3, mode: 'hard', steps: 16 });
		expect(c.getState().activePreset).toBe('Punchy');
		c.setValue('steps', 4);
		c.applyPreset('Punchy', { merge: true });
		expect(c.getValue('steps')).toBe(4);

		expect(c.savePreset('Punchy')).toEqual({ ok: false, message: '"Punchy" is a built-in preset; save under another name.' });
		expect(c.savePreset('  ')).toEqual({ ok: false, message: 'A preset needs a name.' });
		expect(c.savePreset('Mine')).toEqual({ ok: true });
		expect(c.getState().presets.map((p) => [p.name, !!p.builtIn])).toEqual([
			['Punchy', true],
			['Mine', false]
		]);
		expect(c.getState().activePreset).toBe('Mine');
		c.reset();
		c.applyPreset('Mine');
		expect(c.getValue('steps')).toBe(4);
		expect(c.deletePreset('Punchy')).toMatchObject({ ok: false });
		expect(c.deletePreset('Mine')).toEqual({ ok: true });
		expect(c.getState().presets).toHaveLength(1);
		c.undo();
		expect(c.getState().presets).toHaveLength(2);
		expect(c.applyPreset('Nope')).toEqual({ ok: false, message: 'There is no preset "Nope"; expected one of "Punchy", "Mine".' });
	});

	it('keeps fitting values when the schema changes', () => {
		const c = new ParametersController({ schema });
		c.setValues({ speed: 3, steps: 50 });
		c.setSchema({
			fields: [
				{ id: 'speed', type: 'number', min: 0, max: 10, default: 1 },
				{ id: 'steps', type: 'int', min: 1, max: 32, default: 16 },
				{ id: 'fresh', type: 'boolean', default: false }
			]
		});
		expect(c.getValues()).toEqual({ speed: 3, steps: 16, fresh: false });
	});

	it('serialises values and user presets and loads them back', () => {
		const c = new ParametersController({ schema });
		c.setValue('speed', 2);
		c.savePreset('Two');
		const json = c.toJSON();
		expect(json.presets).toHaveLength(1);
		const d = new ParametersController({ schema });
		d.load(json);
		expect(d.getValue('speed')).toBe(2);
		expect(d.getState().presets.map((p) => p.name)).toEqual(['Punchy', 'Two']);
		expect(d.getState().canUndo).toBe(false);
	});

	it('tracks collapsed groups as view state', () => {
		const c = new ParametersController({ schema });
		expect(c.getState().collapsed).toEqual({ advanced: true });
		c.toggleCollapsed('look');
		expect(c.getState().collapsed).toEqual({ advanced: true, look: true });
		expect(c.getState().canUndo).toBe(false);
	});
});

describe('parameter keyframes', () => {
	it('reports key state, toggles keys undoably and updates keys under the playhead', () => {
		const keyframes = createParameterKeyframeStore();
		const c = new ParametersController({ schema, keyframes });
		expect(c.getState().keys.speed).toBe('none');
		expect(c.toggleKeyframe('speed')).toEqual({ ok: true, keyed: true });
		expect(keyframes.getTrack('speed')).toEqual({ keyframes: [{ time: 0, value: 1 }] });
		expect(c.getState().keys.speed).toBe('keyed');

		c.setTime(1000);
		expect(c.getState().keys.speed).toBe('animated');
		c.setValue('speed', 2); // no key here: the track is untouched
		expect(keyframes.getTrack('speed')!.keyframes).toHaveLength(1);
		c.toggleKeyframe('speed');
		c.setValue('speed', 3); // on a key: the key follows
		expect(keyframes.getTrack('speed')!.keyframes).toEqual([
			{ time: 0, value: 1 },
			{ time: 1000, value: 3 }
		]);
		c.undo();
		expect(keyframes.getTrack('speed')!.keyframes[1].value).toBe(2);
		expect(c.getValue('speed')).toBe(2);

		c.toggleKeyframe('speed', 1000);
		c.toggleKeyframe('speed', 0);
		expect(keyframes.getTrack('speed')).toBeUndefined();
		expect(c.getState().keys.speed).toBe('none');
		c.undo();
		expect(c.keyState('speed', 0)).toBe('keyed');
	});

	it('shows evaluated values on time changes without undo steps', () => {
		const c = new ParametersController({ schema, keyframes: createParameterKeyframeStore() });
		c.setTime(500, { speed: 2.5 });
		expect(c.getState()).toMatchObject({ time: 500, values: expect.objectContaining({ speed: 2.5 }), canUndo: false });
	});

	it('follows tracks changed outside the controller and refuses toggles without an adapter', () => {
		const keyframes = createParameterKeyframeStore();
		const c = new ParametersController({ schema, keyframes });
		keyframes.setTrack('steps', withParameterKeyframe(undefined, { time: 0, value: 4, easing: 'ease-in' }));
		expect(c.getState().keys.steps).toBe('keyed');
		const plain = new ParametersController({ schema });
		expect(plain.toggleKeyframe('speed')).toEqual({ ok: false, message: 'Keyframes are not available here.' });
		expect(plain.getState().keyframesEnabled).toBe(false);
	});
});

describe('parameter commands', () => {
	function setup() {
		const keyframes = createParameterKeyframeStore();
		const controller = new ParametersController({ schema, keyframes });
		const registry = new CommandRegistry();
		registry.register(createParameterCommands(controller));
		return { controller, registry };
	}

	it('lists parameters for agents', () => {
		const { registry } = setup();
		const result = registry.execute('parameters.list') as any;
		expect(result.ok).toBe(true);
		const speed = result.result.parameters[0];
		expect(speed).toMatchObject({ id: 'speed', label: 'Speed', type: 'number', value: 1, visible: true, keyframe: 'none' });
		expect(result.result.presets).toEqual(['Punchy']);
	});

	it('sets values through the registry with schema validation and sentence errors', () => {
		const { registry, controller } = setup();
		expect(registry.execute('parameters.set', { values: { speed: 2, tint: '#FF0000' } })).toMatchObject({ ok: true });
		expect(controller.getValues()).toMatchObject({ speed: 2, tint: '#ff0000' });
		const range = registry.execute('parameters.set', { values: { center: [0, 5] } }) as any;
		expect(range).toMatchObject({ ok: false, code: 'invalid_params' });
		const sentence = registry.execute('parameters.set', { values: { caption: 'NOPE' } }) as any;
		expect(sentence).toMatchObject({ ok: false, code: 'failed', message: 'Caption must match the pattern [a-z ]*.' });
		expect(registry.execute('parameters.set', { values: { bogus: 1 } })).toMatchObject({ ok: false, code: 'invalid_params' });
	});

	it('exposes presets, reset, randomize and keyframes as agent tools', async () => {
		const { registry, controller } = setup();
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(registry, { id: 'commands' }));
		const call = await tools.callTool('run_command', { id: 'parameters.set', params: { values: { steps: 100 } } });
		expect(call.isError).toBe(true);
		expect(JSON.stringify(call.content)).toContain('/values/steps Must be <= 64.');
		expect(registry.isEnabled('parameters.reset').enabled).toBe(false);
		registry.execute('parameters.applyPreset', { name: 'Punchy' });
		expect(controller.getValue('speed')).toBe(3);
		expect(registry.execute('parameters.savePreset', { name: 'Punchy' })).toMatchObject({ ok: false, message: '"Punchy" is a built-in preset; save under another name.' });
		registry.execute('parameters.reset', {});
		expect(controller.getState().modified).toBe(false);
		registry.execute('parameters.randomize', { seed: 3 });
		expect(controller.getState().modified).toBe(true);
		expect(registry.execute('parameters.toggleKeyframe', { id: 'speed', time: 250 })).toMatchObject({ ok: true, result: { keyed: true, time: 250 } });
		expect(controller.keyState('speed', 250)).toBe('keyed');
	});

	it('follows schema changes in the set command params', () => {
		const { registry, controller } = setup();
		controller.setSchema({ fields: [{ id: 'only', type: 'boolean', default: false }] });
		const entry = registry.list().find((e) => e.id === 'parameters.set')!;
		expect(Object.keys((entry.params!.properties!.values as any).properties)).toEqual(['only']);
	});
});

describe('shader control adapter', () => {
	const controls: ShaderControlLike[] = [
		{ name: 'uSpeed', type: 'float', label: 'Speed', color: false, min: 0, max: 4, step: 0.02, default: 1 },
		{ name: 'uSteps', type: 'int', label: 'Steps', color: false, min: 1, max: 64, step: 1, default: 16 },
		{ name: 'uGrain', type: 'bool', label: 'Film grain', color: false, min: 0, max: 1, step: 0.005, default: true },
		{ name: 'uCenter', type: 'vec2', label: 'Center', color: false, min: -1, max: 1, step: 0.01, default: [0, 0] },
		{ name: 'uTint', type: 'vec3', label: 'Tint', color: true, min: 0, max: 1, step: 0.005, default: [1, 0.5, 0] },
		{ name: 'uFog', type: 'vec4', label: 'Fog', color: true, min: 0, max: 1, step: 0.005, default: [0, 0, 1, 0.5] },
		{ name: 'uPhoto', type: 'sampler2D', label: 'Photo', color: false, min: 0, max: 1, step: 0.005, default: 'https://example.com/a.jpg' }
	];

	it('maps Flair-style controls to a schema', () => {
		const s = parameterSchemaFromShaderControls(controls);
		expect(checkParameterSchema(s)).toEqual([]);
		expect(s.fields.map((f) => f.type)).toEqual(['number', 'int', 'boolean', 'vector', 'color', 'color', 'image']);
		expect(getParameterDefaults(s)).toEqual({
			uSpeed: 1,
			uSteps: 16,
			uGrain: true,
			uCenter: [0, 0],
			uTint: '#ff8000',
			uFog: '#0000ff80',
			uPhoto: 'https://example.com/a.jpg'
		});
	});

	it('converts colour values back and forth', () => {
		const tint = controls[4];
		const fog = controls[5];
		expect(shaderControlValue(tint, '#ff0000')).toEqual([1, 0, 0]);
		expect(shaderControlValue(fog, '#ff000000')).toEqual([1, 0, 0, 0]);
		expect(shaderControlValue(controls[0], 2)).toBe(2);
		expect(parameterValueFromShaderControl(tint, [0, 1, 0])).toBe('#00ff00');
	});
});
