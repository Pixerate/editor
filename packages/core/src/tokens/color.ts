/**
 * Colour parsing for colour tokens. Colours are stored as lowercase hex: `#rrggbb`, or
 * `#rrggbbaa` when not opaque. Accepted input: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`,
 * `rgb()` / `rgba()` (numbers or percentages, comma or space separated, `/ alpha`),
 * `transparent`, `black`, `white`, `{ r, g, b, a? }` with channels in 0–1 (Figma JSON) and
 * W3C colour objects (`{ colorSpace: 'srgb', components: [r, g, b], alpha?, hex? }`).
 */

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// Anchored with one character-class run: linear time.
const RGB = /^rgba?\(([^()]*)\)$/i;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const byte = (v: number) => Math.round(clamp01(v) * 255);
const hex2 = (n: number) => n.toString(16).padStart(2, '0');

/** `#rrggbb` / `#rrggbbaa` from 0–1 channels. */
export function rgbaToHex(r: number, g: number, b: number, a = 1): string {
	const head = `#${hex2(byte(r))}${hex2(byte(g))}${hex2(byte(b))}`;
	const alpha = byte(a);
	return alpha === 255 ? head : head + hex2(alpha);
}

/** 0–1 channels of a normalised hex colour. */
export function hexToRgba(hex: string): { r: number; g: number; b: number; a: number } | null {
	const normal = normalizeTokenColor(hex);
	if (normal === null) return null;
	const n = (i: number) => parseInt(normal.slice(i, i + 2), 16) / 255;
	return { r: n(1), g: n(3), b: n(5), a: normal.length === 9 ? n(7) : 1 };
}

function channel(part: string, scale: number): number | null {
	const pct = part.endsWith('%');
	const n = Number(pct ? part.slice(0, -1) : part);
	if (!Number.isFinite(n)) return null;
	return pct ? n / 100 : n / scale;
}

/** The colour as normalised hex, or `null` when it is not a colour this module reads. */
export function normalizeTokenColor(input: unknown): string | null {
	if (typeof input === 'string') {
		const text = input.trim();
		if (text.length > 200) return null;
		const lower = text.toLowerCase();
		if (lower === 'transparent') return '#00000000';
		if (lower === 'black') return '#000000';
		if (lower === 'white') return '#ffffff';
		const hex = HEX.exec(text);
		if (hex) {
			let digits = hex[1].toLowerCase();
			if (digits.length <= 4) digits = [...digits].map((c) => c + c).join('');
			if (digits.length === 8 && digits.endsWith('ff')) digits = digits.slice(0, 6);
			return `#${digits}`;
		}
		const rgb = RGB.exec(text);
		if (rgb) {
			const [colour, alphaPart] = rgb[1].split('/');
			const parts = colour.split(/[\s,]+/).filter(Boolean);
			let alpha: string | undefined = alphaPart?.trim();
			if (parts.length === 4 && alpha === undefined) alpha = parts.pop();
			if (parts.length !== 3) return null;
			const channels = parts.map((p) => channel(p, 255));
			const a = alpha === undefined || alpha === '' ? 1 : channel(alpha, 1);
			if (channels.some((c) => c === null) || a === null) return null;
			return rgbaToHex(channels[0]!, channels[1]!, channels[2]!, a);
		}
		return null;
	}
	if (typeof input === 'object' && input !== null) {
		const obj = input as Record<string, unknown>;
		if (Array.isArray(obj.components)) {
			const space = obj.colorSpace;
			if (space === undefined || space === 'srgb') {
				const [r, g, b] = obj.components as unknown[];
				const a = obj.alpha === undefined ? 1 : obj.alpha;
				if ([r, g, b, a].every((v) => typeof v === 'number' && Number.isFinite(v))) {
					return rgbaToHex(r as number, g as number, b as number, a as number);
				}
			}
			if (typeof obj.hex === 'string') {
				const base = normalizeTokenColor(obj.hex);
				if (base === null) return null;
				const a = typeof obj.alpha === 'number' ? obj.alpha : 1;
				const c = hexToRgba(base)!;
				return rgbaToHex(c.r, c.g, c.b, a);
			}
			return null;
		}
		const { r, g, b } = obj;
		const a = obj.a === undefined ? 1 : obj.a;
		if ([r, g, b, a].every((v) => typeof v === 'number' && Number.isFinite(v))) {
			return rgbaToHex(r as number, g as number, b as number, a as number);
		}
	}
	return null;
}
