import { hexToRgba01, rgba01ToHex } from './schema.js';
import type { ParameterField, ParameterSchema, ParameterValue } from './types.js';

/** A shader uniform type that can be a control (Flair's `@control` uniforms). */
export type ShaderControlType = 'float' | 'int' | 'bool' | 'vec2' | 'vec3' | 'vec4' | 'sampler2D';

/** A shader control value: a number, a boolean, vector components (colours are 0–1) or an image URL. */
export type ShaderControlValue = number | boolean | number[] | string;

/**
 * The shape of a parsed shader control, e.g. Flair's `ControlDef`
 * (`uniform vec3 uTint; // @control color default=#77C16A`).
 */
export interface ShaderControlLike {
	name: string;
	type: ShaderControlType;
	label?: string;
	/** A `vec3` / `vec4` shown as a colour picker. */
	color?: boolean;
	min?: number;
	max?: number;
	step?: number;
	default: ShaderControlValue;
	description?: string;
}

const SIZES: Record<string, 2 | 3 | 4> = { vec2: 2, vec3: 3, vec4: 4 };

/** One shader control as a parameter field (colour vectors become hex `color` fields). */
export function parameterFieldFromShaderControl(control: ShaderControlLike): ParameterField {
	const common = {
		id: control.name,
		...(control.label ? { label: control.label } : {}),
		...(control.description ? { description: control.description } : {})
	};
	switch (control.type) {
		case 'bool':
			return { ...common, type: 'boolean', default: control.default === true };
		case 'sampler2D':
			return { ...common, type: 'image', default: typeof control.default === 'string' ? control.default : '' };
		case 'float':
		case 'int':
			return {
				...common,
				type: control.type === 'int' ? 'int' : 'number',
				default: typeof control.default === 'number' ? control.default : 0,
				...(control.min !== undefined ? { min: control.min } : {}),
				...(control.max !== undefined ? { max: control.max } : {}),
				...(control.step !== undefined ? { step: control.step } : {})
			};
		default: {
			const size = SIZES[control.type];
			const components = Array.isArray(control.default) ? control.default : Array.from({ length: size }, () => 0);
			if (control.color && size >= 3) {
				return { ...common, type: 'color', alpha: size === 4, default: rgba01ToHex(components, size === 4) };
			}
			return {
				...common,
				type: 'vector',
				size,
				default: Array.from({ length: size }, (_, i) => components[i] ?? 0),
				...(control.min !== undefined ? { min: control.min } : {}),
				...(control.max !== undefined ? { max: control.max } : {}),
				...(control.step !== undefined ? { step: control.step } : {})
			};
		}
	}
}

/** A parameter schema for a shader's controls, in source order. */
export function parameterSchemaFromShaderControls(controls: readonly ShaderControlLike[], options: { title?: string } = {}): ParameterSchema {
	return { ...(options.title ? { title: options.title } : {}), fields: controls.map(parameterFieldFromShaderControl) };
}

/** A parameter value as the shader takes it: hex colours become 0–1 RGB(A) arrays. */
export function shaderControlValue(control: ShaderControlLike, value: ParameterValue): ShaderControlValue {
	if (control.color && typeof value === 'string') {
		return hexToRgba01(value, control.type === 'vec4') ?? (control.default as number[]);
	}
	return value;
}

/** A shader control value as a parameter value: colour arrays become hex. */
export function parameterValueFromShaderControl(control: ShaderControlLike, value: ShaderControlValue): ParameterValue {
	if (control.color && Array.isArray(value)) return rgba01ToHex(value, control.type === 'vec4');
	return value;
}
