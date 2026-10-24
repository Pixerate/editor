import { describe, it, expect } from 'vitest';
import { GradientController, createGradientToolProvider } from '../src/gradient/index.js';
import { ToolRegistry } from '../src/tools/index.js';

describe('createGradientToolProvider', () => {
	it('registers all tools and executes read tools', async () => {
		const ctrl = new GradientController();
		const provider = createGradientToolProvider(ctrl, { namespace: '' });
		const registry = new ToolRegistry();
		registry.register(provider);

		const tools = registry.listTools().tools;
		expect(tools.map((t) => t.name)).toContain('get_gradient');
		expect(tools.map((t) => t.name)).toContain('check_gradient');
		expect(tools.map((t) => t.name)).toContain('list_gradient_presets');
		expect(tools.map((t) => t.name)).toContain('set_gradient');
		expect(tools.map((t) => t.name)).toContain('set_gradient_geometry');
		expect(tools.map((t) => t.name)).toContain('add_gradient_stop');
		expect(tools.map((t) => t.name)).toContain('update_gradient_stop');
		expect(tools.map((t) => t.name)).toContain('remove_gradient_stop');
		expect(tools.map((t) => t.name)).toContain('reverse_gradient');
		expect(tools.map((t) => t.name)).toContain('distribute_gradient_stops');
		expect(tools.map((t) => t.name)).toContain('apply_gradient_preset');

		const getRes = (await registry.callTool('get_gradient', {})) as any;
		expect(getRes.isError).toBeFalsy();
		expect(getRes.content[0].text).toContain('linear-gradient');

		const checkRes = (await registry.callTool('check_gradient', { text: '#000000' })) as any;
		expect(checkRes.isError).toBeFalsy();

		const presetsRes = (await registry.callTool('list_gradient_presets', {})) as any;
		expect(presetsRes.isError).toBeFalsy();
		expect(presetsRes.content[0].text).toContain('sunset');
	});

	it('executes write tools via ToolRegistry with valid and invalid arguments', async () => {
		const ctrl = new GradientController();
		const provider = createGradientToolProvider(ctrl, { namespace: '' });
		const registry = new ToolRegistry();
		registry.register(provider);

		// set_gradient_geometry
		const setGeoRes = (await registry.callTool('set_gradient_geometry', { angle: 180, type: 'conic' })) as any;
		expect(setGeoRes.isError).toBeFalsy();
		expect(ctrl.state.gradient.angle).toBe(180);
		expect(ctrl.state.gradient.type).toBe('conic');

		// add_gradient_stop
		const addStopRes = (await registry.callTool('add_gradient_stop', { color: '#00ff00', offset: 0.5 })) as any;
		expect(addStopRes.isError).toBeFalsy();
		expect(ctrl.state.gradient.stops).toHaveLength(3);

		// update_gradient_stop
		const stopId = ctrl.state.gradient.stops[1].id;
		const updateRes = (await registry.callTool('update_gradient_stop', { id: stopId, color: '#ffff00' })) as any;
		expect(updateRes.isError).toBeFalsy();

		// update with invalid id
		const badUpdate = (await registry.callTool('update_gradient_stop', { id: 'nonexistent', color: '#ff0000' })) as any;
		expect(badUpdate.isError).toBe(true);

		// reverse_gradient
		const revRes = (await registry.callTool('reverse_gradient', {})) as any;
		expect(revRes.isError).toBeFalsy();

		// distribute_gradient_stops
		const distRes = (await registry.callTool('distribute_gradient_stops', {})) as any;
		expect(distRes.isError).toBeFalsy();

		// remove_gradient_stop
		const remRes = (await registry.callTool('remove_gradient_stop', { id: stopId })) as any;
		expect(remRes.isError).toBeFalsy();
		expect(ctrl.state.gradient.stops).toHaveLength(2);

		// remove stop below 2 fails
		const badRem = (await registry.callTool('remove_gradient_stop', { id: ctrl.state.gradient.stops[0].id })) as any;
		expect(badRem.isError).toBe(true);

		// apply_gradient_preset
		const presetRes = (await registry.callTool('apply_gradient_preset', { id: 'sunset' })) as any;
		expect(presetRes.isError).toBeFalsy();
		expect(ctrl.state.gradient.stops.length).toBeGreaterThanOrEqual(2);

		// apply unknown preset fails
		const badPreset = (await registry.callTool('apply_gradient_preset', { id: 'unknown-preset' })) as any;
		expect(badPreset.isError).toBe(true);
	});

	it('fails set_gradient with both gradient and css or neither', async () => {
		const ctrl = new GradientController();
		const provider = createGradientToolProvider(ctrl, { namespace: '' });
		const registry = new ToolRegistry();
		registry.register(provider);

		// both
		const bothRes = (await registry.callTool('set_gradient', {
			gradient: { type: 'linear', stops: [{ id: 's1', offset: 0, color: '#000' }, { id: 's2', offset: 1, color: '#fff' }] },
			css: 'linear-gradient(90deg, #f00, #00f)'
		})) as any;
		expect(bothRes.isError).toBe(true);

		// css only works
		const cssRes = (await registry.callTool('set_gradient', {
			css: 'linear-gradient(45deg, #f00 0%, #00f 100%)'
		})) as any;
		expect(cssRes.isError).toBeFalsy();
		expect(ctrl.state.gradient.angle).toBe(45);
	});

	it('hides write tools when read-only', () => {
		const ctrl = new GradientController({ readOnly: true });
		const provider = createGradientToolProvider(ctrl, { namespace: '' });
		const registry = new ToolRegistry();
		registry.register(provider);

		const toolNames = registry.listTools().tools.map((t) => t.name);
		expect(toolNames).toContain('get_gradient');
		expect(toolNames).toContain('check_gradient');
		expect(toolNames).toContain('list_gradient_presets');
		expect(toolNames).not.toContain('set_gradient');
		expect(toolNames).not.toContain('add_gradient_stop');
		expect(toolNames).not.toContain('remove_gradient_stop');
	});
});

describe('set_gradient_geometry', () => {
	const setup = () => {
		const ctrl = new GradientController();
		const registry = new ToolRegistry();
		registry.register(createGradientToolProvider(ctrl, { namespace: '' }));
		return { ctrl, registry };
	};

	it('applies several fields as one undo step and returns the result', async () => {
		const { ctrl, registry } = setup();
		const res = (await registry.callTool('set_gradient_geometry', { type: 'radial', shape: 'circle', center: { x: 0.25, y: 0.75 } })) as any;
		expect(res.isError).toBeFalsy();
		expect(res.structuredContent.gradient).toMatchObject({ type: 'radial', shape: 'circle', center: { x: 0.25, y: 0.75 } });
		expect(res.structuredContent.css).toContain('radial-gradient(');
		ctrl.undo();
		expect(ctrl.getGradient().type).toBe('linear');
	});

	it('changes nothing when one field is invalid', async () => {
		const { ctrl, registry } = setup();
		const res = (await registry.callTool('set_gradient_geometry', { type: 'conic', shape: 'circle' })) as any;
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/radial gradients only/);
		expect(ctrl.getGradient().type).toBe('linear');
		expect(ctrl.state.canUndo).toBe(false);
	});

	it('rejects unsupported interpolation spaces, stray center keys and empty calls', async () => {
		const { registry } = setup();
		const interp = (await registry.callTool('set_gradient_geometry', { interpolation: 'hwb' })) as any;
		expect(interp.isError).toBe(true);
		const center = (await registry.callTool('set_gradient_geometry', { type: 'radial', center: { x: 0.5, y: 0.5, z: 1 } })) as any;
		expect(center.isError).toBe(true);
		const empty = (await registry.callTool('set_gradient_geometry', {})) as any;
		expect(empty.isError).toBe(true);
		expect(empty.content[0].text).toMatch(/at least one/);
	});
});
