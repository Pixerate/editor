import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../src/agent';
import { createColorToolProvider } from '../src/color';

describe('createColorToolProvider', () => {
	it('registers with ToolRegistry and exposes all 8 tools with complete annotations', () => {
		const registry = new ToolRegistry();
		registry.register(createColorToolProvider({ id: 'color', namespace: 'color' }));
		const tools = registry.listTools().tools;
		expect(tools.map((t) => t.name).sort()).toEqual([
			'color__blend_colors',
			'color__check_color_contrast',
			'color__check_color_palette',
			'color__check_dual_color_contrast',
			'color__derive_dual_color',
			'color__export_dual_colors_css',
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

		it('gives specific error when passed a light-dark() dual colour', async () => {
			const registry = new ToolRegistry();
			registry.register(createColorToolProvider());

			const res = await registry.callTool('inspect_color', { color: 'light-dark(#ffffff, #000000)' });
			expect(res.isError).toBe(true);
			expect(res.content?.[0]?.text).toContain(
				'This is a dual colour (light-dark); use check_dual_color_contrast, or pass one half.'
			);
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

		it('gives specific error when passed a light-dark() dual colour', async () => {
			const registry = new ToolRegistry();
			registry.register(createColorToolProvider());

			const res = await registry.callTool('check_color_contrast', {
				foreground: 'light-dark(#111, #eee)',
				background: '#ffffff'
			});
			expect(res.isError).toBe(true);
			expect(res.content?.[0]?.text).toContain(
				'This is a dual colour (light-dark); use check_dual_color_contrast, or pass one half.'
			);
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

	describe('derive_dual_color', () => {
		it('derives dual colour preserving contrast against surfaces', async () => {
			const registry = new ToolRegistry();
			registry.register(createColorToolProvider());

			const res = await registry.callTool('derive_dual_color', {
				color: '#1d4ed8',
				from: 'light'
			});
			expect(res.isError).toBeUndefined();
			const data = res.structuredContent as any;
			expect(data.light).toBe('#1d4ed8');
			expect(data.dark).toBeDefined();
			expect(data.css).toContain('light-dark(#1d4ed8, ');
			expect(data.contrast.light).toBeGreaterThan(1);
			expect(data.contrast.dark).toBeGreaterThan(1);
		});

		it('returns error for invalid color input', async () => {
			const registry = new ToolRegistry();
			registry.register(createColorToolProvider());

			const res = await registry.callTool('derive_dual_color', {
				color: 'invalid-color'
			});
			expect(res.isError).toBe(true);
		});
	});

	describe('check_dual_color_contrast', () => {
		it('checks contrast across both light and dark schemes', async () => {
			const registry = new ToolRegistry();
			registry.register(createColorToolProvider());

			const res = await registry.callTool('check_dual_color_contrast', {
				foreground: { light: '#000000', dark: '#ffffff' },
				background: { light: '#ffffff', dark: '#000000' }
			});
			expect(res.isError).toBeUndefined();
			const data = res.structuredContent as any;
			expect(data.light.ratio).toBe(21);
			expect(data.dark.ratio).toBe(21);
			expect(data.issues.length).toBe(0);
		});

		it('provides suggestion for failing scheme', async () => {
			const registry = new ToolRegistry();
			registry.register(createColorToolProvider());

			const res = await registry.callTool('check_dual_color_contrast', {
				foreground: '#111111',
				background: { light: '#ffffff', dark: '#0b0b0f' }
			});
			expect(res.isError).toBeUndefined();
			const data = res.structuredContent as any;
			expect(data.dark.level).toBe('fail');
			expect(data.suggestion?.dark).toBeDefined();
		});

		it('returns error for invalid dual colours', async () => {
			const registry = new ToolRegistry();
			registry.register(createColorToolProvider());

			const res = await registry.callTool('check_dual_color_contrast', {
				foreground: 'bad-fg',
				background: '#fff'
			});
			expect(res.isError).toBe(true);
		});
	});

	describe('export_dual_colors_css', () => {
		it('exports CSS custom properties', async () => {
			const registry = new ToolRegistry();
			registry.register(createColorToolProvider());

			const res = await registry.callTool('export_dual_colors_css', {
				colors: {
					bg: { light: '#ffffff', dark: '#0b0b0f' },
					text: 'light-dark(#000000, #ffffff)'
				},
				strategy: 'light-dark'
			});
			expect(res.isError).toBeUndefined();
			const data = res.structuredContent as any;
			expect(data.css).toContain('color-scheme: light dark;');
			expect(data.css).toContain('--bg: light-dark(#ffffff, #0b0b0f);');
			expect(data.css).toContain('--text: light-dark(#000000, #ffffff);');
		});

		it('returns error if colors object is empty or invalid', async () => {
			const registry = new ToolRegistry();
			registry.register(createColorToolProvider());

			const res = await registry.callTool('export_dual_colors_css', {
				colors: {}
			});
			expect(res.isError).toBe(true);
		});
	});
});

describe('dual colour tools fail usefully', () => {
	const registry = new ToolRegistry();
	registry.register(createColorToolProvider({ namespace: '' }));

	it('export_dual_colors_css rejects a variable name that would inject CSS', async () => {
		const res = (await registry.callTool('export_dual_colors_css', { colors: { 'a; } body { x': '#fff' } })) as any;
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/not a CSS variable name/);
	});

	it('derive_dual_color rejects unreadable surfaces', async () => {
		const res = (await registry.callTool('derive_dual_color', { color: '#1d4ed8', surfaces: { light: '#fff', dark: 'mud' } })) as any;
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/not a dual colour/);
	});
});
