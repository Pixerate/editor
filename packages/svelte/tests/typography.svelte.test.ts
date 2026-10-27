import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';
import { FontPicker, TypographyControl, fontPickerOf, FontPickerModel, createFontPickerToolProvider, type FontSummary, type FontProvider } from '../src/typography';
import { ToolRegistry } from '@pixerate/editor/tools';
import { EffectParameters } from '../src/effects';

const TITLE_EFFECT: any = {
  id: "demo.title",
  name: "Title",
  use: "title",
  controls: { type: "object", properties: { font: { type: "string", format: "font", title: "Font", default: "Lora" }, text: { type: "string", default: "Hi" } } },
  defaults: { font: "Lora", text: "Hi" },
  presets: [],
  inputs: [],
};

const FONTS: FontSummary[] = [
	{ family: 'Inter', category: 'sans-serif', weights: [200, 800], styles: ['normal', 'italic'], isVariable: true, source: 'web' },
	{ family: 'Lora', category: 'serif', weights: [400, 700], styles: ['normal'], source: 'custom' },
	{ family: 'Menlo', category: 'monospace', weights: [400, 700], styles: ['normal', 'italic'], source: 'system' }
];

let cleanups: (() => void)[] = [];
afterEach(() => {
	cleanups.forEach((fn) => fn());
	cleanups = [];
});

function render(component: any, props: Record<string, any>) {
	const target = document.createElement('div');
	document.body.appendChild(target);
	const instance = mount(component, { target, props });
	flushSync();
	cleanups.push(() => {
		unmount(instance);
		target.remove();
	});
	return { target, instance };
}

function type(input: HTMLInputElement, value: string) {
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}
function select(el: HTMLSelectElement, value: string) {
	el.value = value;
	el.dispatchEvent(new Event('change', { bubbles: true }));
	flushSync();
}
const options = (target: HTMLElement) => [...target.querySelectorAll('[role="option"]')].map((o) => o.querySelector('span')!.textContent);

describe('Svelte FontPicker', () => {
	it('lists fonts in their own face and marks the selection', () => {
		const { target } = render(FontPicker, { fonts: FONTS, value: { family: 'Lora' } });
		expect(options(target)).toEqual(['Inter', 'Lora', 'Menlo']);
		const selected = target.querySelector('[role="option"][aria-selected="true"]') as HTMLElement;
		expect(selected.textContent).toContain('Lora');
		expect((selected.querySelector('span') as HTMLElement).style.fontFamily).toMatch(/^Lora, Charter/);
		expect(target.querySelector('[aria-label="Font preview"]')!.textContent).toContain('quick brown fox');
	});

	it('filters by search and category, and selects with the keyboard', () => {
		const onchange = vi.fn();
		const { target } = render(FontPicker, { fonts: FONTS, value: { family: 'Inter' }, onchange });
		const search = target.querySelector('[role="combobox"]') as HTMLInputElement;
		type(search, 'm');
		expect(options(target)).toEqual(['Menlo']);
		search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		flushSync();
		expect(search.getAttribute('aria-activedescendant')).toBeTruthy();
		search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		flushSync();
		expect(onchange).toHaveBeenLastCalledWith(expect.objectContaining({ family: 'Menlo', category: 'monospace' }));
		type(search, '');
		select(target.querySelector('[aria-label="Font category"]') as HTMLSelectElement, 'serif');
		expect(options(target)).toEqual(['Lora']);
	});

	it('clicks select a family and weights snap to what it has (camelCase onChange too)', () => {
		const onChange = vi.fn();
		const { target } = render(FontPicker, { fonts: FONTS, value: { family: 'Inter', weight: 600 }, onChange });
		const weight = () => target.querySelector('[aria-label="Font weight"]') as HTMLSelectElement;
		expect([...weight().options].map((o) => o.value)).toEqual(['200', '300', '400', '500', '600', '700', '800']);
		(target.querySelectorAll('[role="option"]')[1] as HTMLElement).click();
		flushSync();
		expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ family: 'Lora', weight: 700 }));
		expect([...weight().options].map((o) => o.value)).toEqual(['400', '700']);
		select(weight(), '400');
		expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ weight: 400 }));
	});

	it('fetches from a provider and shows load failures', async () => {
		const provider: FontProvider = { id: 'p', listFonts: async () => FONTS, hasFont: () => true, loadFont: async () => false };
		const { target } = render(FontPicker, { provider, value: { family: 'Lora' } });
		await tick();
		await Promise.resolve();
		flushSync();
		expect(options(target)).toEqual(['Inter', 'Lora', 'Menlo']);
		(target.querySelectorAll('[role="option"]')[0] as HTMLElement).click();
		await Promise.resolve();
		await Promise.resolve();
		flushSync();
		expect(target.querySelector('[role="status"]')!.textContent).toMatch(/Inter could not be loaded/);
	});

	it('follows agent edits made through the font picker tools', async () => {
		const model = new FontPickerModel({ fonts: FONTS, loadOnSelect: false });
		const onchange = vi.fn();
		const registry = new ToolRegistry();
		registry.register(createFontPickerToolProvider(model));
		const { target } = render(FontPicker, { model, onchange });
		const res = await registry.callTool('set_font_selection', { family: 'Menlo', weight: 700 });
		expect(res.isError).toBeFalsy();
		flushSync();
		expect(target.querySelector('[role="option"][aria-selected="true"]')!.textContent).toContain('Menlo');
		expect((target.querySelector('[aria-label="Font weight"]') as HTMLSelectElement).value).toBe('700');
		expect(onchange).toHaveBeenLastCalledWith(expect.objectContaining({ family: 'Menlo', weight: 700 }));
	});
});

describe('Svelte TypographyControl', () => {
	it('edits size, line height and letter spacing', () => {
		const onchange = vi.fn();
		const { target } = render(TypographyControl, { fonts: FONTS, value: { family: 'Inter', size: 16 }, onchange });
		expect(target.querySelector('[role="group"]')!.getAttribute('aria-label')).toBe('Typography');
		type(target.querySelector('input[aria-label="Font size"]') as HTMLInputElement, '20');
		expect(onchange).toHaveBeenLastCalledWith(expect.objectContaining({ size: 20 }));
		type(target.querySelector('input[aria-label="Line height"]') as HTMLInputElement, '1.6');
		expect(onchange).toHaveBeenLastCalledWith(expect.objectContaining({ lineHeight: 1.6 }));
		type(target.querySelector('input[aria-label="Letter spacing"]') as HTMLInputElement, '0.02');
		expect(onchange).toHaveBeenLastCalledWith(expect.objectContaining({ letterSpacing: 0.02 }));
		expect((target.querySelector('[aria-label="Font preview"]') as HTMLElement).style.lineHeight).toBe('1.6');
	});
});

describe('fontPickerOf', () => {
	it('follows the model until destroyed', () => {
		const model = new FontPickerModel({ fonts: FONTS });
		const binding = fontPickerOf(model);
		model.setQuery('lor');
		expect(binding.state.results.map((f) => f.family)).toEqual(['Lora']);
		binding.destroy();
		model.setQuery('');
		expect(binding.state.query).toBe('lor');
	});
});

describe('EffectParameters font controls', () => {
	it("shows a font control as a choice of the host's fonts", () => {
		const onchange = vi.fn();
		const { target } = render(EffectParameters, { description: TITLE_EFFECT, values: {}, fonts: FONTS, onchange });
		const sel = target.querySelector('[data-effect-control="font"] select') as HTMLSelectElement;
		// Choice options are indexed; the labels are the families.
    expect([...sel.options].map((o) => o.textContent!.trim())).toEqual(['Inter', 'Lora', 'Menlo']);
		expect(sel.selectedOptions[0]!.textContent!.trim()).toBe('Lora');
		select(sel, '2');
		expect(onchange).toHaveBeenCalledWith('font', 'Menlo', null);
	});
});
