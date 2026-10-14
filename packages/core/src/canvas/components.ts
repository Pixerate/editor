// Portions ported from figcraft/crates/engine/src/components.rs and figcraft/crates/engine/src/cmd/component.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { applyNodeUpdates, getAbsolutePosition, getNodeSize, readStyleSize, type CanvasNodeUpdate } from './arrange.js';
import { applyConstraints, getAutoLayout, getChildLayout, getLayoutSizing, layoutUpMany, type AutoLayoutOptions } from './autoLayout.js';
import {
	getCanvasTokenProperty,
	parseNodeStyleDeclarations,
	readNodeStyleProperty,
	resolveCanvasTokens,
	writeNodeStyleProperty,
	type CanvasTokenOptions
} from './tokenBindings.js';
import type { TokenState } from '../tokens/index.js';
import type { CanvasNode, XYPosition } from './types.js';

/**
 * Figma-style components and instances on the canvas.
 *
 * - A **main component** is a node with `data.component` (a frame whose children, via
 *   `parentId`, are its layers). A **component set** (`data.componentSet`) holds variants:
 *   components with `data.component.variant` (`{ Size: 'Small', Style: 'Primary' }`).
 * - An **instance** is a node with `data.instance = { componentId, properties }`. Its layers are
 *   real nodes copied from the main; every copy records the main layer it mirrors in
 *   `data.componentSource` and the property groups changed locally in
 *   `data.componentOverrides` (`data.label`, `style.backgroundColor`, `shape.fill`,
 *   `layout.gap`, `token.fill`, `hidden`, …).
 * - When a main changes, its instances are rebuilt from it, keeping layer ids and re-applying
 *   overrides (matched by source, then by layer name path, so switching variants keeps
 *   compatible overrides). Component properties (boolean → visibility, text → a `data` field,
 *   instance swap → a nested instance's main) are applied through `data.componentPropertyRefs`
 *   on the main's layers.
 * - Instances never gain or lose layers: deleting a layer inside an instance hides it, and
 *   nodes added inside one move out next to it. Geometry of layers inside an instance follows
 *   the main (and constraints / auto layout); only the instance itself resizes.
 * - An instance whose main was deleted keeps its layers ("missing main") and can restore it.
 *
 * Everything lives in `data`, so components and instances survive JSON, copy / paste and
 * duplication; `syncCanvasComponents(before, after)` relinks what a paste brought in.
 */

/** Data key of a main component's definition. */
export const COMPONENT_DATA_KEY = 'component';
/** Data key of a component set's definition (its variants are its child components). */
export const COMPONENT_SET_DATA_KEY = 'componentSet';
/** Data key of an instance's link to its main (`componentId`) and its property values. */
export const INSTANCE_DATA_KEY = 'instance';
/** Data key of the main-component layer an instance layer mirrors. */
export const COMPONENT_SOURCE_DATA_KEY = 'componentSource';
/** Data key of the override groups of an instance layer. */
export const COMPONENT_OVERRIDES_DATA_KEY = 'componentOverrides';
/** Data key of a main layer's component property bindings (field → property name). */
export const COMPONENT_PROPERTY_REFS_DATA_KEY = 'componentPropertyRefs';

/** Nesting limit for instances inside instances. */
const MAX_DEPTH = 16;

export type CanvasComponentPropertyType = 'boolean' | 'text' | 'instanceSwap';

export type CanvasComponentPropertyDef =
	| { type: 'boolean'; default: boolean; description?: string }
	| { type: 'text'; default: string; description?: string }
	| { type: 'instanceSwap'; default: string; preferred?: string[]; description?: string };

export type CanvasComponentPropertyValue = boolean | string;

export interface CanvasComponentData {
	description?: string;
	/** Component properties (on a lone component; variants share their set's). */
	properties?: Record<string, CanvasComponentPropertyDef>;
	/** Variant property values of a component inside a set. */
	variant?: Record<string, string>;
}

export interface CanvasComponentSetData {
	description?: string;
	/** Component properties shared by every variant. */
	properties?: Record<string, CanvasComponentPropertyDef>;
}

export interface CanvasInstanceData {
	componentId: string;
	properties?: Record<string, CanvasComponentPropertyValue>;
}

/**
 * A field a component property drives on a main layer: `visible` (boolean), `component` (instance
 * swap, on a nested instance) or a `data.<key>` field (text, e.g. `data.label`).
 */
export type CanvasComponentPropertyField = 'visible' | 'component' | `data.${string}`;

export type CanvasComponentErrorCode =
	| 'not-found'
	| 'invalid'
	| 'cycle'
	| 'inside-instance'
	| 'nested-instance'
	| 'missing-main'
	| 'no-overrides'
	| 'unknown-property'
	| 'type-mismatch';

export type CanvasComponentResult<TNode extends CanvasNode = CanvasNode> =
	| { ok: true; nodes: TNode[]; ids: string[] }
	| { ok: false; nodes: TNode[]; code: CanvasComponentErrorCode; reason: string };

export interface CanvasComponentSyncOptions {
	/** Ids for new layer copies (default `<instanceId>:<sourceId>`, made unique). */
	idGenerator?: (instanceId: string, sourceId: string) => string;
	/** Node types whose overrides all survive variant switches (default `['text']`). */
	textTypes?: readonly string[];
	/** Re-run auto layout inside rebuilt instances (default `true`). */
	layout?: boolean | AutoLayoutOptions;
	/**
	 * Resolves token bindings after a sync when `state` is given (bindings inside instances
	 * resolve in the instance's own modes). Bindings are always compared, never values.
	 */
	tokens?: CanvasTokenOptions & { state?: TokenState };
}

export interface CreateCanvasComponentOptions extends CanvasComponentSyncOptions {
	/** Id of the wrapping frame (when the selection is wrapped). */
	id?: string;
	/** Node type of the wrapping frame (default `group`). */
	frameType?: string;
	/** Node types that become a component themselves instead of being wrapped (default `['group', 'frame']`). */
	frameTypes?: readonly string[];
	/** Name (`data.label`) of a wrapping frame. */
	name?: string;
}

export interface CreateCanvasInstanceOptions extends CanvasComponentSyncOptions {
	id?: string;
	/** Frame to place the instance in (must not be inside its own main or an instance). */
	parentId?: string;
	/** Position in the parent's space (default: right of the main, or 0,0 in a parent). */
	position?: XYPosition;
	/** Property values (variant properties pick the variant). */
	properties?: Record<string, CanvasComponentPropertyValue>;
}

// ---------------------------------------------------------------------------------------------
// Small helpers

type Data = Record<string, any>;
type Value = CanvasComponentPropertyValue;

const isRecord = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const dataOf = (node: CanvasNode | undefined | null): Data => (isRecord(node?.data) ? (node!.data as Data) : {});

/** Structural equality of JSON-like values (`undefined` members are ignored). */
function same(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
		return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
	}
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) {
		const other = b as unknown[];
		return a.length === other.length && a.every((x, i) => same(x, other[i]));
	}
	const ra = a as Record<string, unknown>;
	const rb = b as Record<string, unknown>;
	const ka = Object.keys(ra).filter((k) => ra[k] !== undefined);
	const kb = Object.keys(rb).filter((k) => rb[k] !== undefined);
	return ka.length === kb.length && ka.every((k) => same(ra[k], rb[k]));
}

function stringRecord(value: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (isRecord(value)) for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
	return out;
}

/** Whether `node` is a main component. */
export function isCanvasComponent(node: CanvasNode | undefined | null): boolean {
	return isRecord(dataOf(node)[COMPONENT_DATA_KEY]);
}

/** Whether `node` is a component set. */
export function isCanvasComponentSet(node: CanvasNode | undefined | null): boolean {
	return isRecord(dataOf(node)[COMPONENT_SET_DATA_KEY]);
}

/** Whether `node` is an instance (top-level or nested). */
export function isCanvasInstance(node: CanvasNode | undefined | null): boolean {
	const inst = dataOf(node)[INSTANCE_DATA_KEY];
	return isRecord(inst) && typeof inst.componentId === 'string';
}

/** The instance data of `node`, if it is an instance. */
export function getInstanceData(node: CanvasNode | undefined | null): CanvasInstanceData | undefined {
	return isCanvasInstance(node) ? (dataOf(node)[INSTANCE_DATA_KEY] as CanvasInstanceData) : undefined;
}

/** The component definition of `node`, if it is a main component. */
export function getComponentData(node: CanvasNode | undefined | null): CanvasComponentData | undefined {
	return isCanvasComponent(node) ? (dataOf(node)[COMPONENT_DATA_KEY] as CanvasComponentData) : undefined;
}

/** The main-component layer an instance layer mirrors. */
export function getComponentSourceId(node: CanvasNode | undefined | null): string | undefined {
	const s = dataOf(node)[COMPONENT_SOURCE_DATA_KEY];
	return typeof s === 'string' ? s : undefined;
}

/** The override groups of an instance layer. */
export function getNodeOverrides(node: CanvasNode | undefined | null): readonly string[] {
	const o = dataOf(node)[COMPONENT_OVERRIDES_DATA_KEY];
	return Array.isArray(o) ? o.filter((g): g is string => typeof g === 'string') : [];
}

/** Component property bindings of a main layer (field → property name). */
export function getComponentPropertyRefs(node: CanvasNode | undefined | null): Readonly<Record<string, string>> {
	return stringRecord(dataOf(node)[COMPONENT_PROPERTY_REFS_DATA_KEY]);
}

/** A layer's display name: `data.name`, then `data.label`, then `data.text`, then its type. */
export function getLayerName(node: CanvasNode | undefined | null): string {
	const d = dataOf(node);
	for (const key of ['name', 'label', 'text']) if (typeof d[key] === 'string' && d[key]) return d[key];
	return typeof node?.type === 'string' ? node.type : '';
}

function withData<T extends CanvasNode>(node: T, data: Data): T {
	return { ...node, data } as T;
}

function setOverrides<T extends CanvasNode>(node: T, groups: Iterable<string>): T {
	const list = [...new Set(groups)].sort();
	const data = { ...dataOf(node) };
	if (list.length) data[COMPONENT_OVERRIDES_DATA_KEY] = list;
	else delete data[COMPONENT_OVERRIDES_DATA_KEY];
	return same(getNodeOverrides(node), list) ? node : withData(node, data);
}

/** Removes the component link keys (source, overrides, property refs) from a node's data. */
function unlinked<T extends CanvasNode>(node: T, keepRefs = false): T {
	const d = dataOf(node);
	if (!(COMPONENT_SOURCE_DATA_KEY in d) && !(COMPONENT_OVERRIDES_DATA_KEY in d) && (keepRefs || !(COMPONENT_PROPERTY_REFS_DATA_KEY in d))) return node;
	const data = { ...d };
	delete data[COMPONENT_SOURCE_DATA_KEY];
	delete data[COMPONENT_OVERRIDES_DATA_KEY];
	if (!keepRefs) delete data[COMPONENT_PROPERTY_REFS_DATA_KEY];
	return withData(node, data);
}

// ---------------------------------------------------------------------------------------------
// Override groups: property paths of a node

const LINK_KEYS = new Set([
	COMPONENT_DATA_KEY,
	COMPONENT_SET_DATA_KEY,
	INSTANCE_DATA_KEY,
	COMPONENT_SOURCE_DATA_KEY,
	COMPONENT_OVERRIDES_DATA_KEY,
	COMPONENT_PROPERTY_REFS_DATA_KEY
]);
const NESTED_KEYS: Record<string, string> = { shape: 'shape', layout: 'layout', tokenBindings: 'token', tokenModes: 'tokenMode' };
const NESTED_PREFIX: Record<string, string> = { shape: 'shape', layout: 'layout', token: 'tokenBindings', tokenMode: 'tokenModes' };
/** Node fields that are structure, runtime state or handled by their own group. */
const SKIPPED_NODE_KEYS = new Set([
	'id',
	'parentId',
	'parentNode',
	'position',
	'positionAbsolute',
	'selected',
	'dragging',
	'resizing',
	'measured',
	'width',
	'height',
	'style',
	'data',
	'hidden',
	'internals',
	'computed',
	'handleBounds'
]);
const RUNTIME_KEYS = ['selected', 'dragging', 'resizing'] as const;
const UNITLESS = new Set(['opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'order', 'zoom']);

/** Groups an instance root keeps as its own (placement, visibility, lock, modes); never overrides. */
const OWN_ROOT_GROUPS = new Set([
	'position',
	'hidden',
	'component',
	'props',
	'data.locked',
	'data.lockedPrevious',
	'data.childLayout',
	'node.draggable',
	'node.selectable',
	'node.deletable',
	'node.connectable',
	'node.zIndex',
	'node.extent',
	'node.expandParent'
]);
const isOwnRootGroup = (g: string) => OWN_ROOT_GROUPS.has(g) || g.startsWith('tokenMode.');

const camel = (name: string) => (name.startsWith('--') ? name : name.trim().toLowerCase().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()));

function styleKeys(style: CanvasNode['style']): string[] {
	if (!style) return [];
	if (typeof style === 'object') return Object.keys(style).filter((k) => style[k] !== undefined);
	return parseNodeStyleDeclarations(style).map(([k]) => camel(k));
}

function sizeOf(node: CanvasNode) {
	const s = readStyleSize(node.style);
	return { width: node.width, height: node.height, styleWidth: s.width, styleHeight: s.height };
}

const splitGroup = (group: string): [string, string] => {
	const dot = group.indexOf('.');
	return dot < 0 ? [group, ''] : [group.slice(0, dot), group.slice(dot + 1)];
};

/** Reads one override group (`hidden`, `size`, `position`, `style.<prop>`, `data.<key>`, …) of a node. */
export function readOverrideGroup(node: CanvasNode, group: string): unknown {
	const data = dataOf(node);
	switch (group) {
		case 'hidden':
			return node.hidden === true;
		case 'position':
			return node.position;
		case 'size':
			return sizeOf(node);
		case 'component':
			return getInstanceData(node)?.componentId;
		case 'props':
			return getInstanceData(node)?.properties ?? {};
	}
	const [kind, key] = splitGroup(group);
	switch (kind) {
		case 'style':
			return readNodeStyleProperty(node.style, key);
		case 'data':
			return data[key];
		case 'node':
			return (node as Data)[key];
	}
	const holder = NESTED_PREFIX[kind];
	if (holder) return isRecord(data[holder]) ? data[holder][key] : undefined;
	return undefined;
}

function withSize<T extends CanvasNode>(node: T, value: unknown): T {
	const v = (isRecord(value) ? value : {}) as ReturnType<typeof sizeOf>;
	const next = { ...node } as Data;
	if (v.width === undefined) delete next.width;
	else next.width = v.width;
	if (v.height === undefined) delete next.height;
	else next.height = v.height;
	const current = readStyleSize(node.style);
	let style = node.style;
	if (v.styleWidth !== current.width) style = writeNodeStyleProperty(style, 'width', v.styleWidth);
	if (v.styleHeight !== current.height) style = writeNodeStyleProperty(style, 'height', v.styleHeight);
	if (style !== node.style) next.style = style;
	const w = v.width ?? v.styleWidth;
	const h = v.height ?? v.styleHeight;
	if (node.measured && (w !== undefined || h !== undefined)) {
		next.measured = { ...node.measured, ...(w !== undefined ? { width: w } : {}), ...(h !== undefined ? { height: h } : {}) };
	}
	return next as T;
}

/** Returns `node` with one override group set to `value` (the same node when nothing changes). */
export function writeOverrideGroup<T extends CanvasNode>(node: T, group: string, value: unknown): T {
	if (same(readOverrideGroup(node, group), value)) return node;
	const next = { ...node } as Data;
	const data = { ...dataOf(node) };
	switch (group) {
		case 'hidden':
			if (value) next.hidden = true;
			else delete next.hidden;
			return next as T;
		case 'position':
			if (isRecord(value)) next.position = { x: value.x, y: value.y };
			return next as T;
		case 'size':
			return withSize(node, value);
		case 'component': {
			const inst = getInstanceData(node);
			if (!inst || typeof value !== 'string') return node;
			data[INSTANCE_DATA_KEY] = { ...inst, componentId: value };
			return withData(node, data);
		}
		case 'props': {
			const inst = getInstanceData(node);
			if (!inst) return node;
			data[INSTANCE_DATA_KEY] = { ...inst, properties: isRecord(value) ? { ...value } : {} };
			return withData(node, data);
		}
	}
	const [kind, key] = splitGroup(group);
	if (!key) return node;
	switch (kind) {
		case 'style': {
			const unitless = typeof value === 'number' && UNITLESS.has(key);
			next.style = writeNodeStyleProperty(node.style, key, value as string | number | undefined, unitless);
			return next as T;
		}
		case 'data':
			if (LINK_KEYS.has(key) || key in NESTED_KEYS) return node;
			if (value === undefined) delete data[key];
			else data[key] = value;
			return withData(node, data);
		case 'node':
			if (SKIPPED_NODE_KEYS.has(key)) return node;
			if (value === undefined) delete next[key];
			else next[key] = value;
			return next as T;
	}
	const holder = NESTED_PREFIX[kind];
	if (!holder) return node;
	const record = isRecord(data[holder]) ? { ...data[holder] } : {};
	if (value === undefined) delete record[key];
	else record[key] = value;
	if (Object.keys(record).length === 0 && (holder === 'tokenBindings' || holder === 'tokenModes')) delete data[holder];
	else data[holder] = record;
	return withData(node, data);
}

function listGroups(node: CanvasNode, out: Set<string>) {
	out.add('hidden');
	out.add('size');
	out.add('position');
	for (const k of styleKeys(node.style)) if (k !== 'width' && k !== 'height') out.add(`style.${k}`);
	const data = dataOf(node);
	for (const [k, v] of Object.entries(data)) {
		if (LINK_KEYS.has(k)) continue;
		const prefix = NESTED_KEYS[k];
		if (prefix) {
			if (isRecord(v)) for (const sub of Object.keys(v)) out.add(`${prefix}.${sub}`);
			continue;
		}
		out.add(`data.${k}`);
	}
	if (isCanvasInstance(node)) {
		out.add('component');
		out.add('props');
	}
	for (const k of Object.keys(node)) if (!SKIPPED_NODE_KEYS.has(k)) out.add(`node.${k}`);
}

/** Override groups whose values differ between two nodes. */
export function diffOverrideGroups(a: CanvasNode, b: CanvasNode): string[] {
	const groups = new Set<string>();
	listGroups(a, groups);
	listGroups(b, groups);
	return [...groups].filter((g) => !same(readOverrideGroup(a, g), readOverrideGroup(b, g)));
}

function copyGroups<T extends CanvasNode>(from: CanvasNode, to: T, groups: Iterable<string>): T {
	let next = to;
	for (const g of groups) next = writeOverrideGroup(next, g, readOverrideGroup(from, g));
	return next;
}

/** The group a component property field drives. */
function fieldGroup(field: string): string {
	return field === 'visible' ? 'hidden' : field;
}

// ---------------------------------------------------------------------------------------------
// Tree

class Graph {
	readonly byId: Map<string, CanvasNode>;
	private readonly kids = new Map<string, string[]>();

	constructor(readonly nodes: readonly CanvasNode[]) {
		this.byId = new Map(nodes.map((n) => [n.id, n]));
		for (const n of nodes) {
			if (!n.parentId || !this.byId.has(n.parentId)) continue;
			let list = this.kids.get(n.parentId);
			if (!list) this.kids.set(n.parentId, (list = []));
			list.push(n.id);
		}
	}

	get(id: string | undefined): CanvasNode | undefined {
		return id === undefined ? undefined : this.byId.get(id);
	}

	children(id: string): readonly string[] {
		return this.kids.get(id) ?? [];
	}

	/** `id` (optionally) and its ancestors, nearest first. */
	chain(id: string, self = true): CanvasNode[] {
		const out: CanvasNode[] = [];
		const seen = new Set<string>();
		let at = this.get(id);
		if (at && !self) {
			seen.add(at.id);
			at = this.get(at.parentId);
		}
		while (at && !seen.has(at.id)) {
			seen.add(at.id);
			out.push(at);
			at = this.get(at.parentId);
		}
		return out;
	}

	/** Whether `a` is a strict ancestor of `b`. */
	isAncestor(a: string, b: string): boolean {
		return this.chain(b, false).some((n) => n.id === a);
	}

	/** `id` and its descendants, pre-order. */
	subtree(id: string): string[] {
		const out: string[] = [];
		const seen = new Set<string>();
		const stack = [id];
		while (stack.length) {
			const at = stack.pop()!;
			if (seen.has(at) || !this.byId.has(at)) continue;
			seen.add(at);
			out.push(at);
			const kids = this.children(at);
			for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
		}
		return out;
	}
}

const owningComponentIn = (g: Graph, id: string) => g.chain(id).find(isCanvasComponent)?.id;
const owningInstanceIn = (g: Graph, id: string) => g.chain(id).find(isCanvasInstance)?.id;
const enclosingInstanceIn = (g: Graph, id: string) => g.chain(id, false).find(isCanvasInstance)?.id;
function rootInstanceIn(g: Graph, id: string): string | undefined {
	const list = g.chain(id).filter(isCanvasInstance);
	return list[list.length - 1]?.id;
}

function variantSetIn(g: Graph, componentId: string): CanvasNode | undefined {
	const comp = g.get(componentId);
	if (!isCanvasComponent(comp)) return undefined;
	const parent = g.get(comp!.parentId);
	return isCanvasComponentSet(parent) ? parent : undefined;
}

/** The variant property values of a component: `data.component.variant`, else parsed from its name. */
export function getVariantValues(node: CanvasNode | undefined | null): Record<string, string> {
	const explicit = getComponentData(node)?.variant;
	if (isRecord(explicit) && Object.keys(explicit).length) return stringRecord(explicit);
	const name = getLayerName(node);
	return name.includes('=') ? parseVariantName(name) : {};
}

/** Parses a variant name `Size=Large, State=Hover` into its pairs. */
export function parseVariantName(name: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of name.split(',')) {
		const eq = part.indexOf('=');
		if (eq < 0) continue;
		const k = part.slice(0, eq).trim();
		if (k) out[k] = part.slice(eq + 1).trim();
	}
	return out;
}

/** Formats variant pairs as a name, in `order` (other properties after, sorted). */
export function formatVariantName(pairs: Readonly<Record<string, string>>, order: readonly string[] = []): string {
	const keys = order.filter((k) => k in pairs);
	keys.push(...Object.keys(pairs).filter((k) => !order.includes(k)).sort());
	return keys.map((k) => `${k}=${pairs[k]}`).join(', ');
}

function variantsIn(g: Graph, setId: string): CanvasNode[] {
	return g.children(setId).map((id) => g.get(id)!).filter(isCanvasComponent);
}

function variantOptionsIn(g: Graph, setId: string): { name: string; values: string[] }[] {
	const out: { name: string; values: string[] }[] = [];
	for (const v of variantsIn(g, setId)) {
		for (const [k, value] of Object.entries(getVariantValues(v))) {
			let entry = out.find((o) => o.name === k);
			if (!entry) out.push((entry = { name: k, values: [] }));
			if (!entry.values.includes(value)) entry.values.push(value);
		}
	}
	return out;
}

/** A set's default variant: the one nearest its top-left corner. */
function defaultVariantIn(g: Graph, setId: string): string | undefined {
	let best: { key: [number, number, number]; id: string } | undefined;
	for (const v of variantsIn(g, setId)) {
		const { x, y } = v.position;
		const key: [number, number, number] = [x + y, y, x];
		if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && (key[1] < best.key[1] || (key[1] === best.key[1] && key[2] < best.key[2])))) {
			best = { key, id: v.id };
		}
	}
	return best?.id;
}

function findVariantIn(g: Graph, setId: string, wanted: Readonly<Record<string, string>>): string | undefined {
	const entries = Object.entries(wanted);
	let best: { score: number; id: string } | undefined;
	for (const v of variantsIn(g, setId)) {
		const values = getVariantValues(v);
		const score = entries.filter(([k, val]) => values[k] === val).length;
		if (score === entries.length) return v.id;
		if (!best || score > best.score) best = { score, id: v.id };
	}
	return best?.id;
}

/** The main component a component or set id stands for (a set's default variant). */
function mainOfIn(g: Graph, id: string): string | undefined {
	const node = g.get(id);
	if (isCanvasComponent(node)) return id;
	if (isCanvasComponentSet(node)) return defaultVariantIn(g, id);
	return undefined;
}

const siblingVariants = (g: Graph, a: string | undefined, b: string | undefined) =>
	!!a && !!b && a !== b && !!variantSetIn(g, a) && variantSetIn(g, a) === variantSetIn(g, b);

function propertyDefsIn(g: Graph, componentId: string): Record<string, CanvasComponentPropertyDef> {
	const comp = g.get(componentId);
	if (!isCanvasComponent(comp)) return {};
	const set = variantSetIn(g, componentId);
	const owner = set ? dataOf(set)[COMPONENT_SET_DATA_KEY] : dataOf(comp)[COMPONENT_DATA_KEY];
	return isRecord(owner?.properties) ? (owner.properties as Record<string, CanvasComponentPropertyDef>) : {};
}

function validValue(def: CanvasComponentPropertyDef, v: unknown): boolean {
	return def.type === 'boolean' ? typeof v === 'boolean' : typeof v === 'string';
}

function effectivePropsIn(g: Graph, componentId: string, values: Readonly<Record<string, unknown>> | undefined): Record<string, Value> {
	const out: Record<string, Value> = {};
	for (const [k, def] of Object.entries(propertyDefsIn(g, componentId))) {
		const v = values?.[k];
		out[k] = v !== undefined && validValue(def, v) ? (v as Value) : def.default;
	}
	return out;
}

/** Components instantiated (transitively) inside component `componentId`. */
function componentDepsIn(g: Graph, componentId: string): Set<string> {
	const deps = new Set<string>();
	const queue = [componentId];
	while (queue.length) {
		const c = queue.pop()!;
		for (const id of g.subtree(c)) {
			const target = getInstanceData(g.get(id))?.componentId;
			if (target && !deps.has(target)) {
				deps.add(target);
				queue.push(target);
			}
		}
	}
	return deps;
}

/** Whether placing an instance of `componentId` inside `parentId` would nest a component in itself. */
function createsCycleIn(g: Graph, componentId: string, parentId: string | undefined): boolean {
	if (!parentId) return false;
	const hosts = g.chain(parentId).filter(isCanvasComponent).map((n) => n.id);
	if (hosts.length === 0) return false;
	const deps = componentDepsIn(g, componentId);
	deps.add(componentId);
	return hosts.some((h) => deps.has(h));
}

/** Whether an instance of `componentId` placed in `parentId` would contain itself. */
export function wouldCreateComponentCycle(nodes: readonly CanvasNode[], componentId: string, parentId: string | undefined): boolean {
	const g = new Graph(nodes);
	return createsCycleIn(g, mainOfIn(g, componentId) ?? componentId, parentId);
}

// ---------------------------------------------------------------------------------------------
// Public queries

/** The component a node belongs to (itself, or its nearest component ancestor). */
export function getOwningComponent(nodes: readonly CanvasNode[], id: string): string | undefined {
	return owningComponentIn(new Graph(nodes), id);
}

/** The innermost instance containing `id` (`id` itself when it is an instance). */
export function getOwningInstance(nodes: readonly CanvasNode[], id: string): string | undefined {
	return owningInstanceIn(new Graph(nodes), id);
}

/** The outermost instance containing `id`. */
export function getRootInstance(nodes: readonly CanvasNode[], id: string): string | undefined {
	return rootInstanceIn(new Graph(nodes), id);
}

/** Whether `id` is a layer inside an instance (not a top-level instance itself). */
export function isInsideInstance(nodes: readonly CanvasNode[], id: string): boolean {
	return enclosingInstanceIn(new Graph(nodes), id) !== undefined;
}

/** Top-level and nested instances of `componentId`. */
export function getComponentInstances(nodes: readonly CanvasNode[], componentId: string): string[] {
	return nodes.filter((n) => getInstanceData(n)?.componentId === componentId).map((n) => n.id);
}

/** `linked`, or `missing-main` when the instance's main component is gone. */
export function getInstanceStatus(nodes: readonly CanvasNode[], id: string): 'linked' | 'missing-main' | undefined {
	const g = new Graph(nodes);
	const inst = getInstanceData(g.get(id));
	if (!inst) return undefined;
	return isCanvasComponent(g.get(inst.componentId)) ? 'linked' : 'missing-main';
}

/** The variant set of a component (its parent set), if any. */
export function getVariantSet(nodes: readonly CanvasNode[], componentId: string): string | undefined {
	return variantSetIn(new Graph(nodes), componentId)?.id;
}

/** Variant properties of a set with their values, in first-seen order. */
export function getVariantOptions(nodes: readonly CanvasNode[], setId: string): { name: string; values: string[] }[] {
	return variantOptionsIn(new Graph(nodes), setId);
}

/** The variant of `setId` matching `wanted` (all values, or else the most). */
export function findVariant(nodes: readonly CanvasNode[], setId: string, wanted: Readonly<Record<string, string>>): string | undefined {
	return findVariantIn(new Graph(nodes), setId, wanted);
}

/** A set's default variant: the one in its top-left corner. */
export function getDefaultVariant(nodes: readonly CanvasNode[], setId: string): string | undefined {
	return defaultVariantIn(new Graph(nodes), setId);
}

/** Variant combinations shared by two or more variants of a set (conflicts to resolve). */
export function getVariantConflicts(nodes: readonly CanvasNode[], setId: string): string[][] {
	const by = new Map<string, string[]>();
	for (const v of variantsIn(new Graph(nodes), setId)) {
		const key = formatVariantName(getVariantValues(v));
		by.set(key, [...(by.get(key) ?? []), v.id]);
	}
	return [...by.values()].filter((ids) => ids.length > 1);
}

/** Component property definitions of a component (its set's for variants). */
export function getComponentPropertyDefs(nodes: readonly CanvasNode[], componentId: string): Record<string, CanvasComponentPropertyDef> {
	return { ...propertyDefsIn(new Graph(nodes), componentId) };
}

/** An instance's property values, with defaults for those it doesn't set. */
export function getInstanceProperties(nodes: readonly CanvasNode[], id: string): Record<string, Value> {
	const g = new Graph(nodes);
	const inst = getInstanceData(g.get(id));
	return inst ? effectivePropsIn(g, inst.componentId, inst.properties) : {};
}

export interface CanvasComponentInfo {
	id: string;
	name: string;
	setId?: string;
	variant?: Record<string, string>;
	/** Instances linked to it (top-level and nested). */
	instanceCount: number;
}

export interface CanvasComponentSetInfo {
	id: string;
	name: string;
	variants: CanvasComponentInfo[];
	options: { name: string; values: string[] }[];
	defaultVariantId?: string;
}

/** Components (lone ones and variants) and component sets, in document order. */
export function listCanvasComponents(nodes: readonly CanvasNode[]): { components: CanvasComponentInfo[]; sets: CanvasComponentSetInfo[] } {
	const g = new Graph(nodes);
	const counts = new Map<string, number>();
	for (const n of nodes) {
		const c = getInstanceData(n)?.componentId;
		if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
	}
	const components: CanvasComponentInfo[] = [];
	for (const n of nodes) {
		if (!isCanvasComponent(n)) continue;
		const set = variantSetIn(g, n.id);
		components.push({
			id: n.id,
			name: getLayerName(n) || n.id,
			...(set ? { setId: set.id, variant: getVariantValues(n) } : {}),
			instanceCount: counts.get(n.id) ?? 0
		});
	}
	const sets = nodes.filter(isCanvasComponentSet).map((s) => ({
		id: s.id,
		name: getLayerName(s) || s.id,
		variants: components.filter((c) => c.setId === s.id),
		options: variantOptionsIn(g, s.id),
		defaultVariantId: defaultVariantIn(g, s.id)
	}));
	return { components, sets };
}

export interface CanvasInstancePropertyInfo {
	name: string;
	type: CanvasComponentPropertyType;
	value: Value;
	default: Value;
	/** Instance swap: preferred components (all components when empty). */
	preferred?: string[];
}

export interface CanvasInstanceInfo {
	/** The instance (the node itself, or the instance owning the inspected layer). */
	id: string;
	/** The outermost instance (where reset / push / detach act). */
	rootId: string;
	nested: boolean;
	componentId: string;
	componentName?: string;
	status: 'linked' | 'missing-main';
	setId?: string;
	variant: Record<string, string>;
	variantOptions: { name: string; values: string[] }[];
	properties: CanvasInstancePropertyInfo[];
	/** Layers of the instance with overrides (the instance itself included). */
	overrides: { id: string; name: string; groups: string[] }[];
}

/** Everything an instance inspector shows, for an instance or a layer inside one. */
export function inspectCanvasInstance(nodes: readonly CanvasNode[], id: string): CanvasInstanceInfo | undefined {
	const g = new Graph(nodes);
	const instId = owningInstanceIn(g, id);
	if (!instId) return undefined;
	const inst = g.get(instId)!;
	const data = getInstanceData(inst)!;
	const comp = g.get(data.componentId);
	const linked = isCanvasComponent(comp);
	const set = linked ? variantSetIn(g, data.componentId) : undefined;
	const defs = propertyDefsIn(g, data.componentId);
	const values = effectivePropsIn(g, data.componentId, data.properties);
	const overrides: CanvasInstanceInfo['overrides'] = [];
	for (const d of g.subtree(instId)) {
		const groups = getNodeOverrides(g.get(d));
		if (groups.length) overrides.push({ id: d, name: getLayerName(g.get(d)) || d, groups: [...groups] });
	}
	return {
		id: instId,
		rootId: rootInstanceIn(g, instId) ?? instId,
		nested: enclosingInstanceIn(g, instId) !== undefined,
		componentId: data.componentId,
		...(linked ? { componentName: getLayerName(comp) || comp!.id } : {}),
		status: linked ? 'linked' : 'missing-main',
		...(set ? { setId: set.id } : {}),
		variant: linked && set ? getVariantValues(comp) : {},
		variantOptions: set ? variantOptionsIn(g, set.id) : [],
		properties: Object.entries(defs).map(([name, def]) => ({
			name,
			type: def.type,
			value: values[name],
			default: def.default,
			...(def.type === 'instanceSwap' ? { preferred: [...(def.preferred ?? [])] } : {})
		})),
		overrides
	};
}

// ---------------------------------------------------------------------------------------------
// Instance rebuild

interface ResolvedSync {
	idGenerator: (instanceId: string, sourceId: string) => string;
	textTypes: readonly string[];
	layout: false | AutoLayoutOptions;
	tokens?: CanvasTokenOptions & { state?: TokenState };
}

function resolveSync(options: CanvasComponentSyncOptions = {}): ResolvedSync {
	return {
		idGenerator: options.idGenerator ?? ((inst, src) => `${inst}:${src}`),
		textTypes: options.textTypes ?? ['text'],
		layout: options.layout === false ? false : options.layout === true || options.layout === undefined ? {} : options.layout,
		tokens: options.tokens
	};
}

const stripLook = (data: Data): Data => {
	const out = { ...data };
	for (const k of LINK_KEYS) delete out[k];
	return out;
};

function clearRuntime(node: Data, old: CanvasNode | undefined) {
	for (const k of RUNTIME_KEYS) {
		if (old && (old as Data)[k] !== undefined) node[k] = (old as Data)[k];
		else delete node[k];
	}
}

/**
 * The value groups a node's token bindings write: values from variables are never overrides
 * (a different binding is, as `token.<key>`).
 */
function tokenDrivenGroups(n: CanvasNode, options: CanvasTokenOptions | undefined): string[] {
	const mine = stringRecord(dataOf(n).tokenBindings);
	const out: string[] = [];
	for (const key of Object.keys(mine)) {
		const property = getCanvasTokenProperty(key, options);
		if (!property || !property.appliesTo(n)) continue;
		const current = property.read(n);
		const probe =
			typeof current === 'number' ? current + 1 : typeof current === 'boolean' ? !current : `${current ?? ''}\u0001`;
		for (const g of diffOverrideGroups(n, property.write(n, probe as never))) if (!out.includes(g)) out.push(g);
	}
	return out;
}

/** Groups a main layer's component property bindings set (values from instances, not overrides). */
function propertyDrivenGroups(g: Graph, src: CanvasNode): string[] {
	const out: string[] = [];
	let at: CanvasNode | undefined = src;
	for (let i = 0; at && i <= MAX_DEPTH; i++) {
		for (const field of Object.keys(getComponentPropertyRefs(at))) out.push(fieldGroup(field));
		at = g.get(getComponentSourceId(at));
	}
	return out;
}

/** What an instance root is compared with: its main, named after its set for variants. */
function rootReference(g: Graph, comp: CanvasNode): CanvasNode {
	const set = variantSetIn(g, comp.id);
	if (!set) return comp;
	const label = dataOf(set).label;
	return 'label' in dataOf(comp) && typeof label === 'string' ? withData(comp, { ...dataOf(comp), label }) : comp;
}

/** `measured` follows an explicit size (xyflow re-measures; geometry helpers read it first). */
function fixMeasured(node: CanvasNode, old: CanvasNode | undefined): CanvasNode {
	const measured = old?.measured ?? node.measured;
	const size = sizeOf(node);
	const w = size.width ?? size.styleWidth;
	const h = size.height ?? size.styleHeight;
	if (!measured) {
		if (node.measured === undefined) return node;
		const next = { ...node };
		delete next.measured;
		return next;
	}
	const fixed = { ...measured, ...(w !== undefined ? { width: w } : {}), ...(h !== undefined ? { height: h } : {}) };
	return same(fixed, node.measured) ? node : { ...node, measured: fixed };
}

function applyProp(g: Graph, node: CanvasNode, field: string, value: Value): CanvasNode {
	if (field === 'visible') return typeof value === 'boolean' ? writeOverrideGroup(node, 'hidden', !value) : node;
	if (field === 'component') {
		if (typeof value !== 'string' || !isCanvasInstance(node)) return node;
		const main = mainOfIn(g, value);
		return main ? writeOverrideGroup(node, 'component', main) : node;
	}
	if (field.startsWith('data.')) return writeOverrideGroup(node, field, typeof value === 'string' ? value : String(value));
	return node;
}

interface BuiltInstance {
	/** The rebuilt instance: its root, its layers (pre-order) and kept foreign content. */
	block: CanvasNode[];
	/** Ids the block replaces. */
	removed: Set<string>;
}

/**
 * Rebuilds the outermost instance `instId` from its main component (read from `g`), keeping
 * layer ids, overrides, property values and its own placement. `taken` holds every id in use
 * (new ids are added). Returns `undefined` when the main is missing (the instance stays as it is).
 */
function buildInstance(g: Graph, instId: string, opts: ResolvedSync, taken: Set<string>): BuiltInstance | undefined {
	const inst = g.get(instId);
	const instData = getInstanceData(inst);
	if (!inst || !instData) return undefined;
	const compId = instData.componentId;
	const comp = g.get(compId);
	if (!comp || !isCanvasComponent(comp) || compId === instId || g.isAncestor(instId, compId) || g.isAncestor(compId, instId)) return undefined;

	// Old layers (kept for their ids and overrides) and foreign content (kept where it was).
	const oldIds: string[] = [];
	const foreign: string[] = [];
	const stack = [...g.children(instId)];
	while (stack.length) {
		const id = stack.pop()!;
		if (getComponentSourceId(g.get(id)) !== undefined) {
			oldIds.push(id);
			stack.push(...g.children(id));
		} else foreign.push(...g.subtree(id));
	}
	const old = new Map(oldIds.map((id) => [id, g.get(id)!]));
	const byParentSource = new Map<string, string>();
	const bySource = new Map<string, string | null>();
	for (const id of oldIds) {
		const n = old.get(id)!;
		const s = getComponentSourceId(n)!;
		const key = `${n.parentId}\u0000${s}`;
		if (!byParentSource.has(key)) byParentSource.set(key, id);
		bySource.set(s, bySource.has(s) ? null : id);
	}
	let byPath: Map<string, string> | undefined;
	const oldPaths = () => {
		const out = new Map<string, string>();
		const walk = (parent: string, prefix: string) => {
			const counts = new Map<string, number>();
			for (const c of g.children(parent)) {
				const n = g.get(c)!;
				const src = getComponentSourceId(n);
				if (src === undefined) continue;
				const name = getLayerName(g.get(src) ?? n);
				const k = counts.get(name) ?? 0;
				counts.set(name, k + 1);
				const path = `${prefix}/${k === 0 ? name : `${name}#${k}`}`;
				if (!out.has(path)) out.set(path, c);
				walk(c, path);
			}
		};
		walk(instId, '');
		return out;
	};

	const used = new Set<string>();
	const fresh = (sourceId: string) => {
		const base = opts.idGenerator(instId, sourceId);
		let id = base;
		for (let k = 2; taken.has(id); k++) id = `${base}~${k}`;
		taken.add(id);
		return id;
	};
	const instProps = new Map<string, Record<string, Value>>();
	const out: CanvasNode[] = [];
	const isText = (n: CanvasNode) => typeof n.type === 'string' && opts.textTypes.includes(n.type);

	/** Copy of main layer `s` (with `o`'s overrides when matched). */
	const copyLayer = (s: CanvasNode, o: CanvasNode | undefined, id: string, parentId: string): CanvasNode => {
		const next = { ...s, id, parentId } as Data;
		const data = stripLook(dataOf(s));
		if (isCanvasInstance(s)) data[INSTANCE_DATA_KEY] = { ...dataOf(s)[INSTANCE_DATA_KEY] };
		data[COMPONENT_SOURCE_DATA_KEY] = s.id;
		next.data = data;
		clearRuntime(next, o);
		let n = next as CanvasNode;
		if (o) {
			let groups = [...getNodeOverrides(o)];
			const from = g.get(getComponentSourceId(o));
			if (from && from.id !== s.id && groups.length && !isText(o) && siblingVariants(g, owningComponentIn(g, from.id), owningComponentIn(g, s.id))) {
				// Switched variants: keep overrides of properties both variants' layers agreed on.
				const differs = new Set(diffOverrideGroups(from, s));
				groups = groups.filter((gr) => !differs.has(gr));
			}
			n = copyGroups(o, n, groups);
			n = keepLaidOut(s, o, n, groups);
			n = setOverrides(n, groups);
		}
		return fixMeasured(n, o);
	};

	/** Where auto layout places / sizes a copy, keep the old copy's values (layout re-flows). */
	const keepLaidOut = (s: CanvasNode, o: CanvasNode, n: CanvasNode, groups: readonly string[]): CanvasNode => {
		if (o.parentId !== n.parentId || groups.includes('size') || groups.includes('position')) return n;
		const flows = !getChildLayout(n).absolute && !!getAutoLayout(g.get(s.parentId));
		let next = n;
		if (flows) next = writeOverrideGroup(next, 'position', o.position);
		const derived = (axis: 'width' | 'height') => {
			const sizing = getLayoutSizing(next, axis);
			return (sizing === 'hug' && !!getAutoLayout(next)) || (sizing === 'fill' && flows);
		};
		const size = { ...sizeOf(next) };
		const oldSize = sizeOf(o);
		if (derived('width')) {
			size.width = oldSize.width;
			size.styleWidth = oldSize.styleWidth;
		}
		if (derived('height')) {
			size.height = oldSize.height;
			size.styleHeight = oldSize.styleHeight;
		}
		return writeOverrideGroup(next, 'size', size);
	};

	/**
	 * An instance root looking like `look`, placed like `place`, with `old`'s overrides. A
	 * top-level instance keeps its own placement, visibility, lock and modes; a swapped nested
	 * instance is placed like the main layer it stands in for.
	 */
	const instanceRoot = (
		look: CanvasNode,
		place: CanvasNode,
		old: CanvasNode | undefined,
		id: string,
		parentId: string | undefined,
		sourceId: string,
		instance: CanvasInstanceData,
		previousComponent: string | undefined,
		topLevel: boolean
	): CanvasNode => {
		const reference = rootReference(g, look);
		const next = { ...reference, id, position: { ...place.position } } as Data;
		if (parentId === undefined) delete next.parentId;
		else next.parentId = parentId;
		const data = stripLook(dataOf(reference));
		delete data.tokenModes;
		data[INSTANCE_DATA_KEY] = { ...instance };
		data[COMPONENT_SOURCE_DATA_KEY] = sourceId;
		next.data = data;
		clearRuntime(next, old);
		let n = next as CanvasNode;
		const own = new Set<string>();
		listGroups(place, own);
		listGroups(n, own);
		n = copyGroups(place, n, [...own].filter((gr) => isOwnRootGroup(gr) && gr !== 'component' && gr !== 'props'));
		let groups = old ? getNodeOverrides(old).filter((gr) => !topLevel || !isOwnRootGroup(gr)) : [];
		if (old && previousComponent && siblingVariants(g, previousComponent, look.id)) {
			// Switched variants: keep overrides where both variants agreed.
			const differs = new Set(diffOverrideGroups(g.get(previousComponent)!, look));
			groups = groups.filter((gr) => gr === 'data.label' || gr === 'data.name' || !differs.has(gr));
		}
		// The instance data (main and property values) was resolved by the caller.
		if (old) n = copyGroups(old, n, groups.filter((gr) => gr !== 'component' && gr !== 'props'));
		return fixMeasured(setOverrides(n, groups), old);
	};

	const applyChainProps = (n: CanvasNode, s: CanvasNode, enc: readonly string[]): CanvasNode => {
		const chain: CanvasNode[] = [s];
		while (chain.length < enc.length) {
			const next = g.get(getComponentSourceId(chain[chain.length - 1]));
			if (!next) break;
			chain.push(next);
		}
		let next = n;
		for (let j = chain.length - 1; j >= 0; j--) {
			const props = instProps.get(enc[j]);
			if (!props) continue;
			for (const [field, prop] of Object.entries(getComponentPropertyRefs(chain[j]))) {
				const group = fieldGroup(field);
				if (getNodeOverrides(next).includes(group) || (j > 0 && getNodeOverrides(s).includes(group))) continue;
				if (prop in props) next = applyProp(g, next, field, props[prop]);
			}
		}
		return next;
	};

	const copyChildren = (srcParent: string, newParent: string, prefix: string, enc: string[], expanding: string[], depth: number) => {
		const counts = new Map<string, number>();
		for (const sid of g.children(srcParent)) {
			const s = g.get(sid)!;
			const name = getLayerName(s);
			const k = counts.get(name) ?? 0;
			counts.set(name, k + 1);
			const path = `${prefix}/${k === 0 ? name : `${name}#${k}`}`;
			let oid = byParentSource.get(`${newParent}\u0000${sid}`);
			if (oid !== undefined && used.has(oid)) oid = undefined;
			if (oid === undefined) {
				const u = bySource.get(sid);
				if (u && !used.has(u)) oid = u;
			}
			if (oid === undefined) {
				byPath ??= oldPaths();
				const p = byPath.get(path);
				if (p && !used.has(p)) oid = p;
			}
			if (oid !== undefined) used.add(oid);
			const o = oid !== undefined ? old.get(oid) : undefined;
			const id = oid ?? fresh(sid);
			let n = applyChainProps(copyLayer(s, o, id, newParent), s, enc);
			const nested = getInstanceData(n);
			if (nested && depth < MAX_DEPTH) {
				const target = nested.componentId;
				instProps.set(id, effectivePropsIn(g, target, nested.properties));
				if (getInstanceData(s)?.componentId !== target) {
					const main = g.get(target);
					if (isCanvasComponent(main) && !expanding.includes(target) && !g.isAncestor(target, instId)) {
						// A swapped nested instance shows its own main.
						const previousComponent = o ? getInstanceData(o)?.componentId : undefined;
						n = applyChainProps(instanceRoot(main!, s, o, id, newParent, sid, nested, previousComponent, false), s, enc);
						out.push(n);
						copyChildren(target, id, path, [id], [...expanding, target], depth + 1);
						continue;
					}
				}
				out.push(n);
				copyChildren(sid, id, path, [...enc, id], expanding, depth);
				continue;
			}
			out.push(n);
			copyChildren(sid, id, path, enc, expanding, depth);
		}
	};

	const root = instanceRoot(comp, inst, inst, instId, inst.parentId, compId, instData, getComponentSourceId(inst), true);
	instProps.set(instId, effectivePropsIn(g, compId, instData.properties));
	copyChildren(compId, instId, '', [instId], [compId], 0);

	// Foreign content stays where its parent still is.
	const placed = new Set<string>([instId, ...out.map((n) => n.id)]);
	const keptForeign: CanvasNode[] = [];
	for (const id of foreign) {
		const n = g.get(id)!;
		if (n.parentId && placed.has(n.parentId)) {
			placed.add(id);
			keptForeign.push(n);
		}
	}
	const removed = new Set<string>([instId, ...oldIds, ...foreign]);
	let block: CanvasNode[] = [root, ...out, ...keptForeign];

	// A resized instance: its layers follow their constraints (geometry overrides win).
	const compSize = getNodeSize(comp);
	const rootSize = getNodeSize(root);
	if (!getAutoLayout(root) && (Math.abs(compSize.width - rootSize.width) > 1e-9 || Math.abs(compSize.height - rootSize.height) > 1e-9)) {
		const fixed = new Set(out.filter((n) => getNodeOverrides(n).some((gr) => gr === 'size' || gr === 'position')).map((n) => n.id));
		const updates = applyConstraints(block, instId, compSize, opts.layout || {}).filter((u: CanvasNodeUpdate) => !fixed.has(u.id));
		block = applyNodeUpdates(block, updates);
	}
	// Auto layout inside the instance (its ancestors are laid out once per batch).
	if (opts.layout) {
		const frames = block.filter((n) => getAutoLayout(n)).map((n) => n.id);
		if (frames.length) block = applyNodeUpdates(block, layoutUpMany(block, frames, opts.layout));
	}
	// Unchanged layers keep their identity (so a no-op rebuild returns the same array).
	block = block.map((n) => {
		const prev = g.get(n.id);
		return prev && prev !== n && same(prev, n) ? prev : n;
	});
	return { block, removed };
}

/**
 * Rebuilds the outermost instances containing `ids` against one snapshot of `nodes` (they must
 * not depend on each other), then lays out the auto layout frames around them.
 */
function rebuildBatch(nodes: CanvasNode[], ids: Iterable<string>, opts: ResolvedSync): CanvasNode[] {
	const g = new Graph(nodes);
	const taken = new Set(g.byId.keys());
	const built = new Map<string, BuiltInstance>();
	for (const id of ids) {
		const root = g.get(id) ? rootInstanceIn(g, id) ?? id : undefined;
		if (!root || built.has(root)) continue;
		const b = buildInstance(g, root, opts, taken);
		if (b) built.set(root, b);
	}
	if (built.size === 0) return nodes;
	const removed = new Set<string>();
	for (const b of built.values()) for (const id of b.removed) removed.add(id);
	let result: CanvasNode[] = [];
	for (const n of nodes) {
		const b = built.get(n.id);
		if (b) result.push(...b.block);
		else if (!removed.has(n.id)) result.push(n);
	}
	if (opts.layout) {
		const lookup = new Map(result.map((n) => [n.id, n]));
		const inFrames = [...built.keys()].filter((r) => {
			const parent = lookup.get(lookup.get(r)?.parentId ?? '');
			return !!getAutoLayout(parent);
		});
		if (inFrames.length) result = applyNodeUpdates(result, layoutUpMany(result, inFrames, opts.layout));
	}
	return result.length === nodes.length && result.every((n, i) => n === nodes[i]) ? nodes : result;
}

/**
 * Rebuilds every outermost instance of `comps` (and of the components holding them, outwards),
 * inner components first, plus `resync` roots.
 */
function rebuildInstances(nodes: CanvasNode[], comps: Set<string>, resync: Set<string>, opts: ResolvedSync): CanvasNode[] {
	let current = nodes;
	if (resync.size) {
		current = rebuildBatch(current, resync, opts);
		const after = new Graph(current);
		for (const r of resync) {
			const c = after.get(r) ? owningComponentIn(after, r) : undefined;
			if (c) comps.add(c);
		}
	}
	if (comps.size === 0) return current;
	const g = new Graph(current);
	const rootsOf = new Map<string, Set<string>>();
	for (const n of current) {
		const inst = getInstanceData(n);
		if (!inst) continue;
		const root = rootInstanceIn(g, n.id) ?? n.id;
		let set = rootsOf.get(inst.componentId);
		if (!set) rootsOf.set(inst.componentId, (set = new Set()));
		set.add(root);
	}
	const level = new Map<string, number>([...comps].map((c) => [c, 0]));
	const outer = new Map<string, string | undefined>();
	let frontier = [...comps];
	for (let rounds = 0; frontier.length && rounds < 64; rounds++) {
		const next: string[] = [];
		for (const c of frontier) {
			const lc = level.get(c) ?? 0;
			for (const r of rootsOf.get(c) ?? []) {
				if (!outer.has(r)) outer.set(r, owningComponentIn(g, r));
				const x = outer.get(r);
				if (x && x !== c && (level.get(x) ?? -1) < lc + 1) {
					level.set(x, lc + 1);
					next.push(x);
				}
			}
		}
		frontier = next;
	}
	// Instances inside components by level (each level reads only lower ones), then the rest.
	const batches = new Map<number, string[]>();
	for (const [r, o] of outer) {
		const l = o !== undefined ? level.get(o) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
		batches.set(l, [...(batches.get(l) ?? []), r]);
	}
	for (const l of [...batches.keys()].sort((a, b) => a - b)) current = rebuildBatch(current, batches.get(l)!, opts);
	return current;
}

function finish<TNode extends CanvasNode>(original: readonly TNode[], result: CanvasNode[], opts: ResolvedSync): TNode[] {
	let out = result;
	if (opts.tokens?.state) out = resolveCanvasTokens(out, opts.tokens.state, opts.tokens);
	if (out.length === original.length && out.every((n, i) => n === original[i])) return original as TNode[];
	return out as TNode[];
}

/**
 * Rebuilds one instance from its main (keeping ids, overrides and property values).
 */
export function syncCanvasInstance<TNode extends CanvasNode>(nodes: readonly TNode[], instanceId: string, options: CanvasComponentSyncOptions = {}): TNode[] {
	const opts = resolveSync(options);
	return finish(nodes, rebuildInstances([...nodes], new Set(), new Set([instanceId]), opts), opts);
}

/**
 * Rebuilds every instance from its main, inner components first (e.g. after loading a
 * document whose instances were saved without their layers).
 */
export function syncAllCanvasInstances<TNode extends CanvasNode>(nodes: readonly TNode[], options: CanvasComponentSyncOptions = {}): TNode[] {
	const opts = resolveSync(options);
	const comps = new Set(nodes.filter(isCanvasComponent).map((n) => n.id));
	return finish(nodes, rebuildInstances([...nodes], comps, new Set(), opts), opts);
}

/** Re-derives the sources and overrides of instance `instId` against its own main by comparing values. */
function rebaseInstance(nodes: CanvasNode[], instId: string, tokens: CanvasTokenOptions | undefined): CanvasNode[] {
	const g = new Graph(nodes);
	const inst = getInstanceData(g.get(instId));
	if (!inst) return nodes;
	const compId = inst.componentId;
	const comp = g.get(compId);
	const theirs = new Map<string, string>();
	const mine = new Map<string, string>();
	const paths = (root: string, viaSource: boolean, into: Map<string, string>, flip: boolean) => {
		const walk = (parent: string, prefix: string) => {
			const counts = new Map<string, number>();
			for (const c of g.children(parent)) {
				const n = g.get(c)!;
				const name = getLayerName((viaSource && g.get(getComponentSourceId(n))) || n);
				const k = counts.get(name) ?? 0;
				counts.set(name, k + 1);
				const path = `${prefix}/${k === 0 ? name : `${name}#${k}`}`;
				if (flip) {
					if (!into.has(path)) into.set(path, c);
				} else into.set(c, path);
				walk(c, path);
			}
		};
		walk(root, '');
	};
	if (comp) paths(compId, false, theirs, true);
	paths(instId, true, mine, false);
	const updates = new Map<string, CanvasNode>();
	for (const [id, path] of mine) {
		const n = g.get(id)!;
		let main: string | undefined;
		let cur = getComponentSourceId(n);
		for (let i = 0; cur && i < MAX_DEPTH; i++) {
			if (cur !== compId && g.get(cur) && g.isAncestor(compId, cur)) {
				main = cur;
				break;
			}
			cur = getComponentSourceId(g.get(cur));
		}
		main ??= comp ? theirs.get(path) : undefined;
		const m = g.get(main);
		let next = n;
		if (m) {
			const bound = new Set([...propertyDrivenGroups(g, m), ...tokenDrivenGroups(n, tokens)]);
			const groups = new Set(getNodeOverrides(n).filter((gr) => gr !== 'component' && gr !== 'props'));
			for (const gr of diffOverrideGroups(m, n)) if (gr !== 'size' && gr !== 'position' && !bound.has(gr)) groups.add(gr);
			if (isCanvasInstance(m) && isCanvasInstance(n) && getInstanceData(m)!.componentId !== getInstanceData(n)!.componentId) groups.add('component');
			next = setOverrides(withData(n, { ...dataOf(n), [COMPONENT_SOURCE_DATA_KEY]: m.id }), groups);
		} else next = unlinked(n);
		if (next !== n) updates.set(id, next);
	}
	const root = g.get(instId)!;
	let nextRoot = withData(root, { ...dataOf(root), [COMPONENT_SOURCE_DATA_KEY]: compId });
	if (comp) {
		const ref = rootReference(g, comp);
		const driven = new Set(tokenDrivenGroups(root, tokens));
		const groups = new Set(getNodeOverrides(root).filter((gr) => !isOwnRootGroup(gr)));
		for (const gr of diffOverrideGroups(ref, root)) if (!isOwnRootGroup(gr) && !driven.has(gr)) groups.add(gr);
		nextRoot = setOverrides(nextRoot, groups);
	}
	updates.set(instId, nextRoot);
	return nodes.map((n) => updates.get(n.id) ?? n);
}

/** Whether auto layout decides a node's size (it hugs its content, or fills its auto layout parent). */
function sizeFromLayout(g: Graph, node: CanvasNode): boolean {
	const parentFlows = !!getAutoLayout(g.get(node.parentId)) && !getChildLayout(node).absolute;
	return (['width', 'height'] as const).some((axis) => {
		const sizing = getLayoutSizing(node, axis);
		return (sizing === 'hug' && !!getAutoLayout(node)) || (sizing === 'fill' && parentFlows);
	});
}

/**
 * Keeps components and instances consistent after an edit from `before` to `after`:
 *
 * 1. Layers deleted from inside an instance come back hidden; nodes added inside an instance
 *    move out next to it; pasted / duplicated copies of instance layers stop mirroring the main,
 *    and a copied nested instance becomes an instance of its own main.
 * 2. Edits to instance layers are recorded as overrides (a value equal to the main's clears
 *    the override; values from the same variable or from a component property are not
 *    overrides; layer geometry inside an instance is not overridable, the instance's size is).
 * 3. Instances of components whose layers changed are rebuilt (nested components first),
 *    as are instances whose main, properties or overrides were switched or reset.
 *
 * Returns `after` unchanged when there is nothing to do, so it can run on every change.
 */
export function syncCanvasComponents<TNode extends CanvasNode>(
	before: readonly TNode[],
	after: readonly TNode[],
	options: CanvasComponentSyncOptions = {}
): TNode[] {
	if (before === after) return after as TNode[];
	const opts = resolveSync(options);
	const prev = new Graph(before);
	let nodes: CanvasNode[] = [...after];
	const resync = new Set<string>();

	// 1a. Layers deleted inside a surviving instance come back, hidden.
	const afterIds = new Set(after.map((n) => n.id));
	const restore: CanvasNode[] = [];
	for (const b of before) {
		if (afterIds.has(b.id) || getComponentSourceId(b) === undefined || isCanvasInstance(b) && !enclosingInstanceIn(prev, b.id)) continue;
		const root = rootInstanceIn(prev, b.id);
		if (!root || root === b.id || !afterIds.has(root)) continue;
		restore.push(b);
	}
	if (restore.length) {
		const restoring = new Set(restore.map((n) => n.id));
		for (const b of restore) nodes.push(b.parentId && restoring.has(b.parentId) ? b : writeOverrideGroup(b, 'hidden', true));
		for (const b of restore) {
			const r = rootInstanceIn(prev, b.id);
			if (r) resync.add(r);
		}
	}

	// 1b. Nodes added inside an existing instance move out; copies brought in elsewhere relink.
	let g = new Graph(nodes);
	const added = nodes.filter((n) => !prev.byId.has(n.id));
	if (added.length) {
		const addedIds = new Set(added.map((n) => n.id));
		const moves = new Map<string, CanvasNode>();
		for (const n of added) {
			if (!n.parentId || addedIds.has(n.parentId)) continue;
			const r = rootInstanceIn(g, n.parentId);
			if (!r || addedIds.has(r)) continue;
			const rootNode = g.get(r)!;
			const abs = getAbsolutePosition(n, g.byId);
			const parent = g.get(rootNode.parentId);
			const base = parent ? getAbsolutePosition(parent, g.byId) : { x: 0, y: 0 };
			const moved = { ...n, position: { x: abs.x - base.x, y: abs.y - base.y } } as Data;
			if (rootNode.parentId) moved.parentId = rootNode.parentId;
			else delete moved.parentId;
			moves.set(n.id, moved as CanvasNode);
		}
		if (moves.size) {
			nodes = nodes.map((n) => moves.get(n.id) ?? n);
			g = new Graph(nodes);
		}
		const rebase: string[] = [];
		const strips = new Map<string, CanvasNode>();
		for (const n of added) {
			const cur = g.get(n.id)!;
			if (isCanvasInstance(cur)) {
				if (enclosingInstanceIn(g, n.id) === undefined && getComponentSourceId(cur) !== getInstanceData(cur)!.componentId) rebase.push(n.id);
				continue;
			}
			if (getComponentSourceId(cur) === undefined && getNodeOverrides(cur).length === 0) continue;
			const r = rootInstanceIn(g, n.id);
			if (!r || !addedIds.has(r) || moves.has(n.id)) strips.set(n.id, unlinked(cur, true));
		}
		if (strips.size) nodes = nodes.map((n) => strips.get(n.id) ?? n);
		for (const id of rebase) nodes = rebaseInstance(nodes, id, opts.tokens);
		g = new Graph(nodes);
	}

	// 2. Overrides of edited instance layers.
	const overrideUpdates = new Map<string, CanvasNode>();
	for (const n of nodes) {
		const b = prev.get(n.id);
		if (!b || b === n) continue;
		const inst = owningInstanceIn(g, n.id);
		if (!inst || (getComponentSourceId(n) === undefined && inst !== n.id)) continue;
		const topRoot = inst === n.id && enclosingInstanceIn(g, n.id) === undefined;
		const bi = getInstanceData(b);
		const ni = getInstanceData(n);
		const raw = diffOverrideGroups(b, n);
		if (topRoot) {
			if (bi && ni && (bi.componentId !== ni.componentId || !same(bi.properties ?? {}, ni.properties ?? {}))) resync.add(n.id);
			if (raw.includes('size')) resync.add(n.id);
		}
		let groups = raw.filter((gr) => gr !== 'position' && (gr !== 'size' || (topRoot && !sizeFromLayout(g, n))));
		if (topRoot) groups = groups.filter((gr) => !isOwnRootGroup(gr));
		let cleared: string[] = [];
		const srcId = topRoot ? ni?.componentId : getComponentSourceId(n);
		const src = g.get(srcId);
		if (src) {
			const reference = topRoot ? rootReference(g, src) : src;
			const differs = new Set(diffOverrideGroups(reference, n));
			const driven = new Set(tokenDrivenGroups(n, opts.tokens));
			groups = groups.filter((gr) => differs.has(gr) && !driven.has(gr));
			cleared = raw.filter((gr) => gr !== 'size' && gr !== 'position' && !differs.has(gr) && getNodeOverrides(n).includes(gr));
			if (topRoot) cleared = cleared.filter((gr) => !isOwnRootGroup(gr));
		}
		const lost = getNodeOverrides(b).some((gr) => !getNodeOverrides(n).includes(gr));
		const nestedSwitch = !topRoot && raw.some((gr) => gr === 'component' || gr === 'props');
		if (groups.length || cleared.length) {
			const set = new Set(getNodeOverrides(n));
			for (const gr of groups) set.add(gr);
			for (const gr of cleared) set.delete(gr);
			const updated = setOverrides(n, set);
			if (updated !== n) overrideUpdates.set(n.id, updated);
		}
		if (lost || nestedSwitch) {
			const r = rootInstanceIn(g, n.id);
			if (r) resync.add(r);
		}
	}
	if (overrideUpdates.size) {
		nodes = nodes.map((n) => overrideUpdates.get(n.id) ?? n);
		g = new Graph(nodes);
	}

	// 3. Components whose layers changed.
	const comps = new Set<string>();
	for (const n of nodes) {
		const b = prev.get(n.id);
		if (b === n) continue;
		const c = owningComponentIn(g, n.id);
		if (isCanvasComponentSet(n) && (!b || !same(dataOf(b)[COMPONENT_SET_DATA_KEY], dataOf(n)[COMPONENT_SET_DATA_KEY]))) {
			for (const v of variantsIn(g, n.id)) comps.add(v.id);
		}
		if (!c) continue;
		if (!b) {
			comps.add(c);
			continue;
		}
		const structural =
			b.parentId !== n.parentId ||
			!same(dataOf(b)[COMPONENT_DATA_KEY], dataOf(n)[COMPONENT_DATA_KEY]) ||
			!same(getComponentPropertyRefs(b), getComponentPropertyRefs(n)) ||
			getComponentSourceId(b) !== getComponentSourceId(n) ||
			!same(getNodeOverrides(b), getNodeOverrides(n));
		const diff = diffOverrideGroups(b, n);
		if (!structural && (diff.length === 0 || (n.id === c && diff.every(isOwnRootGroup)))) continue;
		comps.add(c);
	}
	for (const b of before) {
		if (afterIds.has(b.id)) continue;
		const c = owningComponentIn(prev, b.id);
		if (c && c !== b.id && g.get(c)) comps.add(c);
	}
	// Order changes among a component's layers (array order is layer order).
	{
		const order = (list: readonly CanvasNode[]) => {
			const m = new Map<string, string[]>();
			for (const n of list) if (n.parentId) m.set(n.parentId, [...(m.get(n.parentId) ?? []), n.id]);
			return m;
		};
		const ob = order(before);
		const oa = order(nodes);
		for (const [parent, kids] of oa) {
			if (same(ob.get(parent), kids)) continue;
			const c = owningComponentIn(g, parent);
			if (c && !owningInstanceIn(g, parent)) comps.add(c);
		}
	}

	nodes = rebuildInstances(nodes, comps, resync, opts);
	return finish(after, nodes, opts);
}

// ---------------------------------------------------------------------------------------------
// Operations

function fail<TNode extends CanvasNode>(nodes: readonly TNode[], code: CanvasComponentErrorCode, reason: string): CanvasComponentResult<TNode> {
	return { ok: false, nodes: nodes as TNode[], code, reason };
}

function done<TNode extends CanvasNode>(
	before: readonly TNode[],
	after: CanvasNode[],
	ids: string[],
	options: CanvasComponentSyncOptions
): CanvasComponentResult<TNode> {
	return { ok: true, nodes: syncCanvasComponents(before, after as TNode[], options), ids };
}

function uniqueId(base: string, taken: ReadonlySet<string> | Map<string, unknown>): string {
	let id = base;
	for (let k = 2; taken.has(id); k++) id = `${base}-${k}`;
	return id;
}

function sizedStyle(like: CanvasNode['style'], width: number, height: number): CanvasNode['style'] {
	return typeof like === 'string' ? `width: ${width}px; height: ${height}px` : { width, height };
}

/** Wraps `ids` (siblings) in a new frame node at their bounds (+ `padding`), returning the new nodes. */
function wrapInFrame(nodes: CanvasNode[], ids: string[], frame: { id: string; type: string; data: Data; padding: number }): CanvasNode[] {
	const g = new Graph(nodes);
	const roots = ids.map((id) => g.get(id)!);
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const n of roots) {
		const { width, height } = getNodeSize(n);
		minX = Math.min(minX, n.position.x);
		minY = Math.min(minY, n.position.y);
		maxX = Math.max(maxX, n.position.x + width);
		maxY = Math.max(maxY, n.position.y + height);
	}
	minX -= frame.padding;
	minY -= frame.padding;
	maxX += frame.padding;
	maxY += frame.padding;
	const width = maxX - minX;
	const height = maxY - minY;
	const parentId = roots[0].parentId;
	const wrapper: CanvasNode = {
		id: frame.id,
		type: frame.type,
		position: { x: minX, y: minY },
		width,
		height,
		style: sizedStyle(roots[0].style, width, height),
		data: frame.data,
		...(parentId ? { parentId } : {})
	};
	const selected = new Set(ids);
	const firstIndex = nodes.findIndex((n) => selected.has(n.id));
	const out: CanvasNode[] = [];
	nodes.forEach((n, i) => {
		if (i === firstIndex) out.push(wrapper);
		out.push(selected.has(n.id) ? { ...n, parentId: frame.id, position: { x: n.position.x - minX, y: n.position.y - minY } } : n);
	});
	return out;
}

/**
 * Create Component: a single frame-like node (one with children, a frame / group type or auto
 * layout) becomes a component; anything else is wrapped in a new component frame. Refuses
 * layers inside an instance and layers that don't share a parent.
 */
export function createCanvasComponent<TNode extends CanvasNode>(
	nodes: readonly TNode[],
	ids: Iterable<string>,
	options: CreateCanvasComponentOptions = {}
): CanvasComponentResult<TNode> {
	const g = new Graph(nodes);
	const picked = [...new Set(ids)].filter((id) => g.get(id));
	const roots = picked.filter((id) => !picked.some((o) => o !== id && g.isAncestor(o, id)));
	if (roots.length === 0) return fail(nodes, 'not-found', 'Select the layers to make a component.');
	if (roots.some((id) => enclosingInstanceIn(g, id) !== undefined)) {
		return fail(nodes, 'inside-instance', "Layers inside an instance can't become components: detach the instance first.");
	}
	if (roots.some((id) => isCanvasComponent(g.get(id)) || isCanvasComponentSet(g.get(id)))) {
		return fail(nodes, 'invalid', 'The selection is already a component.');
	}
	if (new Set(roots.map((id) => g.get(id)!.parentId ?? '')).size > 1) return fail(nodes, 'invalid', 'Select layers that share a parent.');
	const frameTypes = options.frameTypes ?? ['group', 'frame'];
	if (roots.length === 1) {
		const node = g.get(roots[0])!;
		const frameLike = !isCanvasInstance(node) && (g.children(node.id).length > 0 || (typeof node.type === 'string' && frameTypes.includes(node.type)) || !!getAutoLayout(node));
		if (frameLike) {
			const after = nodes.map((n) => (n.id === node.id ? withData(n, { ...dataOf(n), [COMPONENT_DATA_KEY]: {} }) : n));
			return done(nodes, after, [node.id], options);
		}
	}
	const id = options.id ?? uniqueId('component', g.byId);
	const name = options.name ?? (roots.length === 1 ? getLayerName(g.get(roots[0])) || 'Component' : 'Component');
	const after = wrapInFrame([...nodes], roots, { id, type: options.frameType ?? 'group', data: { label: name, [COMPONENT_DATA_KEY]: {} }, padding: 0 });
	return done(nodes, after, [id], options);
}

/**
 * Combine as Variants: wraps sibling components in a component set. Each variant takes its
 * `data.component.variant`, else the `Prop=Value` pairs of its name, else `Property 1=…`.
 */
export function combineCanvasComponentsAsVariants<TNode extends CanvasNode>(
	nodes: readonly TNode[],
	ids: Iterable<string>,
	options: CanvasComponentSyncOptions & { id?: string; name?: string; frameType?: string; padding?: number } = {}
): CanvasComponentResult<TNode> {
	const g = new Graph(nodes);
	const picked = [...new Set(ids)].filter((id) => g.get(id));
	if (picked.length === 0) return fail(nodes, 'not-found', 'Select components to combine.');
	if (!picked.every((id) => isCanvasComponent(g.get(id)))) return fail(nodes, 'invalid', 'Select components only.');
	if (picked.some((id) => variantSetIn(g, id))) return fail(nodes, 'invalid', 'A component is already a variant of a set.');
	if (picked.some((id) => owningInstanceIn(g, id))) return fail(nodes, 'inside-instance', "Components inside an instance can't be combined.");
	if (new Set(picked.map((id) => g.get(id)!.parentId ?? '')).size > 1) return fail(nodes, 'invalid', 'Select components that share a parent.');
	const ordered = nodes.filter((n) => picked.includes(n.id)).map((n) => n.id);
	const first = g.get(ordered[0])!;
	const firstName = getLayerName(first);
	const name = options.name ?? (firstName && !firstName.includes('=') ? firstName.split('/')[0].trim() : 'Component');
	const id = options.id ?? uniqueId('component-set', g.byId);
	let after = wrapInFrame([...nodes], ordered, {
		id,
		type: options.frameType ?? 'group',
		data: { label: name, [COMPONENT_SET_DATA_KEY]: {} },
		padding: options.padding ?? 20
	});
	// Property order: as first seen in the variants' names.
	const order: string[] = [];
	for (const vid of ordered) for (const k of Object.keys(getVariantValues(g.get(vid)))) if (!order.includes(k)) order.push(k);
	after = after.map((n) => {
		const k = ordered.indexOf(n.id);
		if (k < 0) return n;
		let variant = getVariantValues(n);
		if (Object.keys(variant).length === 0) variant = { 'Property 1': k === 0 ? 'Default' : `Variant${k + 1}` };
		const comp = { ...(getComponentData(n) ?? {}), variant };
		return withData(n, { ...dataOf(n), [COMPONENT_DATA_KEY]: comp, label: formatVariantName(variant, order) });
	});
	return done(nodes, after, [id], options);
}

/**
 * Create Instance of a component (or of a set's default variant). Refuses placing it inside
 * its own main (directly or through nested instances) or inside another instance.
 */
export function createCanvasInstance<TNode extends CanvasNode>(
	nodes: readonly TNode[],
	componentId: string,
	options: CreateCanvasInstanceOptions = {}
): CanvasComponentResult<TNode> {
	const g = new Graph(nodes);
	const main = mainOfIn(g, componentId);
	if (!main) return fail(nodes, 'not-found', 'Choose a component or component set.');
	const parentId = options.parentId;
	if (parentId !== undefined && !g.get(parentId)) return fail(nodes, 'not-found', `Unknown parent "${parentId}".`);
	if (createsCycleIn(g, main, parentId)) return fail(nodes, 'cycle', "An instance can't be placed inside its own main component.");
	if (parentId !== undefined && owningInstanceIn(g, parentId)) return fail(nodes, 'inside-instance', "Instances can't gain layers: place it outside the instance.");
	const comp = g.get(main)!;
	const id = options.id ?? uniqueId(`${main}-instance`, g.byId);
	if (g.get(id)) return fail(nodes, 'invalid', `Id "${id}" is taken.`);
	let position = options.position;
	if (!position) {
		if (parentId !== undefined) position = { x: 0, y: 0 };
		else {
			const top = g.chain(main).pop()!;
			position = { x: getAbsolutePosition(top, g.byId).x + getNodeSize(top).width + 40, y: getAbsolutePosition(comp, g.byId).y };
		}
	}
	const root: CanvasNode = {
		id,
		type: comp.type,
		position: { ...position },
		data: { [INSTANCE_DATA_KEY]: { componentId: main, properties: effectivePropsIn(g, main, undefined) }, [COMPONENT_SOURCE_DATA_KEY]: main },
		...(parentId !== undefined ? { parentId } : {})
	};
	const opts = resolveSync(options);
	let after = rebuildBatch([...nodes, root], [id], opts);
	if (options.properties && Object.keys(options.properties).length) {
		const set = setCanvasInstanceProperties(after, [id], options.properties, { ...options, tokens: undefined });
		if (!set.ok) return fail(nodes, set.code, set.reason);
		after = set.nodes;
	}
	return { ok: true, nodes: finish(nodes, after, opts), ids: [id] };
}

/**
 * Detach Instance: the instance becomes a plain frame with the same look; its layers stop
 * mirroring the main, and instances nested in it become instances of their own mains. Nested
 * instances can't be detached on their own.
 */
export function detachCanvasInstance<TNode extends CanvasNode>(
	nodes: readonly TNode[],
	ids: Iterable<string>,
	options: CanvasComponentSyncOptions = {}
): CanvasComponentResult<TNode> {
	let current: CanvasNode[] = [...nodes];
	const doneIds: string[] = [];
	for (const id of new Set(ids)) {
		const g = new Graph(current);
		if (!isCanvasInstance(g.get(id))) continue;
		if (enclosingInstanceIn(g, id) !== undefined) {
			return fail(nodes, 'nested-instance', "A nested instance can't be detached on its own: detach the outer instance first.");
		}
		const nested: string[] = [];
		const updates = new Map<string, CanvasNode>();
		for (const d of g.subtree(id)) {
			if (d === id || enclosingInstanceIn(g, d) !== id) continue;
			if (isCanvasInstance(g.get(d))) nested.push(d);
			else updates.set(d, unlinked(g.get(d)!));
		}
		const root = g.get(id)!;
		const data = { ...dataOf(root) };
		delete data[INSTANCE_DATA_KEY];
		delete data[COMPONENT_SOURCE_DATA_KEY];
		delete data[COMPONENT_OVERRIDES_DATA_KEY];
		updates.set(id, withData(root, data));
		current = current.map((n) => updates.get(n.id) ?? n);
		for (const nn of nested) current = rebaseInstance(current, nn, options.tokens);
		doneIds.push(id);
	}
	if (doneIds.length === 0) return fail(nodes, 'invalid', 'Select an instance.');
	return done(nodes, current, doneIds, options);
}

/**
 * Reset overrides: `group` resets one override group of layer `id`; without it, an instance
 * resets every override in it (its own size stays) and its property values, a layer resets all of
 * its own.
 */
export function resetCanvasInstanceOverrides<TNode extends CanvasNode>(
	nodes: readonly TNode[],
	id: string,
	group?: string,
	options: CanvasComponentSyncOptions = {}
): CanvasComponentResult<TNode> {
	const g = new Graph(nodes);
	const node = g.get(id);
	const inst = node ? owningInstanceIn(g, id) : undefined;
	if (!node || !inst) return fail(nodes, 'not-found', 'Select an instance or a layer inside one.');
	const top = inst === id && enclosingInstanceIn(g, id) === undefined;
	const updates = new Map<string, CanvasNode>();
	const resetProps = (n: CanvasNode): CanvasNode => {
		const data = getInstanceData(n)!;
		const defaults = effectivePropsIn(g, data.componentId, undefined);
		return same(data.properties ?? {}, defaults) ? n : withData(n, { ...dataOf(n), [INSTANCE_DATA_KEY]: { ...data, properties: defaults } });
	};
	if (group !== undefined) {
		let next = setOverrides(node, getNodeOverrides(node).filter((gr) => gr !== group));
		if (top && group === 'props') next = resetProps(next);
		updates.set(id, next);
	} else if (inst === id) {
		for (const d of g.subtree(id)) {
			const n = g.get(d)!;
			const keep = d === id && top ? getNodeOverrides(n).filter((gr) => gr === 'size') : [];
			updates.set(d, setOverrides(n, keep));
		}
		if (top) updates.set(id, resetProps(updates.get(id)!));
	} else updates.set(id, setOverrides(node, []));
	const after = nodes.map((n) => updates.get(n.id) ?? n);
	const changed = after.some((n, i) => n !== nodes[i]);
	if (!changed) return { ok: true, nodes: nodes as TNode[], ids: [] };
	const synced = syncCanvasComponents(nodes, after as TNode[], options);
	return { ok: true, nodes: synced, ids: [inst] };
}

/**
 * Push overrides to main: copies every overridden value of the (outermost) instance to the
 * main layers it mirrors (geometry, swaps and property values stay with the instance), clears
 * those overrides and updates every other instance.
 */
export function pushCanvasInstanceOverrides<TNode extends CanvasNode>(
	nodes: readonly TNode[],
	id: string,
	options: CanvasComponentSyncOptions = {}
): CanvasComponentResult<TNode> {
	const g = new Graph(nodes);
	const inst = g.get(id) ? rootInstanceIn(g, id) : undefined;
	if (!inst) return fail(nodes, 'not-found', 'Select an instance.');
	const compId = getInstanceData(g.get(inst))!.componentId;
	if (!isCanvasComponent(g.get(compId))) return fail(nodes, 'missing-main', 'The main component was deleted: restore it first.');
	const updates = new Map<string, CanvasNode>();
	let pushed = 0;
	for (const d of g.subtree(inst)) {
		const n = g.get(d)!;
		const overrides = getNodeOverrides(n);
		if (overrides.length === 0) continue;
		const src = d === inst ? compId : getComponentSourceId(n);
		if (!src || !g.get(src) || (src !== compId && !g.isAncestor(compId, src))) continue;
		const groups = overrides.filter(
			(gr) => gr !== 'size' && gr !== 'position' && gr !== 'component' && gr !== 'props' && !(d === inst && (gr === 'data.label' || gr === 'data.name' || isOwnRootGroup(gr)))
		);
		if (groups.length === 0) continue;
		pushed++;
		updates.set(src, copyGroups(n, updates.get(src) ?? g.get(src)!, groups));
		updates.set(d, setOverrides(n, overrides.filter((gr) => !groups.includes(gr))));
	}
	if (pushed === 0) return fail(nodes, 'no-overrides', 'The instance has no changes to push.');
	const after = nodes.map((n) => updates.get(n.id) ?? n);
	return done(nodes, after, [inst], options);
}

/** Swaps instances to another component (or a set's default variant), keeping same-named property values. */
export function swapCanvasInstance<TNode extends CanvasNode>(
	nodes: readonly TNode[],
	ids: Iterable<string>,
	componentId: string,
	options: CanvasComponentSyncOptions & { keepTextOverridesOnly?: boolean } = {}
): CanvasComponentResult<TNode> {
	const g = new Graph(nodes);
	const main = mainOfIn(g, componentId);
	if (!main) return fail(nodes, 'not-found', 'Choose a component or component set.');
	const updates = new Map<string, CanvasNode>();
	const list = [...new Set(ids)];
	for (const id of list) {
		const n = g.get(id);
		const inst = getInstanceData(n);
		if (!n || !inst) return fail(nodes, 'invalid', `"${id}" is not an instance.`);
		if (g.isAncestor(main, id) || createsCycleIn(g, main, n.parentId)) return fail(nodes, 'cycle', "An instance can't show the component it is inside.");
		const defaults = effectivePropsIn(g, main, undefined);
		const properties: Record<string, Value> = {};
		for (const [k, d] of Object.entries(defaults)) properties[k] = inst.properties?.[k] !== undefined && typeof inst.properties[k] === typeof d ? inst.properties[k] : d;
		updates.set(id, withData(n, { ...dataOf(n), [INSTANCE_DATA_KEY]: { ...inst, componentId: main, properties } }));
		if (options.keepTextOverridesOnly) {
			for (const d of g.subtree(id)) {
				const layer = updates.get(d) ?? g.get(d)!;
				const text = typeof layer.type === 'string' && (options.textTypes ?? ['text']).includes(layer.type);
				const keep = getNodeOverrides(layer).filter((gr) => text || (d === id && gr === 'size'));
				updates.set(d, setOverrides(layer, keep));
			}
		}
	}
	if (list.length === 0) return fail(nodes, 'invalid', 'Select an instance.');
	const after = nodes.map((n) => updates.get(n.id) ?? n);
	return done(nodes, after, list, options);
}

/**
 * Sets instance property values: variant properties switch to the matching variant of the set
 * (keeping compatible overrides), others must be defined on the component with the right type
 * (boolean, text, or a component id for instance swap).
 */
export function setCanvasInstanceProperties<TNode extends CanvasNode>(
	nodes: readonly TNode[],
	ids: Iterable<string>,
	properties: Readonly<Record<string, unknown>>,
	options: CanvasComponentSyncOptions = {}
): CanvasComponentResult<TNode> {
	const g = new Graph(nodes);
	const updates = new Map<string, CanvasNode>();
	const list = [...new Set(ids)];
	if (list.length === 0) return fail(nodes, 'invalid', 'Select an instance.');
	for (const id of list) {
		const n = g.get(id);
		const inst = getInstanceData(n);
		if (!n || !inst) return fail(nodes, 'invalid', `"${id}" is not an instance.`);
		const set = variantSetIn(g, inst.componentId);
		const options_ = set ? variantOptionsIn(g, set.id) : [];
		const wanted = { ...getVariantValues(g.get(inst.componentId)) };
		const rest: [string, unknown][] = [];
		for (const [k, v] of Object.entries(properties)) {
			const option = options_.find((o) => o.name === k);
			if (option) {
				const value = typeof v === 'string' ? v : String(v);
				if (!option.values.includes(value)) return fail(nodes, 'invalid', `"${k}" must be one of ${option.values.join(', ')}.`);
				wanted[k] = value;
			} else rest.push([k, v]);
		}
		let target = inst.componentId;
		if (set && !same(wanted, getVariantValues(g.get(inst.componentId)))) target = findVariantIn(g, set.id, wanted) ?? target;
		const defs = propertyDefsIn(g, target);
		const values: Record<string, Value> = { ...(inst.properties ?? {}) };
		for (const [k, v] of rest) {
			const def = defs[k];
			if (!def) {
				const known = [...Object.keys(defs), ...options_.map((o) => o.name)];
				return fail(nodes, 'unknown-property', `Unknown property "${k}"${known.length ? ` (known: ${known.join(', ')})` : ''}.`);
			}
			if (def.type === 'boolean') {
				const b = typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined;
				if (b === undefined) return fail(nodes, 'type-mismatch', `"${k}" takes true or false.`);
				values[k] = b;
			} else if (def.type === 'text') {
				if (typeof v !== 'string' && typeof v !== 'number') return fail(nodes, 'type-mismatch', `"${k}" takes text.`);
				values[k] = String(v);
			} else {
				const main = typeof v === 'string' ? mainOfIn(g, v) : undefined;
				if (!main) return fail(nodes, 'type-mismatch', `"${k}" takes a component id.`);
				if (main === target || componentDepsIn(g, main).has(target) || createsCycleIn(g, main, n.parentId)) {
					return fail(nodes, 'cycle', `"${k}" can't show a component that contains this one.`);
				}
				values[k] = main;
			}
		}
		const properties2 = effectivePropsIn(g, target, values);
		updates.set(id, withData(n, { ...dataOf(n), [INSTANCE_DATA_KEY]: { ...inst, componentId: target, properties: properties2 } }));
	}
	const after = nodes.map((n) => updates.get(n.id) ?? n);
	return done(nodes, after, list, options);
}

/**
 * Adds, edits (`def`) or deletes (`null`) a component property on a component (variants share
 * their set's). `newName` renames it, carrying layer bindings and instance values along.
 */
export function setCanvasComponentProperty<TNode extends CanvasNode>(
	nodes: readonly TNode[],
	componentId: string,
	name: string,
	def: CanvasComponentPropertyDef | null,
	options: CanvasComponentSyncOptions & { newName?: string } = {}
): CanvasComponentResult<TNode> {
	const g = new Graph(nodes);
	const target = g.get(componentId);
	const compId = isCanvasComponentSet(target) ? undefined : owningComponentIn(g, componentId);
	const owner = isCanvasComponentSet(target) ? target! : compId ? variantSetIn(g, compId) ?? g.get(compId)! : undefined;
	if (!owner) return fail(nodes, 'not-found', 'Select a component or component set.');
	const key = isCanvasComponentSet(owner) ? COMPONENT_SET_DATA_KEY : COMPONENT_DATA_KEY;
	const ownerData = { ...(dataOf(owner)[key] ?? {}) };
	const defs: Record<string, CanvasComponentPropertyDef> = { ...(ownerData.properties ?? {}) };
	const finalName = (options.newName ?? name).trim();
	if (!finalName) return fail(nodes, 'invalid', 'Property names must not be empty.');
	if (isCanvasComponentSet(owner) && variantOptionsIn(g, owner.id).some((o) => o.name === finalName)) {
		return fail(nodes, 'invalid', `"${finalName}" is a variant property.`);
	}
	if (finalName !== name && defs[finalName]) return fail(nodes, 'invalid', `"${finalName}" exists already.`);
	if (def === null) {
		if (!defs[name]) return fail(nodes, 'unknown-property', `Unknown property "${name}".`);
		delete defs[name];
	} else {
		if (def.type === 'boolean' && typeof def.default !== 'boolean') return fail(nodes, 'type-mismatch', 'A boolean property needs a boolean default.');
		if (def.type === 'text' && typeof def.default !== 'string') return fail(nodes, 'type-mismatch', 'A text property needs a text default.');
		if (def.type === 'instanceSwap' && !mainOfIn(g, def.default)) return fail(nodes, 'type-mismatch', 'An instance swap property needs a component as default.');
		if (finalName !== name) delete defs[name];
		defs[finalName] = def;
	}
	ownerData.properties = defs;
	const comps = isCanvasComponentSet(owner) ? variantsIn(g, owner.id).map((v) => v.id) : [owner.id];
	const updates = new Map<string, CanvasNode>();
	updates.set(owner.id, withData(owner, { ...dataOf(owner), [key]: ownerData }));
	const renamed = def === null ? null : finalName;
	if (renamed !== name) {
		for (const c of comps) {
			for (const d of g.subtree(c)) {
				const n = updates.get(d) ?? g.get(d)!;
				const refs = { ...getComponentPropertyRefs(n) };
				let touched = false;
				for (const [field, prop] of Object.entries(refs)) {
					if (prop !== name) continue;
					touched = true;
					if (renamed === null) delete refs[field];
					else refs[field] = renamed;
				}
				if (!touched) continue;
				const data: Data = { ...dataOf(n), [COMPONENT_PROPERTY_REFS_DATA_KEY]: refs };
				if (Object.keys(refs).length === 0) delete data[COMPONENT_PROPERTY_REFS_DATA_KEY];
				updates.set(d, withData(n, data));
			}
		}
		for (const n of nodes) {
			const inst = getInstanceData(n);
			if (!inst || !comps.includes(inst.componentId) || !inst.properties || !(name in inst.properties)) continue;
			const props = { ...inst.properties };
			const v = props[name];
			delete props[name];
			if (renamed !== null) props[renamed] = v;
			const cur = updates.get(n.id) ?? n;
			updates.set(n.id, withData(cur, { ...dataOf(cur), [INSTANCE_DATA_KEY]: { ...inst, properties: props } }));
		}
	}
	const after = nodes.map((n) => updates.get(n.id) ?? n);
	return done(nodes, after, [owner.id], options);
}

/**
 * Binds a field of a main-component layer to a component property (`null` unbinds): `visible`
 * takes a boolean property, `data.<key>` a text property, `component` (on a nested instance) an
 * instance swap property.
 */
export function bindCanvasComponentProperty<TNode extends CanvasNode>(
	nodes: readonly TNode[],
	layerId: string,
	field: CanvasComponentPropertyField,
	name: string | null,
	options: CanvasComponentSyncOptions = {}
): CanvasComponentResult<TNode> {
	const g = new Graph(nodes);
	const layer = g.get(layerId);
	const compId = layer ? owningComponentIn(g, layerId) : undefined;
	if (!layer || !compId || compId === layerId) return fail(nodes, 'not-found', 'Select a layer of a main component.');
	const inst = enclosingInstanceIn(g, layerId);
	if (inst && g.isAncestor(compId, inst)) return fail(nodes, 'inside-instance', "Layers of a nested instance can't be bound: bind the nested instance's own main.");
	const refs = { ...getComponentPropertyRefs(layer) };
	if (name === null) delete refs[field];
	else {
		const def = propertyDefsIn(g, compId)[name];
		if (!def) return fail(nodes, 'unknown-property', `Unknown property "${name}".`);
		const ok =
			(def.type === 'boolean' && field === 'visible') ||
			(def.type === 'text' && field.startsWith('data.')) ||
			(def.type === 'instanceSwap' && field === 'component' && isCanvasInstance(layer));
		if (!ok) return fail(nodes, 'type-mismatch', `A ${def.type} property can't drive "${field}".`);
		refs[field] = name;
	}
	const data = { ...dataOf(layer) };
	if (Object.keys(refs).length) data[COMPONENT_PROPERTY_REFS_DATA_KEY] = refs;
	else delete data[COMPONENT_PROPERTY_REFS_DATA_KEY];
	const after = nodes.map((n) => (n.id === layerId ? withData(n, data) : n));
	return done(nodes, after, [layerId], options);
}

/**
 * Restore Main Component of an instance whose main was deleted: the instance becomes the main
 * again, with its old id, and its layers take the ids their copies mirror, so every other
 * instance re-links. Its property values become the property defaults.
 */
export function restoreCanvasMainComponent<TNode extends CanvasNode>(
	nodes: readonly TNode[],
	id: string,
	options: CanvasComponentSyncOptions = {}
): CanvasComponentResult<TNode> {
	const g = new Graph(nodes);
	const inst = getInstanceData(g.get(id));
	if (!inst) return fail(nodes, 'invalid', 'Select an instance.');
	if (g.get(inst.componentId)) return fail(nodes, 'invalid', 'The main component still exists.');
	if (enclosingInstanceIn(g, id) !== undefined) return fail(nodes, 'nested-instance', 'Select the outer instance.');
	const compId = inst.componentId;
	const sub = g.subtree(id);
	const map = new Map<string, string>([[id, compId]]);
	const taken = new Set(nodes.map((n) => n.id));
	taken.add(compId);
	for (const d of sub) {
		if (d === id) continue;
		const src = enclosingInstanceIn(g, d) === id ? getComponentSourceId(g.get(d)) : undefined;
		if (src && !taken.has(src)) {
			map.set(d, src);
			taken.add(src);
		}
	}
	const nested: string[] = [];
	const replaced = new Map<string, CanvasNode>();
	for (const d of sub) {
		let n = g.get(d)!;
		const nid = map.get(d) ?? d;
		const parentId = n.parentId !== undefined ? map.get(n.parentId) ?? n.parentId : undefined;
		n = { ...n, id: nid, ...(parentId !== undefined ? { parentId } : {}) };
		if (d === id) {
			const defs: Record<string, CanvasComponentPropertyDef> = {};
			for (const [k, v] of Object.entries(inst.properties ?? {})) {
				if (typeof v === 'boolean') defs[k] = { type: 'boolean', default: v };
				else if (typeof v === 'string' && isCanvasComponent(g.get(v))) defs[k] = { type: 'instanceSwap', default: v };
				else if (typeof v === 'string') defs[k] = { type: 'text', default: v };
			}
			const data = { ...dataOf(n) };
			delete data[INSTANCE_DATA_KEY];
			delete data[COMPONENT_SOURCE_DATA_KEY];
			delete data[COMPONENT_OVERRIDES_DATA_KEY];
			data[COMPONENT_DATA_KEY] = Object.keys(defs).length ? { properties: defs } : {};
			n = withData(n, data);
		} else if (enclosingInstanceIn(g, d) === id) {
			if (isCanvasInstance(n)) nested.push(nid);
			else n = unlinked(n);
		}
		replaced.set(d, n);
	}
	let after: CanvasNode[] = nodes.map((n) => replaced.get(n.id) ?? n);
	for (const nn of nested) after = rebaseInstance(after, nn, options.tokens);
	return done(nodes, after, [compId], options);
}
