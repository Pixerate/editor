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
	exclusiveMinimum?: number;
	exclusiveMaximum?: number;
	multipleOf?: number;
	uniqueItems?: boolean;
	anyOf?: readonly JsonSchema[];
	oneOf?: readonly JsonSchema[];
	allOf?: readonly JsonSchema[];
	not?: JsonSchema;
	/** Local reference only: `#`, `#/$defs/<name>` or `#/definitions/<name>`. */
	$ref?: string;
	$defs?: { readonly [key: string]: JsonSchema };
	definitions?: { readonly [key: string]: JsonSchema };
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

/** Resolves a local `$ref` (`#`, `#/$defs/a`, `#/definitions/a/properties/b`, ...) against `root`. */
function resolveRef(ref: string, root: JsonSchema): JsonSchema | undefined {
	if (ref === '#') return root;
	if (!ref.startsWith('#/')) return undefined;
	let node: unknown = root;
	for (const raw of ref.slice(2).split('/')) {
		const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
		if (!node || typeof node !== 'object') return undefined;
		node = (node as Record<string, unknown>)[key];
	}
	return node && typeof node === 'object' ? (node as JsonSchema) : undefined;
}

/** Most `$ref` hops followed before a reference cycle is reported. */
const MAX_REF_DEPTH = 32;

/**
 * Validates `value` against `schema` and returns every error found (an empty
 * array means valid). Supports `type` (incl. arrays of types), `enum`, `const`,
 * `properties`, `required`, `additionalProperties`, `items`, `minItems`,
 * `maxItems`, `uniqueItems`, `minimum`, `maximum`, `exclusiveMinimum`,
 * `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`, `pattern`,
 * `anyOf`, `oneOf`, `allOf`, `not` and local `$ref`s (`#/$defs/...`).
 * Other keywords (`format`, `if`/`then`, `patternProperties`, remote refs...)
 * are ignored.
 *
 * When no `anyOf` / `oneOf` branch matches, the errors of the closest branch
 * (the one with the fewest errors) are reported, so a caller sees what to fix
 * rather than only "no branch matched".
 */
export function validateJsonSchema(
	value: unknown,
	schema: JsonSchema | undefined,
	path = '',
	root: JsonSchema | undefined = schema,
	refDepth = 0
): SchemaValidationError[] {
	if (!schema || typeof schema !== 'object') return [];
	const errors: SchemaValidationError[] = [];
	const at = path || '/';
	const recurse = (child: unknown, childSchema: JsonSchema | undefined, childPath: string) =>
		validateJsonSchema(child, childSchema, childPath, root, refDepth);

	if (typeof schema.$ref === 'string') {
		const target = root ? resolveRef(schema.$ref, root) : undefined;
		if (!target) {
			errors.push({ path: at, message: `Unresolvable schema reference ${schema.$ref}.` });
		} else if (refDepth >= MAX_REF_DEPTH) {
			errors.push({ path: at, message: `Schema reference ${schema.$ref} is nested too deeply.` });
		} else {
			errors.push(...validateJsonSchema(value, target, path, root, refDepth + 1));
		}
		// Sibling keywords still apply (2019-09+ semantics).
	}

	if (schema.allOf) {
		for (const branch of schema.allOf) errors.push(...recurse(value, branch, path));
	}
	if (schema.anyOf || schema.oneOf) {
		const branches = (schema.anyOf ?? schema.oneOf)!;
		const results = branches.map((branch) => recurse(value, branch, path));
		const matching = results.filter((r) => r.length === 0).length;
		if (matching === 0 && results.length > 0) {
			const closest = results.reduce((best, r) => (r.length < best.length ? r : best));
			errors.push(
				{ path: at, message: `Does not match any allowed shape (${branches.length} options); closest match failed with:` },
				...closest
			);
		} else if (schema.oneOf && !schema.anyOf && matching > 1) {
			errors.push({ path: at, message: `Matches ${matching} shapes; exactly one is allowed.` });
		}
	}
	if (schema.not && recurse(value, schema.not, path).length === 0) {
		errors.push({ path: at, message: 'Matches a disallowed shape.' });
	}

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
		if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
			errors.push({ path: at, message: `Must be > ${schema.exclusiveMinimum}.` });
		}
		if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
			errors.push({ path: at, message: `Must be < ${schema.exclusiveMaximum}.` });
		}
		if (schema.multipleOf !== undefined && schema.multipleOf > 0) {
			const quotient = value / schema.multipleOf;
			if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
				errors.push({ path: at, message: `Must be a multiple of ${schema.multipleOf}.` });
			}
		}
	}

	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems) {
			errors.push({ path: at, message: `Must have at least ${schema.minItems} items.` });
		}
		if (schema.maxItems !== undefined && value.length > schema.maxItems) {
			errors.push({ path: at, message: `Must have at most ${schema.maxItems} items.` });
		}
		if (schema.uniqueItems) {
			const seen = new Set<string>();
			value.forEach((item, index) => {
				const key = JSON.stringify(item);
				if (seen.has(key)) errors.push({ path: `${path}/${index}`, message: 'Duplicate item; items must be unique.' });
				seen.add(key);
			});
		}
		if (schema.items) {
			value.forEach((item, index) => {
				errors.push(...recurse(item, schema.items, `${path}/${index}`));
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
				errors.push(...recurse(child, properties[key], `${path}/${key}`));
			} else if (schema.additionalProperties === false) {
				const known = Object.keys(properties);
				errors.push({
					path: `${path}/${key}`,
					message: `Unknown property "${key}".${closestName(key, known)}${known.length ? ` Allowed: ${known.join(', ')}.` : ''}`
				});
			} else if (typeof schema.additionalProperties === 'object') {
				errors.push(...recurse(child, schema.additionalProperties, `${path}/${key}`));
			}
		}
	}

	return errors;
}

/** Edit distance between two short strings (case-insensitive). */
function editDistance(a: string, b: string): number {
	a = a.toLowerCase();
	b = b.toLowerCase();
	const row = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		let prev = row[0];
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = row[j];
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = tmp;
		}
	}
	return row[b.length];
}

/** ` Did you mean "x"?` for the nearest known name within a couple of edits, else ''. */
function closestName(name: string, known: readonly string[]): string {
	let best = '';
	let bestDistance = Infinity;
	for (const k of known) {
		const d = editDistance(name, k);
		if (d < bestDistance) {
			best = k;
			bestDistance = d;
		}
	}
	return best && bestDistance <= Math.max(1, Math.min(2, Math.floor(name.length / 2))) ? ` Did you mean "${best}"?` : '';
}
