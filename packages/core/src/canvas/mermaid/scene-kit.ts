// Family drawings follow Ursula's family canvases (src/react/canvases/*.tsx and
// src/react/canvas/familyCanvas.ts), drawn as framework-free marks so React, Svelte and the
// SVG export share one renderer per family.
import type { DiagramFamily, DiagramGraph } from '../../diagram/types.js';
import type { DiagramLayout } from './layout.js';
import { DIAGRAM_SVG_DARK_THEME, DIAGRAM_SVG_LIGHT_THEME, type DiagramSvgTheme } from './theme.js';

/**
 * Colours for family drawings. Concrete values draw the same everywhere (files, PNG); a
 * renderer may pass CSS (`var(--x, #fff)`) since the React and Svelte scenes paint with
 * `style`. `palette` colours slices, series, sections and branches in order.
 */
export interface DiagramSceneTheme extends DiagramSvgTheme {
	/** Categorical colours (pie slices, sections, branches, curves…), used in order. */
	palette: string[];
	/** Text drawn on palette colours. */
	paletteText: string;
	/** Axis lines, grid and lifelines. */
	grid: string;
	/** Secondary text (axis labels, legends, notes). */
	mutedText: string;
	/** Selection outline. */
	selection: string;
}

const PALETTE_LIGHT = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac', '#8cd17d', '#86bcb6'];
const PALETTE_DARK = ['#7aa6d6', '#ffad5c', '#7fcf73', '#ff8587', '#9fdcd6', '#ffe07a', '#d4a2c6', '#ffc2c9', '#c49a82', '#d9d0cc', '#b0eba3', '#acd8d3'];

export const DIAGRAM_SCENE_LIGHT_THEME: DiagramSceneTheme = {
	...DIAGRAM_SVG_LIGHT_THEME,
	palette: PALETTE_LIGHT,
	paletteText: '#0f172a',
	grid: '#cbd5e1',
	mutedText: '#64748b',
	selection: '#2563eb'
};

export const DIAGRAM_SCENE_DARK_THEME: DiagramSceneTheme = {
	...DIAGRAM_SVG_DARK_THEME,
	palette: PALETTE_DARK,
	paletteText: '#0f172a',
	grid: '#334155',
	mutedText: '#94a3b8',
	selection: '#60a5fa'
};

interface DiagramMarkBase {
	/** Unique within the scene (a stable key for frameworks). */
	key: string;
	/** What the mark draws, for styling hooks (`slice`, `legend`, `axis`, `lifeline`, `bar`…). */
	role: string;
	/** The node, edge or group id clicking this mark selects (none: decoration). */
	target?: string;
	/** Mark belongs to the current selection. */
	selected?: boolean;
	opacity?: number;
}

export interface DiagramRectMark extends DiagramMarkBase {
	kind: 'rect';
	x: number;
	y: number;
	width: number;
	height: number;
	fill: string;
	stroke?: string;
	strokeWidth?: number;
	radius?: number;
	dash?: string;
}

export interface DiagramPathMark extends DiagramMarkBase {
	kind: 'path';
	d: string;
	fill?: string;
	stroke?: string;
	strokeWidth?: number;
	dash?: string;
	/** Arrow head at the end (`arrow` open, `arrowclosed` filled). */
	markerEnd?: 'arrow' | 'arrowclosed';
	markerStart?: 'arrow' | 'arrowclosed';
	/** Bounds of the path; required when `d` uses arcs or relative commands. */
	box?: { x: number; y: number; width: number; height: number };
}

export interface DiagramCircleMark extends DiagramMarkBase {
	kind: 'circle';
	cx: number;
	cy: number;
	r: number;
	fill: string;
	stroke?: string;
	strokeWidth?: number;
}

export interface DiagramLineMark extends DiagramMarkBase {
	kind: 'line';
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	stroke: string;
	strokeWidth?: number;
	dash?: string;
	markerEnd?: 'arrow' | 'arrowclosed';
	markerStart?: 'arrow' | 'arrowclosed';
}

export interface DiagramTextMark extends DiagramMarkBase {
	kind: 'text';
	x: number;
	y: number;
	text: string;
	anchor: 'start' | 'middle' | 'end';
	/** Vertical alignment of the text to `y`. */
	baseline: 'top' | 'middle' | 'bottom';
	size: number;
	weight?: number;
	fill: string;
	/** Degrees, around (x, y). */
	rotate?: number;
	italic?: boolean;
}

export type DiagramMark = DiagramRectMark | DiagramPathMark | DiagramCircleMark | DiagramLineMark | DiagramTextMark;

/** A family's drawing in canvas coordinates (the same as the layout's positions). */
export interface DiagramScene {
	family: DiagramFamily;
	/** Bounds of everything drawn. */
	x: number;
	y: number;
	width: number;
	height: number;
	/** Draw in order. */
	marks: DiagramMark[];
}

export interface DiagramSceneOptions {
	theme?: Partial<DiagramSceneTheme>;
	/** Selected node, edge or group ids (their marks get `selected`). */
	selection?: readonly string[];
}

export interface FamilySceneInput {
	graph: DiagramGraph;
	layout: DiagramLayout;
	theme: DiagramSceneTheme;
	selection: ReadonlySet<string>;
}

/** Draws a family from its graph and layout; returns marks in canvas coordinates. */
export type FamilyScene = (input: FamilySceneInput) => DiagramMark[];

/**
 * `target` of the diagram title's marks: double-clicking it renames the title (`setTitle`)
 * rather than a node.
 */
export const DIAGRAM_TITLE_TARGET = '::title';

/** The palette colour for index `i` (cycling). */
export function sceneColor(theme: DiagramSceneTheme, i: number): string {
	return theme.palette[((i % theme.palette.length) + theme.palette.length) % theme.palette.length]!;
}

/** Rough text width (no DOM), in px. */
export function estimateTextWidth(text: string, size: number): number {
	return text.length * size * 0.58;
}

