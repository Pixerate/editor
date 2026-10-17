import { layoutChart, type ChartLayoutOptions } from './layout.js';
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

function attrs(values: Record<string, string | number | undefined>): string {
	return Object.entries(values)
		.filter(([, v]) => v !== undefined && v !== '')
		.map(([k, v]) => ` ${k}="${escape(String(v))}"`)
		.join('');
}

function markToSvg(mark: ChartMark, fontFamily: string): string {
	const common = { opacity: mark.opacity, 'data-role': mark.role };
	switch (mark.kind) {
		case 'rect':
			return `<rect${attrs({ x: mark.x, y: mark.y, width: mark.width, height: mark.height, rx: mark.radius, fill: mark.fill, stroke: mark.stroke, 'stroke-width': mark.strokeWidth, ...common })}/>`;
		case 'path':
			return `<path${attrs({ d: mark.d, fill: mark.fill ?? 'none', stroke: mark.stroke, 'stroke-width': mark.strokeWidth, 'stroke-dasharray': mark.dash, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', ...common })}/>`;
		case 'circle':
			return `<circle${attrs({ cx: mark.cx, cy: mark.cy, r: mark.r, fill: mark.fill, stroke: mark.stroke, 'stroke-width': mark.strokeWidth, ...common })}/>`;
		case 'line':
			return `<line${attrs({ x1: mark.x1, y1: mark.y1, x2: mark.x2, y2: mark.y2, stroke: mark.stroke, 'stroke-width': mark.strokeWidth, 'stroke-dasharray': mark.dash, ...common })}/>`;
		case 'text':
			return `<text${attrs({
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
			})}>${escape(mark.text)}</text>`;
	}
}

export interface ChartSvgOptions {
	/** Leave out selection outlines (default `true`: exports show the chart only). */
	hideSelection?: boolean;
	/** Accessible title (default: the chart title). */
	ariaLabel?: string;
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
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}" role="img"${label ? ` aria-label="${escape(label)}"` : ''}>${body}</svg>`;
}

/** Lays out and writes a chart as SVG, e.g. for export or server rendering. */
export function chartToSvg(spec: ChartSpec, options: Omit<ChartLayoutOptions, 'selection'> & ChartSvgOptions): string {
	const scene = layoutChart(spec, { ...options, selection: null });
	return chartSceneToSvg(scene, { ...options, ariaLabel: options.ariaLabel ?? (spec.title || undefined) });
}
