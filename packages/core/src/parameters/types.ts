import type { AnimationEasing } from '../animation/easing.js';

/**
 * Types for the schema-driven parameters editor: the control panel of an effect, shader,
 * generator or component. A `ParameterSchema` lists fields (optionally in groups); a
 * `ParametersController` holds their values with validation, undo, presets and keyframes.
 */

/** A parameter's value. `number` / `int`: a number; `boolean`; `choice`: an option value;
 * `color`: `#rrggbb` (or `#rrggbbaa` with `alpha`); `vector`: 2–4 numbers; `image` / `text`: a string. */
export type ParameterValue = number | boolean | string | number[];

/** Parameter id → value. */
export type ParameterValues = Record<string, ParameterValue>;

export type ParameterFieldType = 'number' | 'int' | 'boolean' | 'choice' | 'color' | 'vector' | 'image' | 'text';

/**
 * One test in a `showIf` condition: a literal (equal to), an array (one of), or an object
 * whose keys must all hold.
 */
export type ParameterConditionTest =
	| string
	| number
	| boolean
	| readonly (string | number | boolean)[]
	| {
			eq?: ParameterValue;
			ne?: ParameterValue;
			in?: readonly (string | number | boolean)[];
			notIn?: readonly (string | number | boolean)[];
			gt?: number;
			gte?: number;
			lt?: number;
			lte?: number;
			/** `true`: the value is truthy (non-zero, non-empty); `false`: falsy. */
			truthy?: boolean;
	  };

/**
 * When a field or group is shown. An object maps other parameter ids to tests, all of which
 * must hold (`{ mode: 'advanced', count: { gte: 2 } }`); a function gets every value.
 * Hidden fields keep their values.
 */
export type ParameterCondition = { readonly [id: string]: ParameterConditionTest } | ((values: Readonly<ParameterValues>) => boolean);

interface ParameterFieldBase<TValue extends ParameterValue> {
	/** Unique id across the schema (also the key in `values`). */
	id: string;
	/** Display name (default: the id made readable, `flowSpeed` → "Flow speed"). */
	label?: string;
	/** Help text shown under the label and given to agents. */
	description?: string;
	default: TValue;
	showIf?: ParameterCondition;
	/** Include in `randomize()` (default `true`; image and text fields are never randomised). */
	randomize?: boolean;
	/** Shown but not editable from the panel (agents and code can still set it). */
	readOnly?: boolean;
}

export interface NumberParameterField extends ParameterFieldBase<number> {
	type: 'number' | 'int';
	min?: number;
	max?: number;
	/** Slider / spinner step (default: 1 for `int`, 1/100 of the range otherwise). */
	step?: number;
	/** Unit shown after the value (`px`, `%`, `°`, `ms`). */
	unit?: string;
	/** `slider` (slider plus number box; the default when `min` and `max` are set) or `input` (number box only). */
	control?: 'slider' | 'input';
	/** Decimal places shown (default: from `step`). */
	decimals?: number;
}

export interface BooleanParameterField extends ParameterFieldBase<boolean> {
	type: 'boolean';
}

export interface ParameterChoiceOption {
	value: string | number;
	label?: string;
	description?: string;
}

export interface ChoiceParameterField extends ParameterFieldBase<string | number> {
	type: 'choice';
	options: readonly (string | number | ParameterChoiceOption)[];
	/** `select` (dropdown, the default) or `segmented` (buttons; best for 2–4 options). */
	control?: 'select' | 'segmented';
}

export interface ColorParameterField extends ParameterFieldBase<string> {
	type: 'color';
	/** Values carry alpha as `#rrggbbaa` (default `false`: `#rrggbb`). */
	alpha?: boolean;
	/** Colours offered as swatches. */
	swatches?: readonly string[];
}

export interface VectorParameterField extends ParameterFieldBase<number[]> {
	type: 'vector';
	/** Number of components, 2–4 (default: the default's length). */
	size?: 2 | 3 | 4;
	/** Bounds for every component, or one per component. */
	min?: number | readonly number[];
	max?: number | readonly number[];
	step?: number;
	unit?: string;
	/** Component labels (default `x`, `y`, `z`, `w`). */
	labels?: readonly string[];
	decimals?: number;
}

export interface ParameterImageOption {
	url: string;
	label?: string;
}

export interface ImageParameterField extends ParameterFieldBase<string> {
	type: 'image';
	/** Suggested assets shown as thumbnails. */
	options?: readonly ParameterImageOption[];
	/** File types offered by the picker's file button, e.g. `image/*`. */
	accept?: string;
}

export interface TextParameterField extends ParameterFieldBase<string> {
	type: 'text';
	multiline?: boolean;
	maxLength?: number;
	minLength?: number;
	/** Regular expression (unicode) the whole value must match. */
	pattern?: string;
	placeholder?: string;
}

export type ParameterField =
	| NumberParameterField
	| BooleanParameterField
	| ChoiceParameterField
	| ColorParameterField
	| VectorParameterField
	| ImageParameterField
	| TextParameterField;

/** A collapsible group of fields (groups may nest). */
export interface ParameterGroup {
	type: 'group';
	/** Unique id (used for its collapsed state). */
	id: string;
	label?: string;
	description?: string;
	/** Starts collapsed (default `false`). */
	collapsed?: boolean;
	showIf?: ParameterCondition;
	fields: readonly ParameterSchemaItem[];
}

export type ParameterSchemaItem = ParameterField | ParameterGroup;

/** A named set of values. Fields a preset leaves out go back to their defaults when applied. */
export interface ParameterPreset {
	name: string;
	values: Partial<ParameterValues>;
	description?: string;
	/** Comes from the schema: cannot be overwritten or deleted. */
	builtIn?: boolean;
}

export interface ParameterSchema {
	title?: string;
	fields: readonly ParameterSchemaItem[];
	/** Built-in presets. */
	presets?: readonly ParameterPreset[];
}

/** One error, shaped like `validateJsonSchema`'s: `path` is `/<id>` (or `/<id>/<index>`). */
export interface ParameterError {
	path: string;
	/** The parameter's id. */
	id: string;
	/** A sentence naming the field, e.g. "Speed must be at most 4." */
	message: string;
}

/** Easing of a keyframe segment (the `AnimationEasing` of `@pixerate/editor/animation`). */
export type ParameterEasing = AnimationEasing;

/** One keyframe, shaped like `AnimationKeyframe` from `@pixerate/editor/animation`. */
export interface ParameterKeyframe<TValue = ParameterValue> {
	/** Time in milliseconds. */
	time: number;
	value: TValue;
	/** Easing of the segment leaving this keyframe. */
	easing?: ParameterEasing;
}

/** A parameter's keyframes, shaped like `AnimationTrack` from `@pixerate/editor/animation` (which it accepts). */
export interface ParameterTrack<TValue = ParameterValue> {
	keyframes: ParameterKeyframe<TValue>[];
	enabled?: boolean;
}

/**
 * Where a parameter's keyframes live: an effect document, a canvas node, or
 * `createParameterKeyframeStore()`. The controller reads and writes whole tracks so a
 * keyframe toggle is one undo step.
 */
export interface ParameterKeyframes {
	getTrack(id: string): ParameterTrack<any> | undefined;
	/** Replaces a track; `undefined` (or no keyframes) removes it. */
	setTrack(id: string, track: ParameterTrack<any> | undefined): void;
	/** Called when tracks change from outside the controller. */
	subscribe?(listener: () => void): () => void;
}

/** `keyed`: a keyframe sits at the current time; `animated`: keyframes elsewhere; `none`. */
export type ParameterKeyState = 'none' | 'animated' | 'keyed';
