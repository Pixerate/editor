/**
 * JSON-Schema-lite: the subset of JSON Schema used by MCP tool `inputSchema`s,
 * plus a small validator for tool-call arguments. Unknown keywords are ignored.
 */
export type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

export interface JsonSchema {
	type?: JsonSchemaType | readonly JsonSchemaType[];
	description?: string;
	title?: string;
	enum?: readonly unknown[];
	const?: unknown;
	default?: unknown;
	properties?: { readonly [key: string]: JsonSchema };
	required?: readonly string[];
	additionalProperties?: boolean | JsonSchema;
	items?: JsonSchema;
	minItems?: number;
	maxItems?: number;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	[keyword: string]: unknown;
}

export interface SchemaValidationError {
	/** JSON-pointer-like path to the offending value, e.g. `/node/id` (`""` is the root). */
	path: string;
	message: string;
}

function typeOf(value: unknown): JsonSchemaType | 'undefined' {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
	if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'object') {
		return typeof value as JsonSchemaType;
	}
	return 'undefined';
}

function matchesType(value: unknown, type: JsonSchemaType): boolean {
	const actual = typeOf(value);
	if (type === 'number') return actual === 'number' || actual === 'integer';
	return actual === type;
}

const isEqual = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Validates `value` against `schema` and returns every error found (an empty
 * array means valid). Supports `type` (incl. arrays of types), `enum`, `const`,
 * `properties`, `required`, `additionalProperties`, `items`, `minItems`,
 * `maxItems`, `minimum`, `maximum`, `minLength`, `maxLength` and `pattern`.
 */
export function validateJsonSchema(value: unknown, schema: JsonSchema | undefined, path = ''): SchemaValidationError[] {
	if (!schema || typeof schema !== 'object') return [];
	const errors: SchemaValidationError[] = [];
	const at = path || '/';

	if (schema.type !== undefined) {
		const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as JsonSchemaType[];
		if (!types.some((t) => matchesType(value, t))) {
			errors.push({ path: at, message: `Expected ${types.join(' | ')}, got ${typeOf(value)}.` });
			return errors;
		}
	}
	if (schema.const !== undefined && !isEqual(value, schema.const)) {
		errors.push({ path: at, message: `Expected ${JSON.stringify(schema.const)}.` });
	}
	if (schema.enum && !schema.enum.some((option) => isEqual(value, option))) {
		errors.push({
			path: at,
			message: `Expected one of ${schema.enum.map((o) => JSON.stringify(o)).join(', ')}, got ${JSON.stringify(value)}.`
		});
	}

	if (typeof value === 'string') {
		if (schema.minLength !== undefined && value.length < schema.minLength) {
			errors.push({ path: at, message: `Must be at least ${schema.minLength} characters.` });
		}
		if (schema.maxLength !== undefined && value.length > schema.maxLength) {
			errors.push({ path: at, message: `Must be at most ${schema.maxLength} characters.` });
		}
		if (schema.pattern !== undefined) {
			let regex: RegExp | null = null;
			try {
				regex = new RegExp(schema.pattern, 'u');
			} catch {
				// An invalid pattern in the schema is not the caller's fault.
			}
			if (regex && !regex.test(value)) {
				errors.push({ path: at, message: `Must match pattern ${schema.pattern}.` });
			}
		}
	}

	if (typeof value === 'number') {
		if (schema.minimum !== undefined && value < schema.minimum) {
			errors.push({ path: at, message: `Must be >= ${schema.minimum}.` });
		}
		if (schema.maximum !== undefined && value > schema.maximum) {
			errors.push({ path: at, message: `Must be <= ${schema.maximum}.` });
		}
	}

	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems) {
			errors.push({ path: at, message: `Must have at least ${schema.minItems} items.` });
		}
		if (schema.maxItems !== undefined && value.length > schema.maxItems) {
			errors.push({ path: at, message: `Must have at most ${schema.maxItems} items.` });
		}
		if (schema.items) {
			value.forEach((item, index) => {
				errors.push(...validateJsonSchema(item, schema.items, `${path}/${index}`));
			});
		}
	}

	if (typeOf(value) === 'object') {
		const obj = value as Record<string, unknown>;
		for (const key of schema.required ?? []) {
			if (obj[key] === undefined) {
				errors.push({ path: `${path}/${key}`, message: `Missing required property "${key}".` });
			}
		}
		const properties = schema.properties ?? {};
		for (const [key, child] of Object.entries(obj)) {
			if (child === undefined) continue;
			if (key in properties) {
				errors.push(...validateJsonSchema(child, properties[key], `${path}/${key}`));
			} else if (schema.additionalProperties === false) {
				errors.push({ path: `${path}/${key}`, message: `Unknown property "${key}".` });
			} else if (typeof schema.additionalProperties === 'object') {
				errors.push(...validateJsonSchema(child, schema.additionalProperties, `${path}/${key}`));
			}
		}
	}

	return errors;
}
