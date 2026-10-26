// Agent playback in the chart editor (see `tools/playback.ts`). Value drags and selections belong
// to the `ChartDirector` (its cursor drags each bar live), so with a director those tools play
// themselves; every other call is acted out on the editor's own controls: the inspector option a
// change sets, the data grid for data edits, the toolbar for rendering and undo. Plans only name
// controls and points; `ChartEditor` finds them (in the chart's scene coordinates).
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { PlaybackRef, PlaybackStep } from '../tools/playback.js';
import { chartPointAnchor } from './presence.js';
import type { ChartScene, ChartSpec } from './types.js';

const click = (ref: PlaybackRef): PlaybackStep[] => [{ type: 'target', ref }, { type: 'press' }, { type: 'release' }];
const control = (id: string): PlaybackRef => ({ kind: 'control', id });

/** A point ref: a series (id or name) and a category (index or label), as the tools take them. */
export function chartPointRef(series: string, category: string | number): PlaybackRef {
	return { kind: 'point', id: JSON.stringify([series, category]) };
}

/** Where a point ref is drawn in `scene` (a small box around its anchor), or null. */
export function locateChartPoint(spec: ChartSpec, scene: ChartScene, ref: PlaybackRef): { x: number; y: number; width: number; height: number } | null {
	if (ref.kind !== 'point') return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(ref.id);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	const [seriesRef, categoryRef] = parsed as [unknown, unknown];
	const series = spec.series.find((s) => s.id === seriesRef) ?? spec.series.find((s) => s.name === seriesRef);
	const index = typeof categoryRef === 'number' ? categoryRef : spec.categories.findIndex((c) => String(c) === String(categoryRef));
	if (!series || index < 0) return null;
	const at = chartPointAnchor(scene, series.id, index);
	return at ? { x: at.x - 6, y: at.y - 6, width: 12, height: 12 } : null;
}

/** The cursor steps for one chart tool call (by bare name), or null to fall back to the ids it names. */
export function planChartToolPlayback(tool: string, args: Record<string, any>): PlaybackStep[] | null {
	switch (tool) {
		case 'update_chart': {
			const steps: PlaybackStep[] = [];
			for (const key of Object.keys(args).slice(0, 4)) {
				steps.push(...click(key === 'type' && typeof args.type === 'string' ? { kind: 'chart-type', id: args.type } : control(key)));
			}
			return steps.length ? steps : null;
		}
		case 'apply_chart_preset':
			return [...(args.layout ? click(control('preset.layout')) : []), ...(args.colors ? click(control('preset.colors')) : [])];
		case 'set_chart_values': {
			const cells = Array.isArray(args.cells) ? (args.cells as Array<{ series?: unknown; category?: unknown }>) : [];
			const steps = cells
				.slice(0, 6)
				.filter((c) => typeof c.series === 'string' && (typeof c.category === 'string' || typeof c.category === 'number'))
				.flatMap((c) => click(chartPointRef(c.series as string, c.category as string | number)));
			return steps.length ? steps : null;
		}
		case 'select_chart_element':
			if (args.kind === 'point' && typeof args.series === 'string' && args.category !== undefined) return click(chartPointRef(args.series, args.category));
			return typeof args.kind === 'string' && args.kind !== 'none' ? click(control(args.kind)) : null;
		case 'set_chart_data':
		case 'import_chart_csv':
		case 'import_chart_mermaid':
		case 'import_chart_ooxml':
		case 'add_chart_series':
		case 'update_chart_series':
		case 'remove_chart_series':
		case 'add_chart_category':
		case 'remove_chart_category':
		case 'transpose_chart':
			return [{ type: 'target', ref: { kind: 'grid', id: 'data' } }];
		case 'add_chart_trendline':
		case 'remove_chart_trendline':
			return click(control('trendline.add'));
		case 'add_chart_reference_line':
		case 'update_chart_reference_line':
		case 'remove_chart_reference_line':
			return click(control('referenceLine.add'));
		case 'add_chart_reference_band':
		case 'update_chart_reference_band':
		case 'remove_chart_reference_band':
			return click(control('referenceBand.add'));
		case 'set_chart_callout':
			if (typeof args.series === 'string' && (typeof args.category === 'string' || typeof args.category === 'number')) return [...click(chartPointRef(args.series, args.category)), ...click(control('series.callout'))];
			return click(control('series.callout'));
		case 'highlight_chart':
			return click(control('highlight'));
		case 'render_chart':
			return [{ type: 'target', ref: { kind: 'action', id: 'download-png' } }];
		case 'undo_chart':
			return click({ kind: 'action', id: 'undo' });
		case 'redo_chart':
			return click({ kind: 'action', id: 'redo' });
		default:
			return null;
	}
}

const DIRECTED = new Set(['set_chart_values', 'select_chart_element']);

/**
 * Gives a chart tool provider agent playback on `surface`. An explicit `surface` wins over the
 * provider's own `playbackSurface`; with neither, it is `chart` (where `ChartEditor` attaches). With a director, value changes and selections play through it (`playback: 'self'`).
 */
export function withChartPlayback(provider: AgentToolProvider, options: { director: boolean; surface?: string }): AgentToolProvider {
	const plan = (tool: AgentTool): AgentTool => {
		if (tool.plan || tool.playback !== undefined) return tool;
		if (options.director && DIRECTED.has(tool.name)) return { ...tool, playback: 'self' };
		return { ...tool, plan: (args) => planChartToolPlayback(tool.name, args) };
	};
	const tools = provider.tools;
	return {
		...provider,
		playbackSurface: options.surface ?? provider.playbackSurface ?? 'chart',
		tools: typeof tools === 'function' ? () => tools().map(plan) : tools.map(plan)
	};
}
