// `<title>` and `<desc>` on exported SVG follow vectorcraft-main/crates/svg/src/export.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { layoutChart, type ChartLayoutOptions } from './layout.js';
import { describeChart } from './summary.js';
import type { ChartMark, ChartScene, ChartSpec, ChartTextMark } from './types.js';

/** SVG `dominant-baseline` for a text mark's baseline (shared by every renderer). */
export function chartTextBaseline(baseline: ChartTextMark['baseline']): 'hanging' | 'central' | 'text-after-edge' {
	return baseline === 'top' ? 'hanging' : baseline === 'middle' ? 'central' : 'text-after-edge';
}

/** SVG `transform` for a rotated text mark, if any. */
export function chartTextTransform(mark: ChartTextMark): string | undefined {
	return mark.rotate ? `rotate(${mark.rotate} ${mark.x} ${mark.y})` : undefined;
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A mark as an SVG tag name, its attributes (unset ones dropped) and its text. */
function markParts(mark: ChartMark, fontFamily: string): { tag: string; attrs: Record<string, string>; text?: string } {
	const common = { opacity: mark.opacity, 'data-role': mark.role };
	const parts = (tag: string, values: Record<string, string | number | undefined>, text?: string) => ({
		tag,
		attrs: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])),
		text
	});
	switch (mark.kind) {
		case 'rect':
			return parts('rect', { x: mark.x, y: mark.y, width: mark.width, height: mark.height, rx: mark.radius, fill: mark.fill, stroke: mark.stroke, 'stroke-width': mark.strokeWidth, ...common });
		case 'path':
			return parts('path', { d: mark.d, fill: mark.fill ?? 'none', stroke: mark.stroke, 'stroke-width': mark.strokeWidth, 'stroke-dasharray': mark.dash, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', ...common });
		case 'circle':
			return parts('circle', { cx: mark.cx, cy: mark.cy, r: mark.r, fill: mark.fill, stroke: mark.stroke, 'stroke-width': mark.strokeWidth, ...common });
		case 'line':
			return parts('line', { x1: mark.x1, y1: mark.y1, x2: mark.x2, y2: mark.y2, stroke: mark.stroke, 'stroke-width': mark.strokeWidth, 'stroke-dasharray': mark.dash, ...common });
		case 'text':
			return parts(
				'text',
				{
					x: mark.x,
					y: mark.y,
					'text-anchor': mark.anchor,
					'dominant-baseline': chartTextBaseline(mark.baseline),
					'font-size': mark.size,
					'font-weight': mark.weight,
					'font-family': fontFamily,
					fill: mark.fill,
					transform: chartTextTransform(mark),
					...common
				},
				mark.text
			);
	}
}

function markToSvg(mark: ChartMark, fontFamily: string): string {
	const { tag, attrs, text } = markParts(mark, fontFamily);
	const attrText = Object.entries(attrs)
		.map(([k, v]) => ` ${k}="${escape(v)}"`)
		.join('');
	return text === undefined ? `<${tag}${attrText}/>` : `<${tag}${attrText}>${escape(text)}</${tag}>`;
}

export interface ChartSvgOptions {
	/** Leave out selection outlines (default `true`: exports show the chart only). */
	hideSelection?: boolean;
	/** Accessible title (default: the chart title). */
	ariaLabel?: string;
	/** A longer description written as `<desc>` (`chartToSvg` defaults to `describeChart`). */
	description?: string;
}

/** Writes a laid-out scene as a standalone SVG document string. */
export function chartSceneToSvg(scene: ChartScene, options: ChartSvgOptions = {}): string {
	const hide = options.hideSelection ?? true;
	const font = scene.theme.fontFamily;
	const body = scene.marks
		.filter((m) => !(hide && m.role === 'selection'))
		.map((m) => markToSvg(m, font))
		.join('');
	const label = options.ariaLabel;
	const desc = options.description;
	const labelled = [label ? 'chart-title' : '', desc ? 'chart-desc' : ''].filter(Boolean).join(' ');
	const head = `${label ? `<title id="chart-title">${escape(label)}</title>` : ''}${desc ? `<desc id="chart-desc">${escape(desc)}</desc>` : ''}`;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}" role="img"${label ? ` aria-label="${escape(label)}"` : ''}${labelled ? ` aria-labelledby="${labelled}"` : ''}>${head}${body}</svg>`;
}

/** Lays out and writes a chart as SVG, e.g. for export or server rendering. */
export function chartToSvg(spec: ChartSpec, options: Omit<ChartLayoutOptions, 'selection'> & ChartSvgOptions): string {
	const scene = layoutChart(spec, { ...options, selection: null });
	return chartSceneToSvg(scene, { ...options, ariaLabel: options.ariaLabel ?? (spec.title || undefined), description: options.description ?? describeChart(spec) });
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A ProseMirror / TipTap `DOMOutputSpec` array (kept structural so this module needs no TipTap types). */
export type ChartDomSpec = [string, Record<string, string>, ...(ChartDomSpec | string)[]];

/**
 * Writes a laid-out scene as a ProseMirror `DOMOutputSpec` (SVG-namespaced tags), so a
 * TipTap node's `renderHTML` can draw a chart without parsing an SVG string. Same output
 * as `chartSceneToSvg`.
 */
export function chartSceneToDomSpec(scene: ChartScene, options: ChartSvgOptions & { attrs?: Record<string, string> } = {}): ChartDomSpec {
	const hide = options.hideSelection ?? true;
	const font = scene.theme.fontFamily;
	const tag = (name: string) => `${SVG_NS} ${name}`;
	const children: ChartDomSpec[] = [];
	if (options.ariaLabel) children.push([tag('title'), {}, options.ariaLabel]);
	if (options.description) children.push([tag('desc'), {}, options.description]);
	for (const mark of scene.marks) {
		if (hide && mark.role === 'selection') continue;
		const { tag: name, attrs, text } = markParts(mark, font);
		children.push(text === undefined ? [tag(name), attrs] : [tag(name), attrs, text]);
	}
	const attrs: Record<string, string> = {
		width: String(scene.width),
		height: String(scene.height),
		viewBox: `0 0 ${scene.width} ${scene.height}`,
		role: 'img',
		...(options.ariaLabel ? { 'aria-label': options.ariaLabel } : {}),
		...options.attrs
	};
	return [tag('svg'), attrs, ...children];
}
