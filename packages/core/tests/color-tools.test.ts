import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../src/agent';
import { createColorToolProvider } from '../src/color';

describe('createColorToolProvider', () => {
	it('registers with ToolRegistry and exposes all 5 tools with complete annotations', () => {
		const registry = new ToolRegistry();
		registry.register(createColorToolProvider({ id: 'color', namespace: 'color' }));
		const tools = registry.listTools().tools;
		expect(tools.map((t) => t.name).sort()).toEqual([
			'color__blend_colors',
			'color__check_color_contrast',
			'color__check_color_palette',
			'color__inspect_color',
			'color__suggest_color_harmony'
		]);

		for (const tool of tools) {
			expect(tool.title).toBeTruthy();
			expect(tool.annotations?.title).toBe(tool.title);
			expect(tool.annotations?.readOnlyHint).toBe(true);
			expect(tool.annotations?.destructiveHint).toBe(false);
			expect(tool.annotations?.idempotentHint).toBe(true);
			expect(tool.annotations?.openWorldHint).toBe(false);
			expect(tool.description).toBeTruthy();
			for (const [key, prop] of Object.entries(tool.inputSchema.properties ?? {})) {
				expect((prop as any).description, `${tool.name}.${key} has description`).toBeTruthy();
			}
		}
	});

	describe('inspect_color', () => {
		it('inspects valid hex, rgb, and named colours', async () => {
			const registry = new ToolRegistry();
			registry.register(createColorToolProvider());

			const res = await registry.callTool('inspect_color', { color: '#ff3366' });
			expect(res.isError).toBeUndefined();
			const parsed = res.structuredContent as any;
			expect(parsed.hex).toBe('#ff3366');
			expect(parsed.rgb).toEqual({ r: 255, g: 51, b: 102 });
			expect(parsed.alpha).toBe(1);
			expect(parsed.hsl).toBeDefined();
			expect(parsed.oklch).toBeDefined();
			expect(parsed.inSrgbGamut).toBe(true);
			expect(typeof parsed.relativeLuminance).toBe('number');
		});

		it('returns error for invalid color input', async () => {
			const registry = new ToolRegistry();
			registry.register(createColorToolProvider());

			const res = await registry.callTool('inspect_color', { color: 'not-a-color-xyz' });
			expect(res.isError).toBe(true);
			expect(res.content?.[0]?.text).toContain('not a colour I can read');
		});
	});

	describe('check_color_contrast', () => {
		it('evaluates contrast and compliance against target', async () => {
			const registry = new ToolRegistry();
			registry.register(createColorToolProvider());

			const res = await registry.callTool('check_color_contrast', {
				foreground: '#000000',
				background: '#ffffff'
			});
			expect(res.isError).toBeUndefined();
			const data = res.structuredContent as any;
			expect(data.ratio).toBe(21);
			expect(data.passesAA).toBe(true);
			expect(data.passesAAA).toBe(true);
			expect(data.suggestion).toBeUndefined();
		});

		it('provides suggestion when target compliance fails', async () => {
			const registry = new ToolRegistry();
			registry.register(createColorToolProvider());

			const res = await registry.callTool('check_color_contrast', {
				foreground: '#777777',
				background: '#888888'
			});
			expect(res.isError).toBeUndefined();
			const data = res.structuredContent as any;
			expect(data.passesAA).toBe(false);
			expect(data.suggestion).toBeDefined();
			expect(data.suggestion).toMatch(/^#[0-9a-f]{6}$/);
		});

		it('returns error if either colour is invalid', async () => {
			const registry = new ToolRegistry();
			registry.register(createColorToolProvider());

			const res = await registry.callTool('check_color_contrast', {
				foreground: 'invalid-fg',
				background: '#ffffff'
			});
			expect(res.isError).toBe(true);
			expect(res.content?.[0]?.text).toContain('not a colour I can read');
		});
	});

	describe('check_color_palette', () => {
		it('checks pairwise contrast, warnings, and vision indistinguishability', async () => {
			const registry = new ToolRegistry();
			registry.register(createColorToolProvider());

			const res = await registry.callTool('check_color_palette', {
				colors: ['#ffffff', '#000000', '#111111']
			});
			expect(res.isError).toBeUndefined();
			const data = res.structuredContent as any;
			expect(data.contrast.length).toBe(3);
			expect(data.closest.normal).toBeDefined();
			// '#000000' and '#111111' should trigger distinctness or low contrast issue
			expect(data.issues.length).toBeGreaterThan(0);
		});

		it('fails if fewer than 2 colours provided or colour cannot be parsed', async () => {
			const registry = new ToolRegistry();
			registry.register(createColorToolProvider());

			const res1 = await registry.callTool('check_color_palette', {
				colors: ['#ffffff']
			});
			expect(res1.isError).toBe(true);

			const res2 = await registry.callTool('check_color_palette', {
				colors: ['#ffffff', 'bad-color']
			});
			expect(res2.isError).toBe(true);
			expect(res2.content?.[0]?.text).toContain('not a colour I can read');
		});
	});

	describe('suggest_color_harmony', () => {
		it('generates harmonic colour combinations', async () => {
			const registry = new ToolRegistry();
			registry.register(createColorToolProvider());

			const res = await registry.callTool('suggest_color_harmony', {
				base: '#3b82f6',
				kind: 'complementary'
			});
			expect(res.isError).toBeUndefined();
			const data = res.structuredContent as any;
			expect(data.colors.length).toBe(2);
			expect(data.colors[0].hex).toBe('#3b82f6');
		});

		it('returns error for invalid base colour', async () => {
			const registry = new ToolRegistry();
			registry.register(createColorToolProvider());

			const res = await registry.callTool('suggest_color_harmony', {
				base: 'invalid',
				kind: 'triadic'
			});
			expect(res.isError).toBe(true);
		});
	});

	describe('blend_colors', () => {
		it('blends single factor t in OKLab', async () => {
			const registry = new ToolRegistry();
			registry.register(createColorToolProvider());

			const res = await registry.callTool('blend_colors', {
				from: '#000000',
				to: '#ffffff',
				space: 'oklab',
				t: 0.5
			});
			expect(res.isError).toBeUndefined();
			const data = res.structuredContent as any;
			expect(data.color).toBeDefined();
			expect(data.color).toMatch(/^#[0-9a-f]{6}$/);
		});

		it('generates multi-step ramp', async () => {
			const registry = new ToolRegistry();
			registry.register(createColorToolProvider());

			const res = await registry.callTool('blend_colors', {
				from: '#ff0000',
				to: '#0000ff',
				steps: 5
			});
			expect(res.isError).toBeUndefined();
			const data = res.structuredContent as any;
			expect(data.colors).toBeDefined();
			expect(data.colors.length).toBe(5);
			expect(data.colors[0]).toBe('#ff0000');
			expect(data.colors[4]).toBe('#0000ff');
		});

		it('returns error when arguments are invalid', async () => {
			const registry = new ToolRegistry();
			registry.register(createColorToolProvider());

			const res = await registry.callTool('blend_colors', {
				from: '#ff0000',
				to: '#0000ff',
				steps: 1
			});
			expect(res.isError).toBe(true);
		});
	});
});
