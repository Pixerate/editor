import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs build script without declarations.
import { buildPageKit } from '../scripts/build-page-kit.mjs';
import { PAGE_KIT, PAGE_KIT_FILES, PAGE_KIT_GUIDE, PAGE_KIT_HASH, PAGE_KIT_VERSION } from '../src/page-kit/index.js';

/** Runs the kit in a fresh jsdom page (scripts run only as we evaluate them; nothing is fetched). */
function page(html = '<!doctype html><html><body><div data-picture id="pic" style="width:400px;height:200px"></div></body></html>') {
	const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
	const w = dom.window as unknown as Window & typeof globalThis & { pixerateKit: any; pageMotion?: any; eval(code: string): unknown };
	w.eval(PAGE_KIT);
	return { dom, window: w, kit: w.pixerateKit };
}

/** Names the guide documents: the backticked first cell of each table row, before any `(`. */
function documentedNames(guide: string): string[] {
	const names: string[] = [];
	for (const line of guide.split('\n')) {
		const cell = /^\| (`[^|]+`) \|/.exec(line);
		if (!cell || line.startsWith('| Helper')) continue;
		for (const m of cell[1].matchAll(/`([\w.]+)/g)) names.push(m[1]);
	}
	return names;
}

/** Names the kit exports: top-level keys, and `theme.*` / `ease.*` members. */
function exportedNames(kit: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const [key, value] of Object.entries(kit)) {
		if (key === 'theme' || key === 'ease') for (const sub of Object.keys(value as object)) out.push(`${key}.${sub}`);
		else out.push(key);
	}
	return out;
}

describe('page kit bundle', () => {
	it('is built from the current sources, the same way every time', async () => {
		const a = await buildPageKit();
		const b = await buildPageKit();
		expect(a.source).toBe(b.source);
		expect(readFileSync(join(__dirname, '../src/page-kit/bundle.generated.ts'), 'utf8'), 'run node scripts/build-page-kit.mjs').toBe(a.source);
		expect(PAGE_KIT_HASH).toBe(a.hash);
	});

	it('stays under its size budget and carries its version', () => {
		expect(Buffer.byteLength(PAGE_KIT)).toBeLessThan(60_000);
		expect(PAGE_KIT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
		expect(PAGE_KIT).toContain(PAGE_KIT_VERSION);
		expect(PAGE_KIT_FILES).toEqual({ 'kit.js': PAGE_KIT, 'kit.md': PAGE_KIT_GUIDE });
	});

	it('loads nothing: no network, dynamic import, workers or eval', () => {
		for (const banned of ['fetch(', 'XMLHttpRequest', 'import(', 'new Worker', 'WebSocket', 'eval(', 'new Function', 'importScripts']) expect(PAGE_KIT, banned).not.toContain(banned);
		expect(PAGE_KIT).not.toContain('</script');
	});

	it('documents every export, and nothing else', () => {
		const { kit } = page();
		const documented = documentedNames(PAGE_KIT_GUIDE).sort();
		const exported = exportedNames(kit).sort();
		expect([...new Set(documented)]).toEqual(exported);
	});
});

describe('page kit in a page', () => {
	it('sets window.pixerateKit with the geometry helpers', () => {
		const { kit } = page();
		expect(kit.version).toBe(PAGE_KIT_VERSION);
		const placed = kit.placeLabels([{ anchor: { x: 50, y: 50 }, width: 30, height: 10 }], { obstacles: [{ point: { x: 50, y: 40 } }] });
		expect(placed).toHaveLength(1);
		expect(placed[0].ok).toBe(true);
		expect(kit.labelHull([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }, { x: 5, y: 1 }])).toHaveLength(3);
		const iso = kit.isoProjector({ scale: 10 });
		expect(iso.point(1, 0, 0).x).toBeCloseTo(10 * Math.cos(Math.PI / 6), 9);
		expect(kit.isoOrder([{ i0: 0, i1: 1, j0: 0, j1: 1, k0: 0, k1: 1 }, { i0: 2, i1: 3, j0: 2, j1: 3, k0: 0, k1: 1 }], iso)).toEqual([0, 1]);
		expect(kit.isoFaceColors('#336699').top).toBe('#336699');
		expect(kit.elbow({ x: 0, y: 0 }, { x: 100, y: 80 }, { level: 30, radius: 10 }).d).toBe('M0 0L0 20A10 10 0 0 0 10 30L90 30A10 10 0 0 1 100 40L100 80');
		expect(kit.fanElbows({ x: 0, y: 0 }, [{ x: -50, y: 100 }, { x: 50, y: 100 }]).elbows).toHaveLength(2);
		expect(kit.roundedPolyline([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }], 4).segments.map((s: any) => s.kind)).toEqual(['line', 'arc', 'line']);
		const h = kit.helix([{ x: 0, y: 0 }, { x: 0, y: 100 }], { amplitude: 10, turns: 1, samples: 4 });
		expect(h.points).toHaveLength(5);
		expect(kit.splitByDepth(h.points, h.depth).map((r: any) => r.front)).toEqual([true, false, true]);
	});

	it('measures and trims paths', () => {
		const { kit } = page();
		expect(kit.pathLength('M0 0L30 40')).toBe(50);
		expect(kit.pointAtLength('M0 0L30 40', 25)).toMatchObject({ x: 15, y: 20 });
		expect(kit.pointAtLength('', 1)).toBeNull();
		expect(kit.trimPath('M0 0L100 0M0 10L100 10', 50, 150)).toBe('M50 0L100 0M0 10L50 10');
	});

	it('fits text and staggers rows, measuring with an estimate or a canvas', () => {
		const { kit } = page();
		const measure = kit.estimatedMeasure('monospace');
		expect(kit.fitText(['category'], 72, { measure })).toEqual({ size: 15, letterSpacing: 0, fits: true, word: 'category' });
		expect(kit.staggerRows(['alpha', 'gamma', 'beta'], [0, 50, 25], { measure, size: 10 }).count).toBe(2);
		// jsdom has no 2-D canvas, so canvasMeasure falls back to the estimate.
		expect(kit.canvasMeasure('600 Inter, sans-serif')('abcd', 10, 0)).toBe(20);
	});

	it('reads colours, numbers and scales', () => {
		const { kit } = page();
		expect(kit.contrast('#000', '#fff')).toBeCloseTo(21, 6);
		expect(kit.contrast('nope', '#fff')).toBeNull();
		expect(kit.ink('#ffff00')).toBe('#111111');
		expect(kit.ink('#000080')).toBe('#ffffff');
		expect(kit.mix('#000000', '#ffffff', 0)).toBe('#000000');
		const ramp = kit.ramp('#000000', '#ffffff', 3);
		expect(ramp).toHaveLength(3);
		expect([ramp[0], ramp[2]]).toEqual(['#000000', '#ffffff']);
		expect(kit.hex('rgb(255 0 0)')).toBe('#ff0000');
		expect(kit.niceScale(3, 97, 5)).toMatchObject({ min: 0, max: 100, step: 20 });
		expect(kit.niceStep(100, 5)).toBe(20);
		expect(kit.linearMap(5, [0, 10], [0, 200])).toBe(100);
		expect(kit.formatNumber(1234.5)).toBe('1,234.5');
		expect(kit.formatNumber(0.256, { style: 'percent' })).toBe('25.6%');
		expect(kit.formatNumber(1_200_000, { style: 'compact' })).toBe('1.2M');
		expect(kit.formatNumber(Number.NaN)).toBe('');
	});

	it('builds SVG, clears it and redraws on resize', () => {
		const { kit, window } = page();
		const pic = window.document.getElementById('pic')!;
		const root = kit.svg('svg', { width: 100, height: 50, hidden: false, role: 'img' }, pic);
		const text = kit.svg('text', { x: 1, text: 'Hello', 'data-x': null }, root);
		expect(root.namespaceURI).toBe('http://www.w3.org/2000/svg');
		expect(root.hasAttribute('hidden')).toBe(false);
		expect(text.textContent).toBe('Hello');
		expect(text.hasAttribute('data-x')).toBe(false);
		expect(kit.clear(root).childNodes.length).toBe(0);
		const sizes: number[][] = [];
		const stop = kit.onResize(pic, (w: number, h: number) => sizes.push([w, h]));
		expect(sizes).toHaveLength(1);
		expect(typeof stop).toBe('function');
		stop();
	});

	it('reads the host theme and redraws when it changes', () => {
		const { kit, window } = page();
		const html = window.document.documentElement;
		expect(kit.theme.mode()).toBe('light');
		html.setAttribute('data-theme', 'dark');
		html.style.setProperty('--sui-ink', '#eeeeee');
		expect(kit.theme.mode()).toBe('dark');
		expect(kit.theme.token('--sui-ink', '#000')).toBe('#eeeeee');
		expect(kit.theme.token('sui-ink')).toBe('#eeeeee');
		expect(kit.theme.token('--missing', '#123456')).toBe('#123456');
		const seen: string[] = [];
		const stop = kit.theme.onChange((mode: string) => seen.push(mode));
		window.dispatchEvent(new window.Event('pixerate:theme'));
		stop();
		window.dispatchEvent(new window.Event('pixerate:theme'));
		expect(seen).toEqual(['dark']);
	});

	it('registers frame-pure motion for the host: rest state first, seek clamps, play shows rest when hidden or reduced', () => {
		const { kit, window } = page();
		const drawn: number[] = [];
		const motion = kit.defineMotion((p: number) => drawn.push(p), { duration: 800 });
		expect(window.pageMotion).toBe(motion);
		expect(motion.duration).toBe(800);
		expect(drawn).toEqual([1]);
		motion.seek(0.25);
		motion.seek(2);
		motion.seek(Number.NaN);
		expect(drawn).toEqual([1, 0.25, 1, 1]);
		// jsdom has no matchMedia; a hidden page shows the rest state instead of animating.
		Object.defineProperty(window.document, 'visibilityState', { value: 'hidden', configurable: true });
		motion.play();
		expect(drawn[drawn.length - 1]).toBe(1);
		// A redraw defines the motion again and keeps the frame last shown.
		motion.seek(0.4);
		const again: number[] = [];
		const redrawn = kit.defineMotion((p: number) => again.push(p), { duration: 800 });
		expect(again).toEqual([0.4]);
		expect(redrawn.progress).toBe(0.4);
		expect(window.pageMotion).toBe(redrawn);
		const named = kit.defineMotion(() => {}, { name: 'ridgeMotion', duration: 0 });
		expect((window as any).ridgeMotion).toBe(named);
	});

	it('plays from 0 to 1 when visible', async () => {
		const { kit, window } = page();
		Object.defineProperty(window.document, 'visibilityState', { value: 'visible', configurable: true });
		const drawn: number[] = [];
		const motion = kit.defineMotion((p: number) => drawn.push(p), { duration: 30 });
		motion.play();
		expect(drawn.slice(0, 2)).toEqual([1, 0]);
		expect(motion.playing).toBe(true);
		// A redraw mid-play carries on from the same progress.
		const after: number[] = [];
		const redrawn = kit.defineMotion((p: number) => after.push(p), { duration: 30 });
		expect(motion.playing).toBe(false);
		expect(redrawn.playing).toBe(true);
		expect(after[0]).toBe(drawn[drawn.length - 1]);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(after[after.length - 1]).toBe(1);
		expect(redrawn.playing).toBe(false);
		expect(after.every((p) => p >= 0 && p <= 1)).toBe(true);
		redrawn.stop();
	});

	it('eases and phases', () => {
		const { kit } = page();
		for (const name of ['linear', 'in', 'out', 'inOut']) {
			expect(kit.ease[name](0)).toBe(0);
			expect(kit.ease[name](1)).toBe(1);
		}
		expect(kit.phase(0.1, 0.2, 0.6)).toBe(0);
		expect(kit.phase(0.7, 0.2, 0.6)).toBe(1);
		expect(kit.phase(0.4, 0.2, 0.6, kit.ease.linear)).toBeCloseTo(0.5, 12);
	});
});
