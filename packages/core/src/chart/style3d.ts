/**
 * House style for 3-D charts (#810): the `three` section of the chart profile (`chart.json`) says
 * how 3-D pictures look — materials for the marks, ribbons, floor, wall and a focus highlight, a
 * light preset, shadows, contact darkening and the background — so a brand restyles 3-D the way
 * it restyles 2-D. Pure data and checks, no three.js: `@pixerate/editor/three` draws it.
 *
 * The section is versioned. A profile without it, or an older version, resolves to the defaults,
 * which are exactly how 3-D charts looked before house style reached them.
 */
import type { StyleCheck } from '../tools/style.js';
import { chartContrastRatio } from './color.js';
import type { ChartSpec, ChartTheme } from './types.js';

/** The version of the `three` section this library writes and reads. */
export const CHART_3D_STYLE_VERSION = 1;

/** How a surface reflects light. */
export interface Chart3dMaterial {
	/** 0 mirror-like … 1 matte. */
	roughness: number;
	/** 0 non-metal … 1 metal. */
	metalness: number;
	/** 0 clear … 1 solid. */
	opacity: number;
	/** 0 … 1: light passing through, for glass (only on ribbons and the wall). */
	transmission: number;
}

/** A material with its own colour (the floor, the wall, the focus highlight). */
export interface Chart3dColoredMaterial extends Chart3dMaterial {
	/** CSS colour; absent takes the theme's (the floor the grid colour, the wall the surface). */
	color?: string;
}

export type Chart3dLightPreset = 'studio' | 'soft' | 'rim' | 'flat';

/** Light presets: what each sets up. */
export const CHART_3D_LIGHT_PRESETS: Readonly<Record<Chart3dLightPreset, string>> = {
	studio: 'A soft key light from the upper left over a sky / ground fill (the default).',
	soft: 'Mostly fill with a weak key: low contrast, gentle shading.',
	rim: 'A dim fill, a key, and a strong light from behind that outlines the marks.',
	flat: 'Even light from everywhere and no key: colours as they are, no shading.'
};

export interface Chart3dStyle {
	version: number;
	materials: {
		/** Bars. Their colours come from the data. */
		mark: Chart3dMaterial;
		/** Line and area ribbons. Their colours come from the data. */
		ribbon: Chart3dMaterial;
		floor: Chart3dColoredMaterial;
		wall: Chart3dColoredMaterial;
		/** Added to focused marks as a glow; absent colour adds nothing. */
		highlight: { color?: string; intensity: number };
	};
	light: {
		preset: Chart3dLightPreset;
		/** Multiplies every light (default 1). */
		intensity: number;
		/** Where the key light comes from, degrees (absent: the preset's, upper left). */
		azimuth?: number;
		elevation?: number;
	};
	shadow: {
		enabled: boolean;
		/** 0 hard … 1 very soft. */
		softness: number;
	};
	/** Darkens the floor where marks stand on it (cheap contact shadows). */
	ambientOcclusion: boolean;
	/** CSS colour behind the chart; absent takes the theme's background. */
	background?: string;
}

const MATTE: Chart3dMaterial = { roughness: 0.8, metalness: 0, opacity: 1, transmission: 0 };

/** The defaults: how 3-D charts looked before house style (no visual change without a section). */
export const DEFAULT_CHART_3D_STYLE: Chart3dStyle = {
	version: CHART_3D_STYLE_VERSION,
	materials: {
		mark: { ...MATTE },
		ribbon: { ...MATTE },
		floor: { ...MATTE },
		wall: { ...MATTE },
		highlight: { intensity: 0.35 }
	},
	light: { preset: 'studio', intensity: 1 },
	shadow: { enabled: false, softness: 0.5 },
	ambientOcclusion: false
};

/** The `three` section as a profile stores it: every part optional. */
export type Chart3dStyleInput = {
	version?: number;
	materials?: { [K in keyof Chart3dStyle['materials']]?: Partial<Chart3dStyle['materials'][K]> };
	light?: Partial<Chart3dStyle['light']>;
	shadow?: Partial<Chart3dStyle['shadow']>;
	ambientOcclusion?: boolean;
	background?: string;
};

const clamp01 = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);

function material<T extends Chart3dMaterial>(base: T, input: Partial<T> | undefined): T {
	const out = { ...base, ...(input ?? {}) } as T;
	out.roughness = clamp01(out.roughness, base.roughness);
	out.metalness = clamp01(out.metalness, base.metalness);
	out.opacity = clamp01(out.opacity, base.opacity);
	out.transmission = clamp01(out.transmission, base.transmission);
	return out;
}

/**
 * The full 3-D style for a `three` section: missing parts take the defaults, and an older or
 * absent `version` is read as version 1 (the first; there is nothing to migrate yet). A section
 * from a newer library version throws, saying which version it needs.
 */
export function resolveChart3dStyle(input?: Chart3dStyleInput | null): Chart3dStyle {
	const s = input ?? {};
	if (typeof s.version === 'number' && s.version > CHART_3D_STYLE_VERSION) {
		throw new Error(`The 3-D style is version ${s.version}; this library reads up to version ${CHART_3D_STYLE_VERSION}. Update @pixerate/editor, or write a version ${CHART_3D_STYLE_VERSION} section.`);
	}
	const d = DEFAULT_CHART_3D_STYLE;
	const m = s.materials ?? {};
	const preset = s.light?.preset && s.light.preset in CHART_3D_LIGHT_PRESETS ? s.light.preset : d.light.preset;
	return {
		version: CHART_3D_STYLE_VERSION,
		materials: {
			mark: material(d.materials.mark, m.mark),
			ribbon: material(d.materials.ribbon, m.ribbon),
			floor: material(d.materials.floor, m.floor),
			wall: material(d.materials.wall, m.wall),
			highlight: { ...(m.highlight?.color ? { color: m.highlight.color } : {}), intensity: clamp01(m.highlight?.intensity, d.materials.highlight.intensity) }
		},
		light: {
			preset,
			intensity: typeof s.light?.intensity === 'number' && s.light.intensity >= 0 ? Math.min(4, s.light.intensity) : d.light.intensity,
			...(typeof s.light?.azimuth === 'number' ? { azimuth: s.light.azimuth } : {}),
			...(typeof s.light?.elevation === 'number' ? { elevation: Math.max(-89, Math.min(89, s.light.elevation)) } : {})
		},
		shadow: { enabled: s.shadow?.enabled === true, softness: clamp01(s.shadow?.softness, d.shadow.softness) },
		ambientOcclusion: s.ambientOcclusion === true,
		...(s.background ? { background: s.background } : {})
	};
}

/** The colours a 3-D picture draws behind its marks and labels: background, floor and wall. */
export function chart3dStyleColors(style: Chart3dStyle, theme: Pick<ChartTheme, 'background' | 'surface' | 'grid'>): { background: string; floor: string; wall: string } {
	const background = style.background ?? (theme.background === 'transparent' ? theme.surface : theme.background);
	return { background, floor: style.materials.floor.color ?? theme.grid, wall: style.materials.wall.color ?? theme.surface };
}

const COLOR = { type: 'string', minLength: 1, description: 'A CSS colour (hex or rgb()), or a { "$token": ... } reference.' } as const;
const UNIT = (what: string) => ({ type: 'number', minimum: 0, maximum: 1, description: what }) as const;
const MATERIAL_PROPS = {
	roughness: UNIT('0 mirror-like … 1 matte (default 0.8).'),
	metalness: UNIT('0 non-metal … 1 metal (default 0).'),
	opacity: UNIT('0 clear … 1 solid (default 1).'),
	transmission: UNIT('Light passing through, 0 … 1, for glass (default 0).')
};

/** JSON Schema for the chart profile's `three` section. */
export const CHART_3D_STYLE_SCHEMA = {
	type: 'object',
	description: 'How 3-D charts look: materials, light, shadows and background. Absent parts keep the defaults (no change from unstyled 3-D).',
	properties: {
		version: { type: 'integer', minimum: 1, maximum: CHART_3D_STYLE_VERSION, description: `Section version (write ${CHART_3D_STYLE_VERSION}).` },
		materials: {
			type: 'object',
			properties: {
				mark: { type: 'object', properties: MATERIAL_PROPS, additionalProperties: false, description: 'Bars (colours come from the palette).' },
				ribbon: { type: 'object', properties: MATERIAL_PROPS, additionalProperties: false, description: 'Line and area ribbons (colours come from the palette); glassy with transmission.' },
				floor: { type: 'object', properties: { color: COLOR, ...MATERIAL_PROPS }, additionalProperties: false, description: 'The floor (default colour: the theme grid colour).' },
				wall: { type: 'object', properties: { color: COLOR, ...MATERIAL_PROPS }, additionalProperties: false, description: 'The back wall behind the gridlines (default colour: the theme surface).' },
				highlight: { type: 'object', properties: { color: COLOR, intensity: UNIT('Glow strength on focused marks (default 0.35).') }, additionalProperties: false, description: 'A glow added to focused marks.' }
			},
			additionalProperties: false
		},
		light: {
			type: 'object',
			properties: {
				preset: { type: 'string', enum: Object.keys(CHART_3D_LIGHT_PRESETS), description: Object.entries(CHART_3D_LIGHT_PRESETS).map(([k, v]) => `${k}: ${v}`).join(' ') },
				intensity: { type: 'number', minimum: 0, maximum: 4, description: 'Multiplies every light (default 1).' },
				azimuth: { type: 'number', minimum: -360, maximum: 360, description: 'Key light direction around the chart, degrees (0 from the front, positive to the right).' },
				elevation: { type: 'number', minimum: -89, maximum: 89, description: 'Key light height, degrees above the floor.' }
			},
			additionalProperties: false
		},
		shadow: {
			type: 'object',
			properties: { enabled: { type: 'boolean', description: 'Marks cast shadows on the floor (default false).' }, softness: UNIT('0 hard … 1 very soft (default 0.5).') },
			additionalProperties: false
		},
		ambientOcclusion: { type: 'boolean', description: 'Darken the floor where marks stand on it (default false).' },
		background: COLOR
	},
	additionalProperties: false
} as const;

/**
 * `three-contrast`: in 3-D, overlay text sits on the background, the floor (category labels) and
 * the wall's edge (ticks), and marks stand on the floor in front of the wall. Checks the profile's
 * text against the background and floor, and its palette against the floor and wall.
 */
export const chart3dContrastCheck: StyleCheck<ChartSpec> = {
	id: 'three-contrast',
	description: '3-D charts: label text reads on the background and floor, and marks stand out from the floor and wall (only charts with a 3-D view).',
	optionsSchema: {
		type: 'object',
		properties: {
			text: { type: 'number', minimum: 1, maximum: 21, description: 'Smallest contrast for label text (default 4.5).' },
			marks: { type: 'number', minimum: 1, maximum: 21, description: 'Smallest contrast for marks against the floor and wall (default 1.5: 3-D shading adds edges).' }
		},
		additionalProperties: false
	},
	run(spec, profile, { text = 4.5, marks = 1.5 }) {
		if (!spec.view3d) return [];
		const p = profile as { theme?: Partial<ChartTheme>; palette?: string[]; three?: Chart3dStyleInput };
		const style = resolveChart3dStyle(p.three);
		const theme = { background: p.theme?.background ?? '#ffffff', surface: p.theme?.surface ?? '#ffffff', grid: p.theme?.grid ?? '#e5e7eb' };
		const { background, floor, wall } = chart3dStyleColors(style, theme);
		const findings = [];
		for (const [label, color] of [['Label text', p.theme?.text ?? '#1f2937'], ['Tick text', p.theme?.mutedText ?? '#6b7280']] as const) {
			for (const [where, behind] of [['background', background], ['floor', floor]] as const) {
				const r = chartContrastRatio(color, behind);
				if (r !== null && r < (text as number)) {
					findings.push({ severity: 'warning' as const, message: `In 3-D, ${label.toLowerCase()} (${color}) has contrast ${Math.round(r * 100) / 100}:1 on the ${where} (${behind}); want ${text}:1. Change the theme text colour or the 3-D ${where === 'floor' ? 'floor colour' : 'background'}.`, target: { kind: 'chart' } });
				}
			}
		}
		for (const color of p.palette ?? []) {
			for (const [where, behind] of [['floor', floor], ['wall', wall]] as const) {
				const r = chartContrastRatio(color, behind);
				if (r !== null && r < (marks as number)) {
					findings.push({ severity: 'warning' as const, message: `In 3-D, marks in ${color} have contrast ${Math.round(r * 100) / 100}:1 against the ${where} (${behind}); want ${marks}:1. Change the 3-D ${where} colour or the palette colour.`, target: { kind: 'chart' } });
				}
			}
		}
		return findings;
	}
};
