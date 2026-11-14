import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { chart3dContrastCheck, chartStyleDomain, createChartSpec, DEFAULT_CHART_3D_STYLE, resolveChart3dStyle } from '../src/chart';
import { createChart3dScene } from '../src/three';
import { checkStyleSkill } from '../src/tools';
import { tokenSourceFromJson } from '../src/style-cli/run';

const spec = (extra: Record<string, unknown> = {}) =>
	createChartSpec({
		type: 'bar',
		categories: ['Q1', 'Q2', 'Q3'],
		series: [
			{ id: 'a', name: 'A', values: [10, 20, 30] },
			{ id: 'l', name: 'L', type: 'area', values: [5, 25, 15] }
		],
		view3d: { azimuth: 25, elevation: 20, depth: 1.5 },
		...extra
	} as never);

/** What the scene draws with: each light and each named mesh's material, as plain data. */
function look(view: ReturnType<typeof createChart3dScene>) {
	const lights = view.scene.children.filter((c): c is THREE.Light => c instanceof THREE.Light).map((l) => ({ type: l.type, intensity: l.intensity, position: l.position.toArray().map((v) => Math.round(v * 1e6) / 1e6), castShadow: l.castShadow }));
	const chart = view.scene.getObjectByName('chart')!;
	const meshes = chart.children
		.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh)
		.map((m) => {
			const mat = m.material as THREE.MeshPhysicalMaterial;
			return { name: m.name, type: mat.type, color: mat.color.getHexString(), roughness: mat.roughness, metalness: mat.metalness, opacity: mat.opacity, transmission: mat.transmission ?? 0, castShadow: m.castShadow, receiveShadow: m.receiveShadow };
		});
	return { lights, meshes };
}

describe('resolveChart3dStyle', () => {
	it('fills every part with the defaults, which are unstyled 3-D', () => {
		expect(resolveChart3dStyle()).toEqual(DEFAULT_CHART_3D_STYLE);
		expect(resolveChart3dStyle({})).toEqual(DEFAULT_CHART_3D_STYLE);
		expect(resolveChart3dStyle({ version: 1 })).toEqual(DEFAULT_CHART_3D_STYLE);
	});

	it('keeps what is given, clamps out-of-range values, and ignores unknown presets', () => {
		const s = resolveChart3dStyle({ materials: { mark: { metalness: 2, roughness: -1 }, floor: { color: '#222' } }, light: { preset: 'nope' as never, intensity: 9, elevation: 120 }, shadow: { enabled: true }, ambientOcclusion: true, background: '#000' });
		expect(s.materials.mark).toEqual({ roughness: 0, metalness: 1, opacity: 1, transmission: 0 });
		expect(s.materials.floor.color).toBe('#222');
		expect(s.light).toEqual({ preset: 'studio', intensity: 4, elevation: 89 });
		expect(s.shadow).toEqual({ enabled: true, softness: 0.5 });
		expect(s.ambientOcclusion).toBe(true);
		expect(s.background).toBe('#000');
	});

	it('refuses a section from a newer version, saying what to do', () => {
		expect(() => resolveChart3dStyle({ version: 2 })).toThrow('The 3-D style is version 2; this library reads up to version 1. Update @pixerate/editor, or write a version 1 section.');
	});
});

describe('3-D charts in the house style', () => {
	it('draws exactly as before without a style, or with an empty one', () => {
		const plain = createChart3dScene(spec(), { width: 640, height: 400 });
		const empty = createChart3dScene(spec(), { width: 640, height: 400, style: {} });
		expect(look(empty)).toEqual(look(plain));
		const before = look(plain);
		// Today's look: a sky / ground fill of 1.6 and a key of 1.4 from the upper left; matte everywhere.
		expect(before.lights.map((l) => [l.type, l.intensity])).toEqual([['HemisphereLight', 1.6], ['DirectionalLight', 1.4]]);
		for (const m of before.meshes) expect([m.type, m.roughness, m.metalness, m.opacity]).toEqual(['MeshStandardMaterial', 0.8, 0, 1]);
		expect(plain.background).toBe('#ffffff');
		plain.dispose();
		empty.dispose();
	});

	it('takes materials, the floor and wall colours and the background from the style', () => {
		const view = createChart3dScene(spec(), {
			width: 640,
			height: 400,
			style: { materials: { mark: { metalness: 0.6, roughness: 0.3 }, ribbon: { transmission: 0.8, opacity: 0.7 }, floor: { color: '#203040' }, wall: { color: '#101820', roughness: 1 } }, background: '#0a0a0a' }
		});
		const { meshes } = look(view);
		const bar = meshes.find((m) => m.name === 'bar-a-0')!;
		expect([bar.metalness, bar.roughness]).toEqual([0.6, 0.3]);
		const ribbon = meshes.find((m) => m.name === 'area-l')!;
		expect([ribbon.type, ribbon.transmission, ribbon.opacity]).toEqual(['MeshPhysicalMaterial', 0.8, 0.7]);
		expect(meshes[0]).toMatchObject({ color: '203040' }); // the floor
		expect(meshes[1]).toMatchObject({ color: '101820', roughness: 1 }); // the wall
		expect(view.background).toBe('#0a0a0a');
		view.dispose();
	});

	it('lights each preset its own way, scaled by intensity and turned by azimuth and elevation', () => {
		const lights = (light: object) => look(createChart3dScene(spec(), { width: 640, height: 400, style: { light } })).lights;
		expect(lights({ preset: 'soft' }).map((l) => [l.type, l.intensity])).toEqual([['HemisphereLight', 2.2], ['DirectionalLight', 0.6]]);
		expect(lights({ preset: 'flat', intensity: 0.5 }).map((l) => [l.type, l.intensity])).toEqual([['AmbientLight', 1.5], ['DirectionalLight', 0]]);
		expect(lights({ preset: 'rim' }).map((l) => l.type)).toEqual(['HemisphereLight', 'DirectionalLight', 'DirectionalLight']);
		const left = lights({ azimuth: -60, elevation: 40 })[1]!.position;
		const right = lights({ azimuth: 60, elevation: 40 })[1]!.position;
		expect(left[0]).toBeLessThan(right[0]);
	});

	it('casts shadows and darkens contacts when asked', () => {
		const view = createChart3dScene(spec(), { width: 640, height: 400, style: { shadow: { enabled: true, softness: 1 }, ambientOcclusion: true } });
		const { lights, meshes } = look(view);
		expect(lights.find((l) => l.type === 'DirectionalLight')!.castShadow).toBe(true);
		expect(meshes.find((m) => m.name === 'bar-a-1')!.castShadow).toBe(true);
		expect(meshes[0]!.receiveShadow).toBe(true);
		expect(meshes.filter((m) => m.name.startsWith('contact-')).map((m) => m.name)).toEqual(['contact-a-0', 'contact-a-1', 'contact-a-2']);
		view.dispose();
	});

	it('glows the focused marks in the highlight colour, and stops when the focus clears', () => {
		const view = createChart3dScene(spec(), { width: 640, height: 400, style: { materials: { highlight: { color: '#ff0000', intensity: 0.5 } } } });
		const emissive = (name: string) => ((view.scene.getObjectByName(name) as THREE.Mesh).material as THREE.MeshStandardMaterial).emissive.getHexString();
		view.focus({ kind: 'point', seriesId: 'a', index: 1 });
		// Half the highlight's red (three.js works in linear light, so it reads brighter in sRGB hex).
		expect(emissive('bar-a-1')).toMatch(/^[1-9a-f][0-9a-f]0000$/);
		expect(emissive('bar-a-0')).toBe('000000');
		view.focus(null);
		expect(emissive('bar-a-1')).toBe('000000');
		view.dispose();
	});
});

describe('the three section in chart.json', () => {
	const skillMd = `---\nname: acme\ndescription: acme house style.\n---\n\nUse the brand.\n`;

	it('validates, and resolves $token references inside it', async () => {
		const tokens = tokenSourceFromJson({ brand: { floor: { $value: '#1b1f24' } } });
		const files = { 'SKILL.md': skillMd, 'chart.json': JSON.stringify({ three: { version: 1, materials: { floor: { color: { $token: 'brand/floor' }, roughness: 0.6 } }, light: { preset: 'soft' } } }) };
		const result = await checkStyleSkill('acme', files, { domains: [chartStyleDomain], tokens });
		expect(result.errors).toEqual([]);
		expect(result.profiles.chart).toEqual({ three: { version: 1, materials: { floor: { color: '#1b1f24', roughness: 0.6 } }, light: { preset: 'soft' } } });
		const bad = await checkStyleSkill('acme', { 'SKILL.md': skillMd, 'chart.json': JSON.stringify({ three: { light: { preset: 'disco' } } }) }, { domains: [chartStyleDomain] });
		expect(bad.errors.join(' ')).toMatch(/preset/);
	});

	it('checks label and mark contrast on the 3-D surfaces, only for charts with a 3-D view', () => {
		const run = (s: ReturnType<typeof spec>, profile: object) => chart3dContrastCheck.run(s, profile as never, {}, {});
		const dark = { palette: ['#1e293b'], theme: { text: '#1f2937', mutedText: '#6b7280' }, three: { background: '#0b0f14', materials: { floor: { color: '#111827' } } } };
		const findings = run(spec(), dark);
		expect(findings.map((f) => f.message)).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^In 3-D, label text \(#1f2937\) has contrast [\d.]+:1 on the background \(#0b0f14\); want 4\.5:1/),
				expect.stringMatching(/^In 3-D, marks in #1e293b have contrast [\d.]+:1 against the floor \(#111827\)/)
			])
		);
		expect(run(spec({ view3d: null }), dark)).toEqual([]);
		expect(run(spec(), { palette: ['#2563eb'], theme: { text: '#111111', mutedText: '#4b5563' } })).toEqual([]);
	});
});

describe('label contrast on the rendered picture', () => {
	it('flags labels whose text does not read on the colour sampled behind them', async () => {
		const { checkChart3dLabelContrast } = await import('../src/three');
		const view = createChart3dScene(spec({ title: 'Revenue' }), { width: 640, height: 400 });
		const labels = view.labels();
		// A dark picture behind the category labels, white elsewhere.
		const categories = labels.filter((l) => l.kind === 'category');
		const sample = (x: number, y: number) => (categories.some((l) => l.x === x && l.y === y) ? '#111111' : '#ffffff');
		const findings = checkChart3dLabelContrast(labels, sample, { text: '#1f2937', mutedText: '#6b7280' });
		expect(findings.map((f) => [f.label.kind, f.label.text, f.behind])).toEqual([['category', 'Q1', '#111111'], ['category', 'Q2', '#111111'], ['category', 'Q3', '#111111']]);
		expect(findings[0]!.ratio).toBeLessThan(4.5);
		expect(checkChart3dLabelContrast(labels, () => null)).toEqual([]);
		view.dispose();
	});
});
