// Portions ported from figcraft/crates/doc/src/lib.rs and figcraft/crates/engine/src/cmd/variables.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { AUTO_LAYOUT_DATA_KEY, getAutoLayout, resolvePadding } from './autoLayout.js';
import { isShapeDescription } from './shapeGeometry.js';
import type { CanvasNode, CanvasNodeStyle } from './types.js';
import {
	TokenError,
	getTokenCollection,
	getTokenVariable,
	isTokenInScope,
	resolveToken,
	type TokenLiteral,
	type TokenModeContext,
	type TokenResolution,
	type TokenScope,
	type TokenState,
	type TokenType,
	type TokenVariable
} from '../tokens/index.js';

/**
 * Design-token bindings on canvas nodes.
 *
 * - `node.data.tokenBindings` maps a property key (`fill`, `opacity`, `gap`, …) to a variable id.
 * - `node.data.tokenModes` maps a collection id to a mode id: an explicit mode for the node and
 *   its descendants (via `parentId`); the nearest ancestor wins, then the root `modes` option,
 *   then the collection's default mode.
 *
 * Bound properties are *materialised*: `resolveCanvasTokens` writes the resolved values into
 * the ordinary node fields (`data.shape.fill`, `style.backgroundColor`, `data.layout.gap`, …), so
 * renderers, auto layout and exports need no token awareness, and a node whose variable is
 * gone keeps its last value. Both keys live in `data`, so they survive copy / paste,
 * duplication and serialisation unchanged.
 */

/** Data key holding a node's property → variable id bindings. */
export const TOKEN_BINDINGS_DATA_KEY = 'tokenBindings';
/** Data key holding a node's explicit collection → mode choices. */
export const TOKEN_MODES_DATA_KEY = 'tokenModes';

/** A node property a variable can drive. */
export interface CanvasTokenProperty {
	key: string;
	label: string;
	/** The variable type it takes. */
	type: TokenType;
	/** The scope pickers filter by (variables scoped elsewhere are not offered). */
	scope?: TokenScope | ((node: CanvasNode) => TokenScope | undefined);
	appliesTo(node: CanvasNode): boolean;
	read(node: CanvasNode): TokenLiteral | undefined;
	/** Returns the node with the value written, or the same node when nothing changes. */
	write(node: CanvasNode, value: TokenLiteral): CanvasNode;
}

// ---------------------------------------------------------------------------------------------
// Style helpers (CSS string for SvelteFlow, object for React Flow)

const kebab = (prop: string) => prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Splits a style string at top-level `;` (not inside quotes or parentheses, e.g. data URLs). */
function parseDeclarations(style: string): [string, string][] {
	const parts: string[] = [];
	let depth = 0;
	let quote = '';
	let start = 0;
	for (let i = 0; i < style.length; i++) {
		const ch = style[i];
		if (quote) {
			if (ch === '\\') i++;
			else if (ch === quote) quote = '';
		} else if (ch === '"' || ch === "'") quote = ch;
		else if (ch === '(') depth++;
		else if (ch === ')') depth = Math.max(0, depth - 1);
		else if (ch === ';' && depth === 0) {
			parts.push(style.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(style.slice(start));
	const out: [string, string][] = [];
	for (const part of parts) {
		const colon = part.indexOf(':');
		if (colon < 0) continue;
		const name = part.slice(0, colon).trim();
		if (name) out.push([name, part.slice(colon + 1).trim()]);
	}
	return out;
}

/** The top-level `name: value` declarations of a style string (names as written, in order). */
export function parseNodeStyleDeclarations(style: string): [string, string][] {
	return parseDeclarations(style);
}

/** A style property (camelCase name) from a style string or object. */
export function readNodeStyleProperty(style: CanvasNodeStyle | undefined | null, prop: string): string | number | undefined {
	if (!style) return undefined;
	if (typeof style === 'object') return style[prop];
	const name = kebab(prop);
	let found: string | undefined;
	for (const [key, value] of parseDeclarations(style)) if (key.toLowerCase() === name) found = value;
	return found;
}

/**
 * Returns `style` with one property set (or removed with `undefined`), keeping its
 * representation. Numbers become `px` in style strings unless `unitless`.
 */
export function writeNodeStyleProperty(
	style: CanvasNodeStyle | undefined | null,
	prop: string,
	value: string | number | undefined,
	unitless = false
): CanvasNodeStyle | undefined {
	if (typeof style === 'string') {
		const name = kebab(prop);
		const text = value === undefined ? undefined : typeof value === 'number' && !unitless ? `${value}px` : String(value);
		// Replace in place (keeping declaration order), drop duplicates, or append.
		const decls: [string, string][] = [];
		let placed = text === undefined;
		for (const [key, current] of parseDeclarations(style)) {
			if (key.toLowerCase() !== name) decls.push([key, current]);
			else if (!placed) {
				decls.push([name, text!]);
				placed = true;
			}
		}
		if (!placed) decls.push([name, text!]);
		return decls.map(([k, v]) => `${k}: ${v}`).join('; ');
	}
	const next: Record<string, any> = { ...(style ?? {}) };
	if (value === undefined) delete next[prop];
	else next[prop] = value;
	return next;
}

function px(value: unknown): number | undefined {
	if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
	if (typeof value === 'string') {
		const n = parseFloat(value);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

function withStyle(node: CanvasNode, prop: string, value: string | number, unitless = false): CanvasNode {
	const current = readNodeStyleProperty(node.style, prop);
	const written = typeof node.style === 'string' && typeof value === 'number' && !unitless ? `${value}px` : value;
	if (typeof node.style === 'string' ? current === String(written) : current === value) return node;
	return { ...node, style: writeNodeStyleProperty(node.style, prop, value, unitless) };
}

function shapeOf(node: CanvasNode): Record<string, any> | null {
	const shape = node.data?.shape;
	return isShapeDescription(shape) ? (shape as Record<string, any>) : null;
}

function withShape(node: CanvasNode, key: string, value: unknown): CanvasNode {
	const shape = shapeOf(node)!;
	if (shape[key] === value) return node;
	return { ...node, data: { ...node.data, shape: { ...shape, [key]: value } } };
}

const nonNegative = (v: TokenLiteral) => Math.max(0, v as number);

function styleOrShape(key: 'fill' | 'stroke' | 'strokeWidth', styleProp: (node: CanvasNode) => string, convert: (v: TokenLiteral) => TokenLiteral = (v) => v) {
	return {
		read(node: CanvasNode): TokenLiteral | undefined {
			const shape = shapeOf(node);
			if (shape) return shape[key];
			const value = readNodeStyleProperty(node.style, styleProp(node));
			return key === 'strokeWidth' ? px(value) : (value as TokenLiteral | undefined);
		},
		write(node: CanvasNode, value: TokenLiteral): CanvasNode {
			const v = convert(value);
			if (shapeOf(node)) return withShape(node, key, v);
			let next = withStyle(node, styleProp(node), v as string | number);
			if (key === 'strokeWidth' && readNodeStyleProperty(next.style, 'borderStyle') === undefined) {
				next = { ...next, style: writeNodeStyleProperty(next.style, 'borderStyle', 'solid') };
			}
			return next;
		}
	};
}

function backgroundProp(node: CanvasNode): string {
	return readNodeStyleProperty(node.style, 'backgroundColor') === undefined && readNodeStyleProperty(node.style, 'background') !== undefined
		? 'background'
		: 'backgroundColor';
}

function layoutProperty(key: string, label: string, read: (l: Record<string, any>) => number | undefined, write: (l: Record<string, any>, v: number) => Record<string, any>): CanvasTokenProperty {
	return {
		key,
		label,
		type: 'number',
		scope: 'GAP',
		appliesTo: (node) => getAutoLayout(node) !== undefined,
		read: (node) => {
			const layout = getAutoLayout(node);
			return layout ? read(layout as Record<string, any>) : undefined;
		},
		write: (node, value) => {
			const layout = getAutoLayout(node) as Record<string, any> | undefined;
			if (!layout || read(layout) === value) return node;
			return { ...node, data: { ...node.data, [AUTO_LAYOUT_DATA_KEY]: write(layout, value as number) } };
		}
	};
}

type Side = 'top' | 'right' | 'bottom' | 'left';
const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];

function paddingProperty(key: string, label: string, sides: Side[]): CanvasTokenProperty {
	return layoutProperty(
		key,
		label,
		(layout) => {
			const p = resolvePadding(layout.padding);
			const values = sides.map((s) => p[SIDES.indexOf(s)]);
			return values.every((v) => v === values[0]) ? values[0] : undefined;
		},
		(layout, value) => {
			const p = resolvePadding(layout.padding);
			const v = Math.max(0, value);
			const padding = { top: p[0], right: p[1], bottom: p[2], left: p[3] };
			for (const s of sides) padding[s] = v;
			return { ...layout, padding };
		}
	);
}

/** The built-in bindable properties. */
export const CANVAS_TOKEN_PROPERTIES: readonly CanvasTokenProperty[] = [
	{
		key: 'fill',
		label: 'Fill',
		type: 'color',
		scope: (node) => (shapeOf(node) ? 'SHAPE_FILL' : node.type === 'text' ? 'TEXT_FILL' : 'FRAME_FILL'),
		appliesTo: () => true,
		...styleOrShape('fill', backgroundProp)
	},
	{
		key: 'stroke',
		label: 'Stroke',
		type: 'color',
		scope: 'STROKE_COLOR',
		appliesTo: () => true,
		...styleOrShape('stroke', () => 'borderColor')
	},
	{
		key: 'strokeWidth',
		label: 'Stroke width',
		type: 'number',
		scope: 'STROKE_FLOAT',
		appliesTo: () => true,
		...styleOrShape('strokeWidth', () => 'borderWidth', nonNegative)
	},
	{
		key: 'opacity',
		label: 'Opacity',
		type: 'number',
		scope: 'OPACITY',
		appliesTo: () => true,
		// Opacity variables are percentages (figcraft / Figma): 40 → 0.4, clamped to 0–100.
		read: (node) => {
			const v = px(readNodeStyleProperty(node.style, 'opacity'));
			return v === undefined ? undefined : Math.round(v * 10000) / 100;
		},
		write: (node, value) => withStyle(node, 'opacity', Math.min(1, Math.max(0, (value as number) / 100)), true)
	},
	{
		key: 'cornerRadius',
		label: 'Corner radius',
		type: 'number',
		scope: 'CORNER_RADIUS',
		appliesTo: (node) => {
			const shape = shapeOf(node);
			return !shape || shape.kind === 'rect';
		},
		read: (node) => {
			const shape = shapeOf(node);
			if (shape) return typeof shape.cornerRadius === 'number' ? shape.cornerRadius : undefined;
			return px(readNodeStyleProperty(node.style, 'borderRadius'));
		},
		write: (node, value) => {
			const v = Math.max(0, value as number);
			return shapeOf(node) ? withShape(node, 'cornerRadius', v) : withStyle(node, 'borderRadius', v);
		}
	},
	layoutProperty('gap', 'Gap', (l) => (typeof l.gap === 'number' ? l.gap : 0), (l, v) => ({ ...l, gap: v })),
	layoutProperty('rowGap', 'Row gap', (l) => (typeof l.rowGap === 'number' ? l.rowGap : undefined), (l, v) => ({ ...l, rowGap: v })),
	paddingProperty('padding', 'Padding', ['top', 'right', 'bottom', 'left']),
	paddingProperty('paddingHorizontal', 'Horizontal padding', ['left', 'right']),
	paddingProperty('paddingVertical', 'Vertical padding', ['top', 'bottom']),
	paddingProperty('paddingTop', 'Top padding', ['top']),
	paddingProperty('paddingRight', 'Right padding', ['right']),
	paddingProperty('paddingBottom', 'Bottom padding', ['bottom']),
	paddingProperty('paddingLeft', 'Left padding', ['left']),
	{
		key: 'textColor',
		label: 'Text colour',
		type: 'color',
		scope: 'TEXT_FILL',
		appliesTo: (node) => !shapeOf(node),
		read: (node) => readNodeStyleProperty(node.style, 'color') as string | undefined,
		write: (node, value) => withStyle(node, 'color', value as string)
	},
	{
		key: 'fontSize',
		label: 'Font size',
		type: 'number',
		scope: 'FONT_SIZE',
		appliesTo: (node) => !shapeOf(node),
		read: (node) => px(readNodeStyleProperty(node.style, 'fontSize')),
		write: (node, value) => withStyle(node, 'fontSize', Math.max(0, value as number))
	},
	{
		key: 'visible',
		label: 'Visible',
		type: 'boolean',
		appliesTo: () => true,
		read: (node) => !node.hidden,
		write: (node, value) => (!node.hidden === value ? node : { ...node, hidden: !value })
	}
];

export interface CanvasTokenOptions {
	/** Modes for nodes without an explicit mode up their tree (e.g. the page's). */
	modes?: TokenModeContext;
	/** Bindable properties (default {@link CANVAS_TOKEN_PROPERTIES}); add your own to extend. */
	properties?: readonly CanvasTokenProperty[];
}

const EMPTY: Readonly<Record<string, string>> = Object.freeze({});

function stringRecord(value: unknown): Readonly<Record<string, string>> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return EMPTY;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
	return out;
}

/** The node's property → variable id bindings. */
export function getNodeTokenBindings(node: CanvasNode | undefined | null): Readonly<Record<string, string>> {
	return stringRecord(node?.data?.[TOKEN_BINDINGS_DATA_KEY]);
}

/** The node's own explicit modes (collection id → mode id). */
export function getNodeTokenModes(node: CanvasNode | undefined | null): Readonly<Record<string, string>> {
	return stringRecord(node?.data?.[TOKEN_MODES_DATA_KEY]);
}

export function getCanvasTokenProperty(key: string, options: CanvasTokenOptions = {}): CanvasTokenProperty | undefined {
	return (options.properties ?? CANVAS_TOKEN_PROPERTIES).find((p) => p.key === key);
}

/** Properties a variable can be bound to on this node. */
export function getBindableTokenProperties(node: CanvasNode, options: CanvasTokenOptions = {}): CanvasTokenProperty[] {
	return (options.properties ?? CANVAS_TOKEN_PROPERTIES).filter((p) => p.appliesTo(node));
}

/** The scope of a property on a node. */
export function getTokenPropertyScope(property: CanvasTokenProperty, node: CanvasNode): TokenScope | undefined {
	return typeof property.scope === 'function' ? property.scope(node) : property.scope;
}

/** Variables a picker offers for `property` on `node`: the property's type, in scope. */
export function getTokensForProperty(state: TokenState, property: CanvasTokenProperty, node: CanvasNode): TokenVariable[] {
	const scope = getTokenPropertyScope(property, node);
	return state.variables.filter((v) => v.type === property.type && isTokenInScope(v, scope));
}

function lookupOf(nodes: readonly CanvasNode[]): Map<string, CanvasNode> {
	return new Map(nodes.map((n) => [n.id, n]));
}

function validModes(state: TokenState | undefined, modes: Readonly<Record<string, string>>, into: Record<string, string>): void {
	for (const [collectionId, modeId] of Object.entries(modes)) {
		if (state) {
			const collection = getTokenCollection(state, collectionId);
			// An unknown collection or mode counts as "Auto" (figcraft resets them to Auto).
			if (!collection || !collection.modes.some((m) => m.id === modeId)) continue;
		}
		into[collectionId] = modeId;
	}
}

/**
 * The modes `node` is in: the root `modes`, overridden by each ancestor's explicit modes from
 * the top down, then the node's own. Modes `state` doesn't know are ignored.
 */
export function getEffectiveTokenModes(
	node: CanvasNode,
	nodes: readonly CanvasNode[] | ReadonlyMap<string, CanvasNode>,
	state?: TokenState,
	options: Pick<CanvasTokenOptions, 'modes'> = {}
): Record<string, string> {
	const lookup = nodes instanceof Map ? nodes : lookupOf(nodes as readonly CanvasNode[]);
	const chain: CanvasNode[] = [];
	const seen = new Set<string>();
	for (let at: CanvasNode | undefined = node; at && !seen.has(at.id); at = at.parentId ? lookup.get(at.parentId) : undefined) {
		seen.add(at.id);
		chain.push(at);
	}
	const out: Record<string, string> = {};
	if (options.modes) validModes(state, options.modes, out);
	for (let i = chain.length - 1; i >= 0; i--) validModes(state, getNodeTokenModes(chain[i]), out);
	return out;
}

function modesResolver(nodes: readonly CanvasNode[], state: TokenState, options: CanvasTokenOptions) {
	const lookup = lookupOf(nodes);
	const memo = new Map<string, Record<string, string>>();
	const root: Record<string, string> = {};
	if (options.modes) validModes(state, options.modes, root);
	const visiting = new Set<string>();
	const modesOf = (node: CanvasNode): Record<string, string> => {
		const cached = memo.get(node.id);
		if (cached) return cached;
		let base = root;
		if (node.parentId && !visiting.has(node.id)) {
			const parent = lookup.get(node.parentId);
			if (parent) {
				visiting.add(node.id);
				base = modesOf(parent);
				visiting.delete(node.id);
			}
		}
		const own = getNodeTokenModes(node);
		let result = base;
		if (Object.keys(own).length > 0) {
			result = { ...base };
			validModes(state, own, result);
		}
		memo.set(node.id, result);
		return result;
	};
	return { lookup, modesOf };
}

function applyBindings(node: CanvasNode, state: TokenState, modes: TokenModeContext, options: CanvasTokenOptions, only?: ReadonlySet<string>): CanvasNode {
	const bindings = getNodeTokenBindings(node);
	let next = node;
	for (const [key, variableId] of Object.entries(bindings)) {
		if (only && !only.has(variableId)) continue;
		const property = getCanvasTokenProperty(key, options);
		if (!property || !property.appliesTo(next)) continue;
		const resolved = resolveToken(state, variableId, modes);
		if (!resolved.ok || resolved.type !== property.type) continue;
		next = property.write(next, resolved.value);
	}
	return next;
}

/**
 * Writes every bound property's resolved value into its node. Returns the same array when
 * nothing changed (unchanged nodes keep their identity), so it is safe to run on every change.
 * Bindings that don't resolve (deleted variable, cycle) keep the node's current value.
 */
export function resolveCanvasTokens<TNode extends CanvasNode>(nodes: readonly TNode[], state: TokenState, options: CanvasTokenOptions = {}): TNode[] {
	const { modesOf } = modesResolver(nodes, state, options);
	let changed = false;
	const out = nodes.map((node) => {
		if (Object.keys(getNodeTokenBindings(node)).length === 0) return node;
		const next = applyBindings(node, state, modesOf(node), options);
		if (next !== node) changed = true;
		return next as TNode;
	});
	return changed ? out : (nodes as TNode[]);
}

export interface CanvasTokenBindingInfo {
	property: CanvasTokenProperty;
	variableId: string;
	variable: TokenVariable | undefined;
	resolution: TokenResolution;
}

/** Each binding of a node with its variable and resolution (for inspectors and diagnostics). */
export function inspectNodeTokens(
	node: CanvasNode,
	nodes: readonly CanvasNode[],
	state: TokenState,
	options: CanvasTokenOptions = {}
): CanvasTokenBindingInfo[] {
	const modes = getEffectiveTokenModes(node, nodes, state, options);
	const out: CanvasTokenBindingInfo[] = [];
	for (const [key, variableId] of Object.entries(getNodeTokenBindings(node))) {
		const property = getCanvasTokenProperty(key, options);
		if (!property) continue;
		out.push({ property, variableId, variable: getTokenVariable(state, variableId), resolution: resolveToken(state, variableId, modes) });
	}
	return out;
}

function setDataRecord(node: CanvasNode, key: string, record: Record<string, string>): CanvasNode {
	const data = { ...node.data };
	if (Object.keys(record).length === 0) delete data[key];
	else data[key] = record;
	return { ...node, data };
}

/**
 * Binds `property` of each node in `ids` to `variableId` (or unbinds with `null`, keeping the
 * current value) and resolves. Throws `type-mismatch` when the variable's type doesn't fit the
 * property, `not-found` for unknown variables or properties. Nodes the property doesn't apply
 * to are left alone.
 */
export function bindCanvasToken<TNode extends CanvasNode>(
	nodes: readonly TNode[],
	ids: Iterable<string>,
	propertyKey: string,
	variableId: string | null,
	state: TokenState,
	options: CanvasTokenOptions = {}
): TNode[] {
	const property = getCanvasTokenProperty(propertyKey, options);
	if (!property) throw new TokenError('not-found', `No bindable property \`${propertyKey}\``);
	if (variableId !== null) {
		const variable = getTokenVariable(state, variableId);
		if (!variable) throw new TokenError('not-found', `No variable \`${variableId}\``);
		if (variable.type !== property.type) {
			throw new TokenError('type-mismatch', `${property.label} takes a ${property.type} variable; \`${variable.name}\` is a ${variable.type}`);
		}
	}
	const targets = new Set(ids);
	let changed = false;
	const bound = nodes.map((node) => {
		if (!targets.has(node.id) || !property.appliesTo(node)) return node;
		const bindings = { ...getNodeTokenBindings(node) };
		if (variableId === null) {
			if (!(propertyKey in bindings)) return node;
			delete bindings[propertyKey];
		} else {
			if (bindings[propertyKey] === variableId) return node;
			bindings[propertyKey] = variableId;
		}
		changed = true;
		return setDataRecord(node, TOKEN_BINDINGS_DATA_KEY, bindings) as TNode;
	});
	return changed ? resolveCanvasTokens(bound, state, options) : (nodes as TNode[]);
}

/**
 * Sets (or with `null` clears, back to "Auto") the explicit mode of `collectionId` on each node
 * in `ids`, then resolves, so descendants follow.
 */
export function setCanvasTokenMode<TNode extends CanvasNode>(
	nodes: readonly TNode[],
	ids: Iterable<string>,
	collectionId: string,
	modeId: string | null,
	state: TokenState,
	options: CanvasTokenOptions = {}
): TNode[] {
	if (modeId !== null) {
		const collection = getTokenCollection(state, collectionId);
		if (!collection) throw new TokenError('not-found', `No collection \`${collectionId}\``);
		if (!collection.modes.some((m) => m.id === modeId)) throw new TokenError('not-found', `No mode \`${modeId}\` in \`${collection.name}\``);
	}
	const targets = new Set(ids);
	let changed = false;
	const next = nodes.map((node) => {
		if (!targets.has(node.id)) return node;
		const modes = { ...getNodeTokenModes(node) };
		if (modeId === null) {
			if (!(collectionId in modes)) return node;
			delete modes[collectionId];
		} else {
			if (modes[collectionId] === modeId) return node;
			modes[collectionId] = modeId;
		}
		changed = true;
		return setDataRecord(node, TOKEN_MODES_DATA_KEY, modes) as TNode;
	});
	return changed ? resolveCanvasTokens(next, state, options) : (nodes as TNode[]);
}

/**
 * Detaches bindings to `variableIds` (default: every binding whose variable is missing from
 * `state`): each property keeps its value resolved in `state` and the binding is removed. Pass
 * the state from *before* a delete (`TokenChangeEvent.previous`) so deleted variables still
 * resolve.
 */
export function detachTokenBindings<TNode extends CanvasNode>(
	nodes: readonly TNode[],
	state: TokenState,
	variableIds?: Iterable<string>,
	options: CanvasTokenOptions = {}
): TNode[] {
	const only = variableIds ? new Set(variableIds) : null;
	const isDetached = (id: string) => (only ? only.has(id) : !getTokenVariable(state, id));
	const { modesOf } = modesResolver(nodes, state, options);
	let changed = false;
	const out = nodes.map((node) => {
		const bindings = getNodeTokenBindings(node);
		const gone = Object.entries(bindings).filter(([, id]) => isDetached(id));
		if (gone.length === 0) return node;
		let next = applyBindings(node, state, modesOf(node), options, new Set(gone.map(([, id]) => id)));
		const kept = { ...bindings };
		for (const [key] of gone) delete kept[key];
		next = setDataRecord(next, TOKEN_BINDINGS_DATA_KEY, kept);
		changed = true;
		return next as TNode;
	});
	return changed ? out : (nodes as TNode[]);
}

/**
 * Removes explicit modes `state` no longer knows (deleted collections or modes), like figcraft
 * resetting such layers to "Auto". Resolution already ignores them; this tidies the data.
 */
export function pruneCanvasTokenModes<TNode extends CanvasNode>(nodes: readonly TNode[], state: TokenState): TNode[] {
	let changed = false;
	const out = nodes.map((node) => {
		const modes = getNodeTokenModes(node);
		const valid: Record<string, string> = {};
		validModes(state, modes, valid);
		if (Object.keys(valid).length === Object.keys(modes).length) return node;
		changed = true;
		return setDataRecord(node, TOKEN_MODES_DATA_KEY, valid) as TNode;
	});
	return changed ? out : (nodes as TNode[]);
}
