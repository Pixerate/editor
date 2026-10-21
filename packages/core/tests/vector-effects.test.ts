import { describe, expect, it } from 'vitest';
import { createFakeEffectProvider } from '../src/effects';
import { ToolRegistry } from '../src/tools';
import { VectorEditorController, createVectorEffectsToolProvider, rectSubpath, type VectorGroupNode } from '../src/vector';
import { baseToolName } from '../src/tools';

const editor = (effects = createFakeEffectProvider() as ReturnType<typeof createFakeEffectProvider> | null) => {
	const c = new VectorEditorController({ document: { width: 400, height: 200, background: '#ffffff', nodes: [{ id: 'box', type: 'path', fill: '#ef4444', subpaths: [rectSubpath({ x: 20, y: 20, width: 60, height: 60 })] }, { id: 'g', type: 'group', children: [] }] } });
	if (effects) c.setEffectsProvider(effects);
	return c;
};

describe('vector editor: provider vector effects', () => {
	it('adds a vector effect picture as a tagged group, redraws it and detaches it, one undo step each', async () => {
		const c = editor();
		const id = await c.addVectorEffect('fake.badge', { values: { color: '#00ff00' } });
		const g = c.getNode(id) as VectorGroupNode;
		expect(g).toMatchObject({ type: 'group', name: 'Badge', providerEffect: { effect: 'fake.badge', provider: 'fake', values: { color: '#00ff00', ms: 500 } } });
		expect(g.children[0]).toMatchObject({ fill: '#00ff00' });
		expect(g.transform).toEqual([1, 0, 0, 1, 150, 50]);
		expect(c.getState().selection).toEqual([id]);
		await c.updateVectorEffect(id, { color: '#0000ff' });
		expect(((c.getNode(id) as VectorGroupNode).children[0] as { fill: string }).fill).toBe('#0000ff');
		expect((c.getNode(id) as VectorGroupNode).transform).toEqual([1, 0, 0, 1, 150, 50]);
		// Saved and loaded, the tag survives.
		expect((new VectorEditorController({ document: JSON.parse(JSON.stringify(c.toJSON())) }).getNode(id) as VectorGroupNode).providerEffect?.effect).toBe('fake.badge');
		c.detachVectorEffect(id);
		expect((c.getNode(id) as VectorGroupNode).providerEffect).toBeUndefined();
		c.undo();
		expect((c.getNode(id) as VectorGroupNode).providerEffect?.values.color).toBe('#0000ff');
	});

	it('refuses other kinds and works as before without a provider', async () => {
		const c = editor();
		await expect(c.addVectorEffect('fake.fade-in')).rejects.toThrow(/animation editor/);
		await expect(c.addVectorEffect('fake.tint')).rejects.toThrow(/shader effect/);
		const plain = editor(null);
		expect(plain.effectsProvider).toBeNull();
		await expect(plain.addVectorEffect('fake.badge')).rejects.toThrow(/No effects provider/);
		expect(plain.toSvg()).toBe(new VectorEditorController({ document: plain.toJSON() }).toSvg());
	});

	it('works through the registry', async () => {
		const c = editor();
		const registry = new ToolRegistry();
		registry.register(createVectorEffectsToolProvider(c));
		expect(registry.listTools().tools.map((t) => baseToolName(t.name))).toEqual(['search_effects', 'describe_effect', 'list_applied_effects', 'apply_effect', 'update_effect', 'remove_effect']);
		const a = await registry.callTool('apply_effect', { target: 'g', effect: 'fake.badge' });
		expect(a.isError).toBeFalsy();
		const id = (a.structuredContent as { group: string }).group;
		expect((c.getNode('g') as VectorGroupNode).children.map((n) => n.id)).toEqual([id]);
		const u = await registry.callTool('update_effect', { target: id, effect: 'picture', values: { ms: 100 } });
		expect((u.structuredContent as any).effect.values.ms).toBe(100);
		expect(((await registry.callTool('list_applied_effects', {})).structuredContent as any).targets).toHaveLength(1);
		expect(((await registry.callTool('apply_effect', { target: 'box', effect: 'fake.badge' })).content[0] as { text: string }).text).toMatch(/not a group/);
		expect((await registry.callTool('remove_effect', { target: id, effect: 'picture' })).isError).toBeFalsy();
		const none = new ToolRegistry();
		none.register(createVectorEffectsToolProvider(editor(null)));
		expect((await none.callTool('search_effects', {})).structuredContent).toMatchObject({ available: false });
		expect((await none.callTool('apply_effect', { target: 'document', effect: 'fake.badge' })).isError).toBe(true);
	});
});
