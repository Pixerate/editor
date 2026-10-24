import {
	type ColorScheme,
	type ColorValue,
	contrastRatio,
	deltaEOK,
	formatDualColor,
	inSrgbGamut,
	isDualColor,
	mixColors,
	normalizeColor,
	normalizeDualColor,
	parseColor,
	resolveColor
} from '../color/index.js';
import type { Gradient, GradientInterpolation, GradientStop, GradientType } from './types.js';

function clamp(v: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, v));
}

/** Formula matching gradientMidpointRemap from vector/gradient.ts */
export function gradientMidpointRemap(u: number, m: number): number {
	const mid = clamp(m, 0.05, 0.95);
	if (Math.abs(mid - 0.5) < 1e-6) return u;
	return u <= mid ? (0.5 * u) / mid : 0.5 + (0.5 * (u - mid)) / (1 - mid);
}

/**
 * Normalises an arbitrary gradient input into a validated Gradient object.
 * Returns `{ gradient: Gradient }` or `{ error: string }`.
 */
export function normalizeGradient(input: unknown): { gradient: Gradient } | { error: string } {
	if (typeof input === 'string') {
		const parsed = parseCssGradient(input);
		if (!parsed) {
			return { error: `Could not parse CSS gradient: "${input}".` };
		}
		return { gradient: parsed };
	}

	if (!input || typeof input !== 'object') {
		return { error: 'Gradient must be an object.' };
	}
	const obj = input as Partial<Gradient> & { [key: string]: unknown };

	const type: GradientType =
		obj.type === 'radial' || obj.type === 'conic' ? obj.type : 'linear';

	if (!Array.isArray(obj.stops)) {
		return { error: 'Gradient stops must be an array.' };
	}
	if (obj.stops.length < 2) {
		return { error: `A gradient needs at least 2 stops; it has ${obj.stops.length}.` };
	}

	const usedIds = new Set<string>();
	for (const s of obj.stops) {
		if (s && typeof s === 'object' && typeof (s as any).id === 'string' && (s as any).id.trim()) {
			usedIds.add((s as any).id.trim());
		}
	}

	let nextIdIndex = 1;
	const getNextId = (): string => {
		while (usedIds.has(`s${nextIdIndex}`)) {
			nextIdIndex++;
		}
		const id = `s${nextIdIndex}`;
		usedIds.add(id);
		nextIdIndex++;
		return id;
	};

	const stops: GradientStop[] = [];
	for (let i = 0; i < obj.stops.length; i++) {
		const s = obj.stops[i];
		if (!s || typeof s !== 'object') {
			return { error: `Stop at index ${i} must be an object.` };
		}
		const rawStop = s as Partial<GradientStop> & { [key: string]: unknown };

		// Colour normalisation: support string or { light, dark }
		let normColor: string | null = null;
		if (typeof rawStop.color === 'string' || (rawStop.color && typeof rawStop.color === 'object')) {
			const dual = normalizeDualColor(rawStop.color as any);
			if (dual) {
				normColor = formatDualColor(dual);
			}
		}
		if (!normColor) {
			return { error: `Stop at index ${i} has an invalid colour.` };
		}

		let offset = Number(rawStop.offset);
		if (!Number.isFinite(offset)) {
			// If missing or not finite, distribute evenly as default
			offset = obj.stops.length === 1 ? 0 : i / (obj.stops.length - 1);
		}
		offset = clamp(offset, 0, 1);

		const id = typeof rawStop.id === 'string' && rawStop.id.trim() ? rawStop.id.trim() : getNextId();

		const stop: GradientStop = {
			id,
			offset,
			color: normColor
		};

		if (rawStop.midpoint !== undefined && rawStop.midpoint !== null) {
			const m = Number(rawStop.midpoint);
			if (Number.isFinite(m)) {
				stop.midpoint = clamp(m, 0.05, 0.95);
			}
		}

		stops.push(stop);
	}

	// Stable sort by offset
	stops.sort((a, b) => a.offset - b.offset);

	const gradient: Gradient = {
		type,
		stops
	};

	if (type === 'linear' || type === 'conic') {
		if (obj.angle !== undefined && Number.isFinite(Number(obj.angle))) {
			gradient.angle = ((Number(obj.angle) % 360) + 360) % 360;
		} else {
			gradient.angle = type === 'linear' ? 180 : 0;
		}
	}

	if (type === 'radial' || type === 'conic') {
		if (obj.center && typeof obj.center === 'object') {
			const cx = Number(obj.center.x);
			const cy = Number(obj.center.y);
			gradient.center = {
				x: Number.isFinite(cx) ? clamp(cx, 0, 1) : 0.5,
				y: Number.isFinite(cy) ? clamp(cy, 0, 1) : 0.5
			};
		} else {
			gradient.center = { x: 0.5, y: 0.5 };
		}
	}

	if (type === 'radial') {
		gradient.shape = obj.shape === 'circle' ? 'circle' : 'ellipse';
	}

	const allowedInterp: GradientInterpolation[] = ['srgb', 'srgb-linear', 'oklab', 'oklch'];
	if (obj.interpolation && allowedInterp.includes(obj.interpolation as GradientInterpolation)) {
		gradient.interpolation = obj.interpolation as GradientInterpolation;
	} else {
		gradient.interpolation = 'oklab';
	}

	if (obj.repeating) {
		gradient.repeating = true;
	}

	return { gradient };
}

/**
 * Creates a Gradient with evenly spaced stops from an array of colors or options.
 */
export function createGradient(
	colorsOrOptions?: readonly string[] | (Partial<Gradient> & { stops?: readonly GradientStop[] | readonly string[] }),
	options?: Partial<Omit<Gradient, 'stops'>>
): Gradient {
	if (Array.isArray(colorsOrOptions)) {
		const colors = colorsOrOptions;
		const resolvedColors =
			colors.length >= 2
				? colors
				: colors.length === 1
					? [colors[0], colors[0]]
					: ['#000000', '#ffffff'];

		const stops: GradientStop[] = resolvedColors.map((color, i) => ({
			id: `s${i + 1}`,
			offset: i / (resolvedColors.length - 1),
			color: formatDualColor(normalizeDualColor(color) ?? { light: '#000000', dark: '#000000' })
		}));

		const res = normalizeGradient({
			...options,
			stops
		});
		if ('error' in res) {
			throw new Error(res.error);
		}
		return res.gradient;
	}

	if (colorsOrOptions && typeof colorsOrOptions === 'object' && !Array.isArray(colorsOrOptions)) {
		const raw = colorsOrOptions as Partial<Gradient> & { stops?: readonly GradientStop[] | readonly string[] };
		let stops = raw.stops;
		if (!stops || stops.length === 0) {
			stops = [
				{ id: 's1', offset: 0, color: '#000000' },
				{ id: 's2', offset: 1, color: '#ffffff' }
			];
		} else if (typeof stops[0] === 'string') {
			const strStops = stops as readonly string[];
			stops = strStops.map((color, i) => ({
				id: `s${i + 1}`,
				offset: i / (strStops.length - 1),
				color
			}));
		}
		const res = normalizeGradient({
			...raw,
			stops
		});
		if ('error' in res) {
			throw new Error(res.error);
		}
		return res.gradient;
	}

	// Default: 2 stops (black to white)
	const res = normalizeGradient({
		...options,
		stops: [
			{ id: 's1', offset: 0, color: '#000000' },
			{ id: 's2', offset: 1, color: '#ffffff' }
		]
	});
	if ('error' in res) {
		throw new Error(res.error);
	}
	return res.gradient;
}

/**
 * Helper to check if a colour value represents a dual colour (light-dark string or DualColor object).
 */
export function isDualColorValue(val: unknown): boolean {
	if (typeof val === 'string') {
		return val.trim().toLowerCase().startsWith('light-dark(');
	}
	if (isDualColor(val)) {
		return val.light !== val.dark;
	}
	return false;
}

/**
 * Checks whether any stop in the gradient has a dual colour (`light-dark()`).
 */
export function isDualGradient(g: Gradient): boolean {
	return g.stops.some((s) => isDualColorValue(s.color));
}

/**
 * Resolves a gradient for a specific ColorScheme ('light' or 'dark').
 */
export function resolveGradient(g: Gradient, scheme: ColorScheme): Gradient {
	return {
		...g,
		center: g.center ? { ...g.center } : undefined,
		stops: g.stops.map((s) => ({
			...s,
			color: resolveColor(s.color, scheme) ?? s.color
		}))
	};
}

/**
 * Samples a gradient at t (0–1), returning a hex colour string.
 */
export function sampleGradient(g: Gradient, t: number, scheme: ColorScheme = 'light'): string {
	const resolved = resolveGradient(g, scheme);
	const clampedT = clamp(t, 0, 1);
	const stops = resolved.stops;

	if (clampedT <= stops[0].offset) {
		return stops[0].color;
	}
	if (clampedT >= stops[stops.length - 1].offset) {
		return stops[stops.length - 1].color;
	}

	// Find the segment [i, i+1]
	let i = 0;
	while (i < stops.length - 1 && stops[i + 1].offset < clampedT) {
		i++;
	}
	const s0 = stops[i];
	const s1 = stops[i + 1];

	const span = s1.offset - s0.offset;
	if (span <= 1e-6) {
		return s1.color;
	}

	let u = (clampedT - s0.offset) / span;
	if (s0.midpoint !== undefined) {
		u = gradientMidpointRemap(u, s0.midpoint);
	}

	const mixed = mixColors(s0.color, s1.color, u, { space: g.interpolation ?? 'oklab' });
	return mixed ?? s0.color;
}

/**
 * Inserts a new stop at the given offset.
 * When colour is omitted, samples the gradient at that offset.
 */
export function insertGradientStop(
	g: Gradient,
	offset: number,
	color?: string
): { gradient: Gradient; stop: GradientStop } {
	const clampedOffset = clamp(offset, 0, 1);
	const stopColor = color !== undefined ? color : sampleGradient(g, clampedOffset, 'light');

	// Generate unique id
	const used = new Set(g.stops.map((s) => s.id));
	let idx = 1;
	while (used.has(`s${idx}`)) idx++;
	const id = `s${idx}`;

	const newStop: GradientStop = {
		id,
		offset: clampedOffset,
		color: stopColor
	};

	const stops = [...g.stops, newStop];
	const res = normalizeGradient({ ...g, stops });
	if ('error' in res) throw new Error(res.error);

	const added = res.gradient.stops.find((s) => s.id === id)!;
	return { gradient: res.gradient, stop: added };
}

function listValidIds(g: Gradient): string {
	return g.stops.map((s) => `"${s.id}"`).join(', ');
}

/**
 * Updates a gradient stop by id. Throws sentence error if id not found.
 */
export function updateGradientStop(
	g: Gradient,
	id: string,
	patch: { offset?: number; color?: string; midpoint?: number }
): Gradient {
	const index = g.stops.findIndex((s) => s.id === id);
	if (index === -1) {
		throw new Error(`Stop "${id}" not found. Valid stop IDs are: ${listValidIds(g)}.`);
	}

	const stops = g.stops.map((s, i) => (i === index ? { ...s, ...patch } : s));
	const res = normalizeGradient({ ...g, stops });
	if ('error' in res) throw new Error(res.error);
	return res.gradient;
}

/**
 * Removes a gradient stop by id. Refuses to go below 2 stops.
 */
export function removeGradientStop(g: Gradient, id: string): Gradient {
	if (g.stops.length <= 2) {
		throw new Error('A gradient needs at least 2 stops; add one with add_gradient_stop before removing this one.');
	}
	const index = g.stops.findIndex((s) => s.id === id);
	if (index === -1) {
		throw new Error(`Stop "${id}" not found. Valid stop IDs are: ${listValidIds(g)}.`);
	}

	const stops = g.stops.filter((s) => s.id !== id);
	const res = normalizeGradient({ ...g, stops });
	if ('error' in res) throw new Error(res.error);
	return res.gradient;
}

/**
 * Reverses gradient stops (offsets become 1 - offset, midpoints become 1 - midpoint).
 */
export function reverseGradient(g: Gradient): Gradient {
	const reversedStops: GradientStop[] = g.stops.map((s) => ({
		...s,
		offset: Math.round((1 - s.offset) * 10000) / 10000,
		midpoint: s.midpoint !== undefined ? Math.round((1 - s.midpoint) * 10000) / 10000 : undefined
	}));

	reversedStops.sort((a, b) => a.offset - b.offset);

	return {
		...g,
		center: g.center ? { ...g.center } : undefined,
		stops: reversedStops
	};
}

/**
 * Distributes stops evenly between 0 and 1 while preserving order.
 */
export function distributeGradientStops(g: Gradient): Gradient {
	const n = g.stops.length;
	const distributed = g.stops.map((s, i) => ({
		...s,
		offset: Math.round((i / (n - 1)) * 10000) / 10000
	}));
	return {
		...g,
		center: g.center ? { ...g.center } : undefined,
		stops: distributed
	};
}

/**
 * Formats a percentage cleanly (e.g. 50% or 33.3%).
 */
function formatPercent(fraction: number): string {
	const pct = Math.round(fraction * 1000) / 10;
	return `${pct}%`;
}

/**
 * Formats a Gradient into standard CSS.
 */
export function gradientToCss(g: Gradient): string {
	const prefix = g.repeating ? `repeating-${g.type}-gradient` : `${g.type}-gradient`;
	const parts: string[] = [];

	// Interpolation space: leave out if 'srgb'
	const interpPrefix = g.interpolation && g.interpolation !== 'srgb' ? `in ${g.interpolation} ` : '';

	if (g.type === 'linear') {
		const angle = g.angle !== undefined ? `${g.angle}deg` : '180deg';
		parts.push(`${interpPrefix}${angle}`.trim());
	} else if (g.type === 'radial') {
		const shape = g.shape ?? 'ellipse';
		const cx = g.center ? formatPercent(g.center.x) : '50%';
		const cy = g.center ? formatPercent(g.center.y) : '50%';
		parts.push(`${interpPrefix}${shape} at ${cx} ${cy}`.trim());
	} else if (g.type === 'conic') {
		const angle = g.angle !== undefined ? `from ${g.angle}deg` : 'from 0deg';
		const cx = g.center ? formatPercent(g.center.x) : '50%';
		const cy = g.center ? formatPercent(g.center.y) : '50%';
		parts.push(`${interpPrefix}${angle} at ${cx} ${cy}`.trim());
	}

	for (let i = 0; i < g.stops.length; i++) {
		const s = g.stops[i];
		parts.push(`${s.color} ${formatPercent(s.offset)}`);
		if (s.midpoint !== undefined && i < g.stops.length - 1) {
			const next = g.stops[i + 1];
			const midOffset = s.offset + (next.offset - s.offset) * s.midpoint;
			parts.push(formatPercent(midOffset));
		}
	}

	return `${prefix}(${parts.join(', ')})`;
}

/**
 * Fallback CSS gradient for legacy engines: expanded sRGB stops with no hints and no light-dark.
 */
export function gradientToCssFallback(g: Gradient, steps = 16, scheme: ColorScheme = 'light'): string {
	const prefix = g.repeating ? `repeating-${g.type}-gradient` : `${g.type}-gradient`;
	const parts: string[] = [];

	if (g.type === 'linear') {
		const angle = g.angle !== undefined ? `${g.angle}deg` : '180deg';
		parts.push(angle);
	} else if (g.type === 'radial') {
		const shape = g.shape ?? 'ellipse';
		const cx = g.center ? formatPercent(g.center.x) : '50%';
		const cy = g.center ? formatPercent(g.center.y) : '50%';
		parts.push(`${shape} at ${cx} ${cy}`);
	} else if (g.type === 'conic') {
		const angle = g.angle !== undefined ? `from ${g.angle}deg` : 'from 0deg';
		const cx = g.center ? formatPercent(g.center.x) : '50%';
		const cy = g.center ? formatPercent(g.center.y) : '50%';
		parts.push(`${angle} at ${cx} ${cy}`);
	}

	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const color = sampleGradient(g, t, scheme);
		parts.push(`${color} ${formatPercent(t)}`);
	}

	return `${prefix}(${parts.join(', ')})`;
}

function splitCssArgs(str: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (let i = 0; i < str.length; i++) {
		const char = str[i];
		if (char === '(') depth++;
		else if (char === ')') depth = Math.max(0, depth - 1);
		if (char === ',' && depth === 0) {
			if (current.trim()) parts.push(current.trim());
			current = '';
		} else {
			current += char;
		}
	}
	if (current.trim()) parts.push(current.trim());
	return parts;
}

function parseCssAngle(val: string): number {
	const trimmed = val.trim().toLowerCase();
	if (trimmed.endsWith('deg')) return parseFloat(trimmed);
	if (trimmed.endsWith('turn')) return parseFloat(trimmed) * 360;
	if (trimmed.endsWith('rad')) return (parseFloat(trimmed) * 180) / Math.PI;
	if (trimmed.startsWith('to ')) {
		const dir = trimmed.slice(3).trim();
		if (dir === 'bottom') return 180;
		if (dir === 'top') return 0;
		if (dir === 'right') return 90;
		if (dir === 'left') return 270;
		if (dir === 'bottom right' || dir === 'right bottom') return 135;
		if (dir === 'bottom left' || dir === 'left bottom') return 225;
		if (dir === 'top right' || dir === 'right top') return 45;
		if (dir === 'top left' || dir === 'left top') return 315;
	}
	const n = parseFloat(trimmed);
	return Number.isFinite(n) ? n : 180;
}

/**
 * Parses CSS linear-gradient, radial-gradient, conic-gradient strings.
 * Returns null if invalid or unsupported.
 */
export function parseCssGradient(css: string): Gradient | null {
	if (typeof css !== 'string') return null;
	const trimmed = css.trim();

	const match = trimmed.match(/^(repeating-)?(linear|radial|conic)-gradient\s*\(([\s\S]*)\)$/i);
	if (!match) return null;

	const repeating = Boolean(match[1]);
	const type = match[2].toLowerCase() as GradientType;
	const body = match[3];

	const rawArgs = splitCssArgs(body);
	if (rawArgs.length === 0) return null;

	let angle = type === 'linear' ? 180 : 0;
	let center: { x: number; y: number } | undefined = type !== 'linear' ? { x: 0.5, y: 0.5 } : undefined;
	let shape: 'circle' | 'ellipse' | undefined = type === 'radial' ? 'ellipse' : undefined;
	let interpolation: GradientInterpolation = 'srgb';
	let stopStartIndex = 0;

	let first = rawArgs[0].trim();

	// Check for "in <space>"
	const inMatch = first.match(/^in\s+([a-z0-9-]+)\s*(.*)$/i);
	if (inMatch) {
		const space = inMatch[1].toLowerCase();
		if (space === 'oklab' || space === 'oklch' || space === 'srgb' || space === 'srgb-linear') {
			interpolation = space;
		}
		first = inMatch[2].trim();
		// If first was ONLY "in <space>", we consume the first arg and look at next
		if (!first) {
			stopStartIndex = 1;
			first = rawArgs[1]?.trim() ?? '';
		}
	}

	if (first) {
		if (type === 'linear') {
			if (first.endsWith('deg') || first.endsWith('turn') || first.endsWith('rad') || first.startsWith('to ')) {
				angle = parseCssAngle(first);
				stopStartIndex = stopStartIndex === 0 ? 1 : 2;
			}
		} else if (type === 'radial') {
			if (first.includes('circle') || first.includes('ellipse') || first.includes('at ')) {
				if (first.includes('circle')) shape = 'circle';
				if (first.includes('ellipse')) shape = 'ellipse';
				const atIdx = first.indexOf('at ');
				if (atIdx !== -1) {
					const posParts = first.slice(atIdx + 3).trim().split(/\s+/);
					if (posParts[0]) center = { x: parsePos(posParts[0]), y: posParts[1] ? parsePos(posParts[1]) : parsePos(posParts[0]) };
				}
				stopStartIndex = stopStartIndex === 0 ? 1 : 2;
			}
		} else if (type === 'conic') {
			if (first.includes('from ') || first.includes('at ')) {
				const fromMatch = first.match(/from\s+([0-9.]+(?:deg|turn|rad)?)/i);
				if (fromMatch) angle = parseCssAngle(fromMatch[1]);
				const atIdx = first.indexOf('at ');
				if (atIdx !== -1) {
					const posParts = first.slice(atIdx + 3).trim().split(/\s+/);
					if (posParts[0]) center = { x: parsePos(posParts[0]), y: posParts[1] ? parsePos(posParts[1]) : parsePos(posParts[0]) };
				}
				stopStartIndex = stopStartIndex === 0 ? 1 : 2;
			}
		}
	}

	const stopArgs = rawArgs.slice(stopStartIndex);
	if (stopArgs.length === 0) return null;

	// Parse stop elements and colour hints
	interface ParsedItem {
		kind: 'stop' | 'hint';
		color?: string;
		offset?: number;
	}

	const items: ParsedItem[] = [];
	for (const str of stopArgs) {
		const s = str.trim();
		// Is it a standalone percentage (colour hint)?
		if (/^([0-9.]+)%$/.test(s)) {
			items.push({ kind: 'hint', offset: parseFloat(s) / 100 });
			continue;
		}

		// Split color and optional position
		// Note: color can be light-dark(a, b) or rgb(...) or hex
		// Position is at the end
		const posMatch = s.match(/\s+([0-9.]+)%$/);
		if (posMatch) {
			const colorStr = s.slice(0, posMatch.index).trim();
			const offset = parseFloat(posMatch[1]) / 100;
			items.push({ kind: 'stop', color: colorStr, offset });
		} else {
			items.push({ kind: 'stop', color: s });
		}
	}

	const rawStops = items.filter((it): it is ParsedItem & { kind: 'stop'; color: string } => it.kind === 'stop');
	if (rawStops.length < 2) return null;

	// Assign offsets to stops without positions (spread evenly as CSS does)
	for (let i = 0; i < rawStops.length; i++) {
		if (rawStops[i].offset === undefined) {
			if (i === 0) rawStops[i].offset = 0;
			else if (i === rawStops.length - 1) rawStops[i].offset = 1;
			else {
				// Find next with defined offset
				let nextIdx = i + 1;
				while (nextIdx < rawStops.length && rawStops[nextIdx].offset === undefined) {
					nextIdx++;
				}
				const nextOffset = nextIdx < rawStops.length ? rawStops[nextIdx].offset! : 1;
				const prevOffset = rawStops[i - 1].offset ?? 0;
				const count = nextIdx - (i - 1);
				for (let k = i; k < nextIdx; k++) {
					rawStops[k].offset = prevOffset + ((k - (i - 1)) / count) * (nextOffset - prevOffset);
				}
				i = nextIdx - 1;
			}
		}
	}

	// Pair hints with previous stop as midpoint
	const finalStops: GradientStop[] = [];
	let stopIdx = 0;
	for (let i = 0; i < items.length; i++) {
		const it = items[i];
		if (it.kind === 'stop') {
			const stop: GradientStop = {
				id: `s${stopIdx + 1}`,
				offset: clamp(it.offset ?? 0, 0, 1),
				color: it.color!
			};
			// Check if next item is a hint
			if (i + 1 < items.length && items[i + 1].kind === 'hint') {
				const hintOffset = items[i + 1].offset!;
				const nextStopItem = items.slice(i + 2).find((x) => x.kind === 'stop');
				if (nextStopItem && nextStopItem.offset !== undefined) {
					const span = nextStopItem.offset - stop.offset;
					if (span > 0) {
						stop.midpoint = clamp((hintOffset - stop.offset) / span, 0.05, 0.95);
					}
				}
			}
			finalStops.push(stop);
			stopIdx++;
		}
	}

	const res = normalizeGradient({
		type,
		angle,
		center,
		shape,
		interpolation,
		repeating,
		stops: finalStops
	});

	return 'gradient' in res ? res.gradient : null;
}

function parsePos(str: string): number {
	const s = str.trim();
	if (s.endsWith('%')) return clamp(parseFloat(s) / 100, 0, 1);
	const val = parseFloat(s);
	return Number.isFinite(val) ? clamp(val, 0, 1) : 0.5;
}

/**
 * Generates an SVG `<linearGradient>` or `<radialGradient>` element string with sampled stops.
 */
export function gradientToSvgDef(g: Gradient, id: string, scheme: ColorScheme = 'light'): string {
	const steps = 32;
	const stopsXml: string[] = [];
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const color = sampleGradient(g, t, scheme);
		stopsXml.push(`\t\t<stop offset="${formatPercent(t)}" stop-color="${color}" />`);
	}

	if (g.type === 'radial') {
		const cx = g.center ? formatPercent(g.center.x) : '50%';
		const cy = g.center ? formatPercent(g.center.y) : '50%';
		const r = g.shape === 'circle' ? '50%' : '70.7%';
		return `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}">\n${stopsXml.join('\n')}\n</radialGradient>`;
	}

	if (g.type === 'conic') {
		// Linear fallback with comment
		return `<!-- Note: SVG does not natively support conic gradients; rendering as linear fallback -->\n<linearGradient id="${id}" x1="0%" y1="0%" x2="100%" y2="0%">\n${stopsXml.join('\n')}\n</linearGradient>`;
	}

	// Linear
	const angle = g.angle ?? 180;
	const rad = ((90 - angle) * Math.PI) / 180;
	const dx = Math.cos(rad);
	const dy = -Math.sin(rad);
	const x1 = formatPercent(0.5 - dx * 0.5);
	const y1 = formatPercent(0.5 - dy * 0.5);
	const x2 = formatPercent(0.5 + dx * 0.5);
	const y2 = formatPercent(0.5 + dy * 0.5);

	return `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">\n${stopsXml.join('\n')}\n</linearGradient>`;
}

/**
 * Checks a gradient for issues (too close, out of sRGB, banding) and lowest text contrast.
 */
export function checkGradient(
	g: Gradient,
	options: { surface?: ColorValue; text?: ColorValue } = {}
): {
	issues: string[];
	lowestTextContrast?: number | { light: number; dark: number };
} {
	const dual = isDualGradient(g) || isDualColor(options.surface as any) || isDualColor(options.text as any);

	if (dual) {
		const lightG = resolveGradient(g, 'light');
		const darkG = resolveGradient(g, 'dark');
		const lightText = options.text ? resolveColor(options.text as any, 'light') ?? undefined : undefined;
		const darkText = options.text ? resolveColor(options.text as any, 'dark') ?? undefined : undefined;

		const checkScheme = (grad: Gradient, txt: string | undefined, schemeName: string) => {
			const issues: string[] = [];
			for (let i = 0; i < grad.stops.length - 1; i++) {
				const gap = grad.stops[i + 1].offset - grad.stops[i].offset;
				if (gap < 0.005) {
					issues.push(`[${schemeName}] Stops "${grad.stops[i].id}" and "${grad.stops[i + 1].id}" are too close (gap < 0.005).`);
				}
				const c1 = parseColor(grad.stops[i].color);
				const c2 = parseColor(grad.stops[i + 1].color);
				if (c1 && c2 && gap < 0.05) {
					const dE = deltaEOK(c1, c2);
					if (dE > 0.5) {
						issues.push(
							`[${schemeName}] Banding risk between stops "${grad.stops[i].id}" and "${grad.stops[i + 1].id}" (ΔEOK = ${dE.toFixed(2)} across gap ${gap.toFixed(3)}).`
						);
					}
				}
			}
			for (const s of grad.stops) {
				const c = parseColor(s.color);
				if (c && !inSrgbGamut(c)) {
					issues.push(`[${schemeName}] Stop "${s.id}" colour ${s.color} is outside standard sRGB gamut.`);
				}
			}
			let lowest: number | undefined;
			if (txt) {
				const parsedTxt = parseColor(txt);
				if (parsedTxt) {
					let minRatio = Infinity;
					for (let step = 0; step <= 32; step++) {
						const sample = parseColor(sampleGradient(grad, step / 32, schemeName as ColorScheme));
						if (sample) {
							const r = contrastRatio(parsedTxt, sample);
							if (r < minRatio) minRatio = r;
						}
					}
					lowest = Math.round(minRatio * 100) / 100;
				}
			}
			return { issues, lowest };
		};

		const lRes = checkScheme(lightG, lightText, 'light');
		const dRes = checkScheme(darkG, darkText, 'dark');

		return {
			issues: [...lRes.issues, ...dRes.issues],
			lowestTextContrast:
				lRes.lowest !== undefined && dRes.lowest !== undefined
					? { light: lRes.lowest, dark: dRes.lowest }
					: undefined
		};
	}

	// Single scheme (light)
	const issues: string[] = [];
	for (let i = 0; i < g.stops.length - 1; i++) {
		const gap = g.stops[i + 1].offset - g.stops[i].offset;
		if (gap < 0.005) {
			issues.push(`Stops "${g.stops[i].id}" and "${g.stops[i + 1].id}" are too close (gap < 0.005).`);
		}
		const c1 = parseColor(g.stops[i].color);
		const c2 = parseColor(g.stops[i + 1].color);
		if (c1 && c2 && gap < 0.05) {
			const dE = deltaEOK(c1, c2);
			if (dE > 0.5) {
				issues.push(
					`Banding risk between stops "${g.stops[i].id}" and "${g.stops[i + 1].id}" (ΔEOK = ${dE.toFixed(2)} across gap ${gap.toFixed(3)}).`
				);
			}
		}
	}
	for (const s of g.stops) {
		const c = parseColor(s.color);
		if (c && !inSrgbGamut(c)) {
			issues.push(`Stop "${s.id}" colour ${s.color} is outside standard sRGB gamut.`);
		}
	}

	let lowestTextContrast: number | undefined;
	if (options.text) {
		const parsedTxt = parseColor(options.text as any);
		if (parsedTxt) {
			let minRatio = Infinity;
			for (let step = 0; step <= 32; step++) {
				const sample = parseColor(sampleGradient(g, step / 32, 'light'));
				if (sample) {
					const r = contrastRatio(parsedTxt, sample);
					if (r < minRatio) minRatio = r;
				}
			}
			lowestTextContrast = Math.round(minRatio * 100) / 100;
		}
	}

	return { issues, lowestTextContrast };
}

export const GRADIENT_PRESETS: Readonly<Record<string, Gradient>> = Object.freeze({
	sunset: {
		type: 'linear',
		angle: 90,
		interpolation: 'oklab',
		stops: [
			{ id: 's1', offset: 0, color: '#f97316' },
			{ id: 's2', offset: 1, color: '#ec4899' }
		]
	},
	ocean: {
		type: 'linear',
		angle: 180,
		interpolation: 'oklab',
		stops: [
			{ id: 's1', offset: 0, color: '#06b6d4' },
			{ id: 's2', offset: 1, color: '#3b82f6' }
		]
	},
	'mono-fade': {
		type: 'linear',
		angle: 180,
		interpolation: 'oklab',
		stops: [
			{ id: 's1', offset: 0, color: '#ffffff' },
			{ id: 's2', offset: 1, color: '#000000' }
		]
	},
	'transparent-fade': {
		type: 'linear',
		angle: 180,
		interpolation: 'oklab',
		stops: [
			{ id: 's1', offset: 0, color: '#000000ff' },
			{ id: 's2', offset: 1, color: '#00000000' }
		]
	},
	aurora: {
		type: 'linear',
		angle: 135,
		interpolation: 'oklab',
		stops: [
			{ id: 's1', offset: 0, color: '#10b981' },
			{ id: 's2', offset: 0.5, color: '#06b6d4' },
			{ id: 's3', offset: 1, color: '#8b5cf6' }
		]
	},
	neon: {
		type: 'linear',
		angle: 90,
		interpolation: 'oklab',
		stops: [
			{ id: 's1', offset: 0, color: '#f43f5e' },
			{ id: 's2', offset: 1, color: '#8b5cf6' }
		]
	},
	radial: {
		type: 'radial',
		shape: 'ellipse',
		center: { x: 0.5, y: 0.5 },
		interpolation: 'oklab',
		stops: [
			{ id: 's1', offset: 0, color: '#ffffff' },
			{ id: 's2', offset: 1, color: '#000000' }
		]
	},
	conic: {
		type: 'conic',
		angle: 0,
		center: { x: 0.5, y: 0.5 },
		interpolation: 'oklab',
		stops: [
			{ id: 's1', offset: 0, color: '#f43f5e' },
			{ id: 's2', offset: 0.33, color: '#eab308' },
			{ id: 's3', offset: 0.66, color: '#06b6d4' },
			{ id: 's4', offset: 1, color: '#f43f5e' }
		]
	}
});
