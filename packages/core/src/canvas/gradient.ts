/**
 * Canvas gradient models, parsing, presets, and SVG defs generation.
 * Supports linear and radial gradients for shape fills, strokes, and freehand drawing.
 */

export interface GradientStop {
	offset: number; // 0 to 1
	color: string;
	opacity?: number;
}

export interface CanvasLinearGradient {
	type: 'linear';
	angle?: number; // degrees clockwise, default 90 (top-to-bottom) or custom
	stops: GradientStop[];
}

export interface CanvasRadialGradient {
	type: 'radial';
	cx?: number; // 0 to 1 (default 0.5)
	cy?: number; // 0 to 1 (default 0.5)
	r?: number; // 0 to 1 (default 0.5)
	stops: GradientStop[];
}

export type CanvasGradientDef = CanvasLinearGradient | CanvasRadialGradient;

export interface SvgGradientStop {
	offset: string;
	stopColor: string;
	stopOpacity?: number;
}

export interface SvgGradientDef {
	id: string;
	type: 'linear' | 'radial';
	attrs: Record<string, string | number>;
	stops: SvgGradientStop[];
}

export const PIXERATE_BRAND_GRADIENT: CanvasLinearGradient = {
	type: 'linear',
	angle: 135,
	stops: [
		{ offset: 0, color: '#8E51FF' },
		{ offset: 1, color: '#e12afb' }
	]
};

export const CANVAS_GRADIENT_PRESETS: Record<string, CanvasLinearGradient> = {
	pixerate: PIXERATE_BRAND_GRADIENT,
	sunset: {
		type: 'linear',
		angle: 90,
		stops: [
			{ offset: 0, color: '#f97316' },
			{ offset: 1, color: '#ec4899' }
		]
	},
	ocean: {
		type: 'linear',
		angle: 90,
		stops: [
			{ offset: 0, color: '#06b6d4' },
			{ offset: 1, color: '#3b82f6' }
		]
	},
	aurora: {
		type: 'linear',
		angle: 90,
		stops: [
			{ offset: 0, color: '#10b981' },
			{ offset: 1, color: '#6366f1' }
		]
	},
	neon: {
		type: 'linear',
		angle: 90,
		stops: [
			{ offset: 0, color: '#a855f7' },
			{ offset: 1, color: '#ec4899' }
		]
	},
	amber: {
		type: 'linear',
		angle: 90,
		stops: [
			{ offset: 0, color: '#f59e0b' },
			{ offset: 1, color: '#ef4444' }
		]
	},
	cosmic: {
		type: 'linear',
		angle: 90,
		stops: [
			{ offset: 0, color: '#3b82f6' },
			{ offset: 0.5, color: '#8b5cf6' },
			{ offset: 1, color: '#ec4899' }
		]
	}
};

/** Whether an arbitrary value matches a CanvasGradientDef object. */
export function isCanvasGradient(value: unknown): value is CanvasGradientDef {
	if (!value || typeof value !== 'object') return false;
	const val = value as Partial<CanvasGradientDef>;
	if (val.type !== 'linear' && val.type !== 'radial') return false;
	if (!Array.isArray(val.stops)) return false;
	return true;
}

/**
 * Splits CSS function arguments respecting nested parentheses.
 * e.g. "rgba(255, 0, 0, 0.5) 0%, #00f 100%" -> ["rgba(255, 0, 0, 0.5) 0%", "#00f 100%"]
 */
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

/** Parses CSS angle strings like "90deg", "0.25turn", "1.57rad" or named directions like "to bottom" */
function parseCssAngle(val: string): number {
	const trimmed = val.trim().toLowerCase();
	if (trimmed.endsWith('deg')) {
		return parseFloat(trimmed);
	}
	if (trimmed.endsWith('turn')) {
		return parseFloat(trimmed) * 360;
	}
	if (trimmed.endsWith('rad')) {
		return (parseFloat(trimmed) * 180) / Math.PI;
	}
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
 * Parses CSS linear-gradient or radial-gradient strings into CanvasGradientDef.
 * Supports forms like:
 * - linear-gradient(90deg, #ff0000 0%, #0000ff 100%)
 * - linear-gradient(to right, red, blue)
 * - radial-gradient(circle, red 0%, blue 100%)
 */
export function parseCssGradient(css: string): CanvasGradientDef | null {
	const trimmed = css.trim();
	const linearMatch = trimmed.match(/^linear-gradient\s*\((.*)\)$/is);
	if (linearMatch) {
		const rawArgs = splitCssArgs(linearMatch[1]);
		if (rawArgs.length === 0) return null;
		let angle = 180; // default in CSS linear-gradient without direction is to bottom (180deg)
		let stopStartIndex = 0;

		const first = rawArgs[0].trim().toLowerCase();
		if (first.endsWith('deg') || first.endsWith('turn') || first.endsWith('rad') || first.startsWith('to ')) {
			angle = parseCssAngle(first);
			stopStartIndex = 1;
		}

		const stopStrings = rawArgs.slice(stopStartIndex);
		if (stopStrings.length === 0) return null;
		const stops = parseStopStrings(stopStrings);
		if (stops.length === 0) return null;
		return {
			type: 'linear',
			angle,
			stops
		};
	}

	const radialMatch = trimmed.match(/^radial-gradient\s*\((.*)\)$/is);
	if (radialMatch) {
		const rawArgs = splitCssArgs(radialMatch[1]);
		if (rawArgs.length === 0) return null;
		let stopStartIndex = 0;
		const first = rawArgs[0].trim().toLowerCase();
		if (first.startsWith('circle') || first.startsWith('ellipse') || first.includes('at ')) {
			stopStartIndex = 1;
		}
		const stopStrings = rawArgs.slice(stopStartIndex);
		if (stopStrings.length === 0) return null;
		const stops = parseStopStrings(stopStrings);
		if (stops.length === 0) return null;
		return {
			type: 'radial',
			cx: 0.5,
			cy: 0.5,
			r: 0.5,
			stops
		};
	}

	return null;
}

function parseStopStrings(stopStrings: string[]): GradientStop[] {
	const count = stopStrings.length;
	return stopStrings.map((str, idx) => {
		const parts = str.trim().split(/\s+(?=[0-9%])/);
		const color = parts[0];
		let offset = count === 1 ? 0 : idx / (count - 1);
		if (parts.length > 1) {
			const posStr = parts[1].trim();
			if (posStr.endsWith('%')) {
				offset = parseFloat(posStr) / 100;
			} else {
				const val = parseFloat(posStr);
				if (Number.isFinite(val)) offset = val;
			}
		}
		return {
			offset: Math.min(1, Math.max(0, offset)),
			color
		};
	});
}

/**
 * Resolves a paint value (which could be a CSS color, preset name, CSS gradient string, or CanvasGradientDef)
 * into either a CanvasGradientDef (if gradient) or null (if solid color or invalid).
 */
export function resolveCanvasGradient(value: unknown): CanvasGradientDef | null {
	if (!value) return null;
	if (isCanvasGradient(value)) return value;
	if (typeof value === 'string') {
		const lower = value.trim().toLowerCase();
		if (CANVAS_GRADIENT_PRESETS[lower]) {
			return CANVAS_GRADIENT_PRESETS[lower];
		}
		if (lower.startsWith('linear-gradient') || lower.startsWith('radial-gradient')) {
			return parseCssGradient(value);
		}
	}
	return null;
}

/**
 * Converts degrees clockwise (CSS angle: 0 = top, 90 = right, 180 = bottom, 270 = left)
 * to SVG linearGradient vector coordinates (x1, y1, x2, y2) normalized [0, 1].
 */
export function angleToSvgLinearCoords(angleDeg: number = 180): { x1: number; y1: number; x2: number; y2: number } {
	// Standard CSS angle: 0deg points UP (towards -Y in standard canvas coordinates)
	// Convert to standard mathematical angle in radians (0 at +X, counterclockwise)
	// CSS 0deg = Math 90deg (up)
	// CSS angle A -> Math theta = 90 - A
	const rad = ((90 - angleDeg) * Math.PI) / 180;
	// Vector direction
	const dx = Math.cos(rad);
	const dy = -Math.sin(rad); // invert for SVG/screen y-down coords

	// Project from center (0.5, 0.5) to edges
	const half = 0.5;
	return {
		x1: Math.round((half - dx * half) * 1000) / 1000,
		y1: Math.round((half - dy * half) * 1000) / 1000,
		x2: Math.round((half + dx * half) * 1000) / 1000,
		y2: Math.round((half + dy * half) * 1000) / 1000
	};
}

/**
 * Converts a CanvasGradientDef to an SvgGradientDef descriptor ready for rendering `<linearGradient>` / `<radialGradient>`.
 */
export function gradientToSvgDef(gradient: CanvasGradientDef, id: string): SvgGradientDef {
	const stops: SvgGradientStop[] = (gradient.stops ?? []).map((s) => ({
		offset: `${Math.round(s.offset * 1000) / 10}%`,
		stopColor: s.color,
		stopOpacity: s.opacity
	}));

	if (gradient.type === 'radial') {
		return {
			id,
			type: 'radial',
			attrs: {
				cx: gradient.cx !== undefined ? `${gradient.cx * 100}%` : '50%',
				cy: gradient.cy !== undefined ? `${gradient.cy * 100}%` : '50%',
				r: gradient.r !== undefined ? `${gradient.r * 100}%` : '50%'
			},
			stops
		};
	}

	const coords = angleToSvgLinearCoords(gradient.angle ?? 180);
	return {
		id,
		type: 'linear',
		attrs: {
			x1: `${coords.x1 * 100}%`,
			y1: `${coords.y1 * 100}%`,
			x2: `${coords.x2 * 100}%`,
			y2: `${coords.y2 * 100}%`
		},
		stops
	};
}
