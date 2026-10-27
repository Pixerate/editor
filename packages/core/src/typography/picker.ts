/**
 * Headless font picker model shared by the React and Svelte bindings: the selected family, weight,
 * style and metrics, category filter and search, recent families, highlight navigation for a
 * combobox, and per-family load status. DOM-free.
 */

import { filterFonts, findFont, type FontProvider, type FontSummary } from './registry.js';
import { resolveFontFallback } from './stack.js';
import type { FontCategory, FontSpec, FontStyle, FontWeight, NumericFontWeight } from './types.js';
import { nearestFontWeight, normalizeFontWeight } from './weight.js';

export type FontLoadStatus = 'idle' | 'loading' | 'loaded' | 'failed';

export interface FontPickerState {
	/** The selected value. */
	value: Required<Pick<FontSpec, 'family' | 'size' | 'style' | 'lineHeight' | 'letterSpacing'>> & { weight: NumericFontWeight; category?: FontCategory };
	/** Category filter (`all` for none). */
	category: FontCategory | 'all';
	query: string;
	/** Every font the picker knows. */
	fonts: readonly FontSummary[];
	/** `fonts` after the category filter and search. */
	results: readonly FontSummary[];
	/** Recently chosen families that are still in `fonts`, newest first. */
	recent: readonly FontSummary[];
	/** Index into `results` of the highlighted option (-1 for none). */
	highlighted: number;
	previewText: string;
	/** Whether `fonts` is being fetched from the provider. */
	loading: boolean;
	/** Provider error message from the last refresh. */
	error?: string;
	/** Load status of each family's preview face, by lower-cased family. */
	loadStatus: Readonly<Record<string, FontLoadStatus>>;
}

export interface FontPickerOptions {
	/** Where fonts come from. Without one, pass `fonts`. */
	provider?: FontProvider;
	/** A fixed list (used until `refresh()` replaces it from the provider). */
	fonts?: readonly FontSummary[];
	/** Initial value. Default: the first font at 16px. */
	value?: Partial<FontSpec>;
	/** Initial recent families, newest first. */
	recent?: readonly string[];
	/** Most recent families kept (default 8). */
	maxRecent?: number;
	previewText?: string;
	/** Load a family's face through the provider when it is selected (default true). */
	loadOnSelect?: boolean;
	/** Called whenever the value changes (not on filter or search changes). */
	onChange?: (value: FontSpec) => void;
}

const ALL_WEIGHTS: NumericFontWeight[] = [100, 200, 300, 400, 500, 600, 700, 800, 900];

/** Weights a font offers (every weight in range for a variable font; all nine when unknown). */
export function offeredWeights(font: FontSummary | undefined): NumericFontWeight[] {
	if (!font || !font.weights.length) return [...ALL_WEIGHTS];
	const ws = font.weights.map((w) => normalizeFontWeight(w));
	if (font.isVariable) return ALL_WEIGHTS.filter((w) => w >= Math.min(...ws) && w <= Math.max(...ws));
	return [...new Set(ws)].sort((a, b) => a - b);
}

export const DEFAULT_PREVIEW_TEXT = 'The quick brown fox jumps over the lazy dog';
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export class FontPickerModel {
	private state: FontPickerState;
	private readonly listeners = new Set<(state: FontPickerState) => void>();
	private readonly valueListeners = new Set<(value: FontSpec) => void>();
	private recentFamilies: string[];
	private destroyed = false;
	readonly provider?: FontProvider;
	private readonly maxRecent: number;
	private readonly loadOnSelect: boolean;
	private readonly onChange?: (value: FontSpec) => void;

	constructor(options: FontPickerOptions = {}) {
		this.provider = options.provider;
		this.maxRecent = options.maxRecent ?? 8;
		this.loadOnSelect = options.loadOnSelect ?? true;
		this.onChange = options.onChange;
		this.recentFamilies = [...(options.recent ?? [])];
		const fonts = [...(options.fonts ?? [])];
		const v = options.value ?? {};
		const family = v.family ?? fonts[0]?.family ?? 'system-ui';
		const known = findFont(fonts, family);
		this.state = this.derive({
			value: {
				family: known?.family ?? family,
				weight: normalizeFontWeight(v.weight),
				style: v.style ?? 'normal',
				size: v.size ?? 16,
				lineHeight: v.lineHeight ?? 1.5,
				letterSpacing: v.letterSpacing ?? 0,
				...((v.category ?? known?.category) ? { category: v.category ?? known?.category } : {})
			},
			category: 'all',
			query: '',
			fonts,
			results: [],
			recent: [],
			highlighted: -1,
			previewText: options.previewText ?? DEFAULT_PREVIEW_TEXT,
			loading: false,
			loadStatus: {}
		});
	}

	/** The current state. The same object is returned until something changes. */
	getState = (): FontPickerState => this.state;

	/** Calls `listener` after every change; returns an unsubscribe function. */
	subscribe = (listener: (state: FontPickerState) => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	/**
	 * Calls `listener` when the value changes through the picker or its agent tools (not through
	 * `setValue`, so a controlled component does not echo its own updates). Returns an unsubscribe.
	 */
	onValueChange = (listener: (value: FontSpec) => void): (() => void) => {
		this.valueListeners.add(listener);
		return () => this.valueListeners.delete(listener);
	};

	/** The selected value as a {@link FontSpec}. */
	get value(): FontSpec {
		const { category, ...rest } = this.state.value;
		return { ...rest, ...(category ? { category } : {}) };
	}

	/** The selected family's summary, if it is in `fonts`. */
	get selectedFont(): FontSummary | undefined {
		return findFont(this.state.fonts, this.state.value.family);
	}

	/** Weights the selected family offers (all nine when unknown or variable). */
	get availableWeights(): NumericFontWeight[] {
		return offeredWeights(this.selectedFont);
	}

	/** Styles the selected family offers (`normal` when unknown). */
	get availableStyles(): FontStyle[] {
		return this.selectedFont?.styles.length ? [...this.selectedFont.styles] : ['normal', 'italic'];
	}

	/** CSS for the selection: a fallback-resolved `font-family` plus the other properties. */
	get css(): { fontFamily: string; fontWeight: string; fontStyle: string; fontSize: string; lineHeight: string; letterSpacing: string } {
		const v = this.state.value;
		return {
			fontFamily: resolveFontFallback(v.family, v.category ?? this.selectedFont?.category),
			fontWeight: String(v.weight),
			fontStyle: v.style,
			fontSize: `${v.size}px`,
			lineHeight: String(v.lineHeight),
			letterSpacing: `${v.letterSpacing}em`
		};
	}

	/** A `font-family` value for previewing any family in a list. */
	familyCss(font: FontSummary | string): string {
		return typeof font === 'string' ? resolveFontFallback(font) : resolveFontFallback(font.family, font.category);
	}

	/** Fetches fonts from the provider. Keeps the current list when it fails. */
	async refresh(): Promise<readonly FontSummary[]> {
		if (!this.provider) return this.state.fonts;
		this.set({ loading: true, error: undefined });
		try {
			const fonts = await this.provider.listFonts();
			if (this.destroyed) return fonts;
			const known = findFont(fonts, this.state.value.family);
			this.set({ fonts, loading: false, value: known ? { ...this.state.value, family: known.family, category: known.category } : this.state.value });
			return fonts;
		} catch (e) {
			this.set({ loading: false, error: e instanceof Error ? e.message : String(e) });
			return this.state.fonts;
		}
	}

	setQuery(query: string): void {
		this.set({ query, highlighted: -1 });
	}

	setCategory(category: FontCategory | 'all'): void {
		if (category !== 'all' && !['sans-serif', 'serif', 'monospace', 'display', 'handwriting'].includes(category)) {
			throw new Error(`Unknown category "${category}"; use all, sans-serif, serif, monospace, display or handwriting.`);
		}
		this.set({ category, highlighted: -1 });
	}

	setPreviewText(previewText: string): void {
		this.set({ previewText });
	}

	/**
	 * Selects a family. Throws when `fonts` is non-empty and does not list it. Keeps the weight if
	 * the family has it, else picks the nearest one; keeps the style if offered, else `normal`.
	 */
	selectFamily(family: string): void {
		const font = findFont(this.state.fonts, family);
		if (!font && this.state.fonts.length) throw new Error(`Font "${family}" is not available; pick one of the listed families (search with a query).`);
		const name = font?.family ?? family.trim();
		if (!name) throw new Error('family must not be empty.');
		const weight = font ? nearestFontWeight(this.state.value.weight, offeredWeights(font)) : this.state.value.weight;
		const style = !font || font.styles.includes(this.state.value.style) ? this.state.value.style : 'normal';
		this.recentFamilies = [name, ...this.recentFamilies.filter((f) => f.toLowerCase() !== name.toLowerCase())].slice(0, this.maxRecent);
		const { category: _old, ...rest } = this.state.value;
		this.commit({ ...rest, family: name, weight, style, ...(font ? { category: font.category } : {}) });
		if (this.loadOnSelect) void this.loadFamily(name);
	}

	/** Sets the weight; snaps to the nearest weight the family offers. */
	setWeight(weight: FontWeight | number): void {
		this.commit({ ...this.state.value, weight: nearestFontWeight(normalizeFontWeight(weight), this.availableWeights) });
	}

	setStyle(style: FontStyle): void {
		if (!['normal', 'italic', 'oblique'].includes(style)) throw new Error(`Unknown style "${style}"; use normal, italic or oblique.`);
		this.commit({ ...this.state.value, style });
	}

	/** Font size in px, clamped to 1–1000. */
	setSize(size: number): void {
		if (!Number.isFinite(size)) return;
		this.commit({ ...this.state.value, size: clamp(Math.round(size * 100) / 100, 1, 1000) });
	}

	/** Unitless line-height, clamped to 0.5–4. */
	setLineHeight(lineHeight: number): void {
		if (!Number.isFinite(lineHeight)) return;
		this.commit({ ...this.state.value, lineHeight: clamp(Math.round(lineHeight * 100) / 100, 0.5, 4) });
	}

	/** Tracking in em, clamped to -0.5–1. */
	setLetterSpacing(letterSpacing: number): void {
		if (!Number.isFinite(letterSpacing)) return;
		this.commit({ ...this.state.value, letterSpacing: clamp(Math.round(letterSpacing * 1000) / 1000, -0.5, 1) });
	}

	/** Replaces the value (for controlled components). Does not call `onChange` or touch recents. */
	setValue(value: Partial<FontSpec>): void {
		const v = this.state.value;
		const family = value.family ?? v.family;
		const known = findFont(this.state.fonts, family);
		const next = {
			family: known?.family ?? family,
			weight: value.weight !== undefined ? normalizeFontWeight(value.weight) : v.weight,
			style: value.style ?? v.style,
			size: value.size ?? v.size,
			lineHeight: value.lineHeight ?? v.lineHeight,
			letterSpacing: value.letterSpacing ?? v.letterSpacing,
			...((value.category ?? known?.category ?? (family === v.family ? v.category : undefined)) ? { category: value.category ?? known?.category ?? v.category } : {})
		};
		if (JSON.stringify(next) === JSON.stringify(v)) return;
		this.set({ value: next });
	}

	/** Moves the highlight through `results` (wraps around). */
	moveHighlight(delta: number): void {
		const n = this.state.results.length;
		if (!n) return;
		const current = this.state.highlighted;
		const next = current < 0 ? (delta > 0 ? 0 : n - 1) : (((current + delta) % n) + n) % n;
		this.set({ highlighted: next });
	}

	setHighlight(index: number): void {
		this.set({ highlighted: clamp(Math.trunc(index), -1, this.state.results.length - 1) });
	}

	/** Selects the highlighted result. Returns whether there was one. */
	commitHighlight(): boolean {
		const font = this.state.results[this.state.highlighted];
		if (!font) return false;
		this.selectFamily(font.family);
		return true;
	}

	/**
	 * Handles combobox keys (ArrowDown/ArrowUp/Home/End/Enter/Escape). Returns whether the key was
	 * handled, so the caller can `preventDefault`.
	 */
	handleKey(key: string): boolean {
		switch (key) {
			case 'ArrowDown':
				this.moveHighlight(1);
				return true;
			case 'ArrowUp':
				this.moveHighlight(-1);
				return true;
			case 'Home':
				if (!this.state.results.length) return false;
				this.setHighlight(0);
				return true;
			case 'End':
				if (!this.state.results.length) return false;
				this.setHighlight(this.state.results.length - 1);
				return true;
			case 'Enter':
				return this.commitHighlight();
			case 'Escape':
				if (!this.state.query && this.state.highlighted < 0) return false;
				this.set({ query: '', highlighted: -1 });
				return true;
			default:
				return false;
		}
	}

	/** Loads a family's face through the provider (for previews) and tracks its status. */
	async loadFamily(family: string, weight?: FontWeight, style?: FontStyle): Promise<boolean> {
		const key = family.toLowerCase();
		if (!this.provider?.loadFont) return false;
		if (this.state.loadStatus[key] === 'loaded') return true;
		this.set({ loadStatus: { ...this.state.loadStatus, [key]: 'loading' } });
		const ok = await this.provider.loadFont(family, weight ?? this.state.value.weight, style ?? this.state.value.style).catch(() => false);
		if (!this.destroyed) this.set({ loadStatus: { ...this.state.loadStatus, [key]: ok ? 'loaded' : 'failed' } });
		return ok;
	}

	destroy(): void {
		this.destroyed = true;
		this.listeners.clear();
		this.valueListeners.clear();
	}

	private commit(value: FontPickerState['value']): void {
		if (JSON.stringify(value) === JSON.stringify(this.state.value)) {
			this.set({}); // recents may have changed
			return;
		}
		this.set({ value });
		const spec = this.value;
		this.onChange?.(spec);
		for (const l of [...this.valueListeners]) l(spec);
	}

	private derive(state: FontPickerState): FontPickerState {
		const results = filterFonts(state.fonts, { ...(state.category !== 'all' ? { category: state.category } : {}), query: state.query });
		const recent = this.recentFamilies.map((f) => findFont(state.fonts, f)).filter((f): f is FontSummary => !!f);
		return { ...state, results, recent, highlighted: Math.min(state.highlighted, results.length - 1) };
	}

	private set(patch: Partial<FontPickerState>): void {
		if (this.destroyed) return;
		const next = { ...this.state, ...patch };
		if (patch.error === undefined && 'error' in patch) delete next.error;
		this.state = this.derive(next);
		for (const l of [...this.listeners]) l(this.state);
	}
}

/** Creates a {@link FontPickerModel}. */
export function createFontPicker(options: FontPickerOptions = {}): FontPickerModel {
	return new FontPickerModel(options);
}
