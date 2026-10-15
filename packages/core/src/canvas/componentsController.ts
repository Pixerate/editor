// Portions ported from figcraft/crates/engine/src/cmd/component.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import type { ArrangeHistoryTarget } from './arrangeController.js';
import {
	addCanvasVariant,
	bindCanvasComponentProperty,
	combineCanvasComponentsAsVariants,
	createCanvasComponent,
	createCanvasInstance,
	detachCanvasInstance,
	getInstanceData,
	getNodeOverrides,
	getOwningInstance,
	getRootInstance,
	getVariantSet,
	inspectCanvasInstance,
	isCanvasComponent,
	isCanvasComponentSet,
	isInsideInstance,
	listCanvasComponents,
	pushCanvasInstanceOverrides,
	removeCanvasVariant,
	renameCanvasVariantProperty,
	renameCanvasVariantValue,
	resetCanvasInstanceOverrides,
	restoreCanvasMainComponent,
	setCanvasComponentProperty,
	setCanvasInstanceProperties,
	setCanvasVariantProperties,
	swapCanvasInstance,
	syncAllCanvasInstances,
	syncCanvasComponents,
	wouldCreateComponentCycle,
	type AddCanvasVariantOptions,
	type CanvasComponentPropertyDef,
	type CanvasComponentPropertyField,
	type CanvasComponentResult,
	type CanvasComponentSyncOptions,
	type CreateCanvasComponentOptions,
	type CreateCanvasInstanceOptions
} from './components.js';
import type { CanvasNode } from './types.js';

export interface CanvasComponentsControllerOptions<TNode extends CanvasNode = CanvasNode> extends CanvasComponentSyncOptions {
	getNodes: () => TNode[];
	setNodes: (nodes: TNode[]) => void;
	/** When set, every component action is one undoable step. */
	history?: ArrangeHistoryTarget;
	/** The selection (default: nodes with `selected`). */
	getSelectedIds?: () => string[];
	/** Called by `goToMainComponent` with the main (e.g. to pan the viewport to it). */
	onReveal?: (node: TNode) => void;
}

/** One side of an undo step: nodes to put (or remove, `null`) and the array order to restore. */
interface NodePatch {
	changes: Map<string, CanvasNode | null>;
	order: string[];
}

function makePatch(from: readonly CanvasNode[], to: readonly CanvasNode[]): NodePatch {
	const fromIds = new Map(from.map((n) => [n.id, n]));
	const toIds = new Set(to.map((n) => n.id));
	const changes = new Map<string, CanvasNode | null>();
	for (const n of to) if (fromIds.get(n.id) !== n) changes.set(n.id, n);
	for (const n of from) if (!toIds.has(n.id)) changes.set(n.id, null);
	return { changes, order: to.map((n) => n.id) };
}

/** Applies a patch to the current nodes, keeping nodes it doesn't name as they are now. */
function applyPatch<TNode extends CanvasNode>(current: readonly TNode[], patch: NodePatch): TNode[] {
	const byId = new Map<string, CanvasNode>(current.map((n) => [n.id, n]));
	for (const [id, n] of patch.changes) {
		if (n) byId.set(id, n);
		else byId.delete(id);
	}
	const out: CanvasNode[] = [];
	const placed = new Set<string>();
	for (const id of patch.order) {
		const n = byId.get(id);
		if (n && !placed.has(id)) {
			out.push(n);
			placed.add(id);
		}
	}
	for (const n of current) if (!placed.has(n.id) && byId.has(n.id)) out.push(byId.get(n.id)!);
	return out as TNode[];
}

/**
 * Framework-agnostic components controller shared by the React hook and the Svelte rune. Its
 * actions (create component / instance, combine as variants, add / remove / edit / rename
 * variants, detach, reset, push, swap, set properties, restore main) are one undoable step each with a `history`; `sync()` keeps
 * instances following their mains after any other edit (call it after the nodes change).
 * Each `can…` check returns `true` or the reason the action can't run.
 */
export function createCanvasComponentsController<TNode extends CanvasNode = CanvasNode>(options: CanvasComponentsControllerOptions<TNode>) {
	let synced: TNode[] | undefined;
	const syncOptions = (): CanvasComponentSyncOptions => ({
		idGenerator: options.idGenerator,
		textTypes: options.textTypes,
		layout: options.layout,
		tokens: options.tokens
	});
	const selection = (ids?: Iterable<string>): string[] =>
		ids ? [...ids] : options.getSelectedIds?.() ?? options.getNodes().filter((n) => n.selected).map((n) => n.id);
	const target = (id?: string) => id ?? selection()[0];

	function set(next: TNode[]) {
		synced = next;
		options.setNodes(next);
	}

	/** Syncs edits made since the last sync (overrides, main edits) and returns the nodes. */
	function sync(): TNode[] {
		const nodes = options.getNodes();
		if (synced === undefined || nodes === synced) {
			synced = nodes;
			return nodes;
		}
		const next = syncCanvasComponents(synced, nodes, syncOptions());
		synced = next;
		if (next !== nodes) options.setNodes(next);
		return next;
	}

	function run(name: string, op: (nodes: TNode[]) => CanvasComponentResult<TNode>): CanvasComponentResult<TNode> {
		const before = sync();
		const result = op(before);
		if (!result.ok || result.nodes === before) return result;
		const forward = makePatch(before, result.nodes);
		const backward = makePatch(result.nodes, before);
		const execute = () => set(applyPatch(options.getNodes(), forward));
		const undo = () => set(applyPatch(options.getNodes(), backward));
		if (options.history) options.history.execute({ name, execute, undo });
		else execute();
		return result;
	}

	const reason = (result: CanvasComponentResult<TNode>): true | string => (result.ok ? true : result.reason);
	const nodes = () => options.getNodes();
	const refused = (why: string) => ({ ok: false, nodes: nodes(), code: 'not-found', reason: why }) as CanvasComponentResult<TNode>;
	/** The set `id` names (a set, or a variant's set; default: the selection's). */
	const setOf = (id?: string): string | undefined => {
		const at = target(id);
		const node = at ? nodes().find((n) => n.id === at) : undefined;
		if (!node) return undefined;
		return isCanvasComponentSet(node) ? node.id : getVariantSet(nodes(), node.id);
	};
	/** The variant `id` names (default: the first selected variant). */
	const variantOf = (id?: string): string | undefined => {
		const at = target(id);
		return at && getVariantSet(nodes(), at) ? at : undefined;
	};
	const NO_SET = 'Select a component set or one of its variants.';
	const NO_VARIANT = 'Select a variant of a component set.';
	type VariantOptions = Omit<AddCanvasVariantOptions, keyof CanvasComponentSyncOptions>;
	/** `addVariant` options with `from` defaulting to the selected variant. */
	const addOptions = (setId: string | undefined, addOptions_: VariantOptions): VariantOptions => {
		if (addOptions_.from !== undefined || setId !== undefined) return addOptions_;
		const v = variantOf();
		return v ? { ...addOptions_, from: v } : addOptions_;
	};

	const controller = {
		sync,
		/** Rebuilds every instance from its main (e.g. after loading), not recorded in history. */
		syncAll(): TNode[] {
			const next = syncAllCanvasInstances(nodes(), syncOptions());
			if (next !== nodes()) set(next);
			else synced = next;
			return next;
		},

		/** Create Component from `ids` (default: the selection). */
		createComponent(ids?: Iterable<string>, createOptions: Omit<CreateCanvasComponentOptions, keyof CanvasComponentSyncOptions> = {}) {
			const list = selection(ids);
			return run('Create Component', (n) => createCanvasComponent(n, list, { ...syncOptions(), ...createOptions }));
		},
		canCreateComponent: (ids?: Iterable<string>) => reason(createCanvasComponent(nodes(), selection(ids), { layout: false })),

		/** Combine as Variants: wraps the selected components in a component set. */
		combineAsVariants(ids?: Iterable<string>, combineOptions: { id?: string; name?: string; padding?: number } = {}) {
			const list = selection(ids);
			return run('Combine as Variants', (n) => combineCanvasComponentsAsVariants(n, list, { ...syncOptions(), ...combineOptions }));
		},
		canCombineAsVariants: (ids?: Iterable<string>) => reason(combineCanvasComponentsAsVariants(nodes(), selection(ids), { layout: false })),

		/** Create Instance of a component or component set. */
		createInstance(componentId: string, createOptions: Omit<CreateCanvasInstanceOptions, keyof CanvasComponentSyncOptions> = {}) {
			return run('Create Instance', (n) => createCanvasInstance(n, componentId, { ...syncOptions(), ...createOptions }));
		},
		canCreateInstance(componentId?: string, parentId?: string): true | string {
			const list = nodes();
			const target = componentId ? list.find((n) => n.id === componentId) : undefined;
			if (!target || (!isCanvasComponent(target) && !isCanvasComponentSet(target))) return 'Choose a component or component set.';
			if (wouldCreateComponentCycle(list, componentId!, parentId)) return "An instance can't be placed inside its own main component.";
			if (parentId && getOwningInstance(list, parentId)) return "Instances can't gain layers: place it outside the instance.";
			return true;
		},

		/** Detach Instance (default: the selected instances). */
		detachInstance(ids?: Iterable<string>) {
			const list = selection(ids);
			return run('Detach Instance', (n) => detachCanvasInstance(n, list, syncOptions()));
		},
		canDetachInstance(ids?: Iterable<string>): true | string {
			const list = nodes();
			const instances = selection(ids).filter((id) => getInstanceData(list.find((n) => n.id === id)));
			if (instances.length === 0) return 'Select an instance.';
			if (instances.some((id) => isInsideInstance(list, id))) return "A nested instance can't be detached on its own: detach the outer instance first.";
			return true;
		},

		/** Reset overrides of an instance or layer (default: the first selected); `group` resets one. */
		resetOverrides(id?: string, group?: string) {
			const at = target(id);
			if (!at) return { ok: false, nodes: nodes(), code: 'not-found', reason: 'Select an instance or a layer inside one.' } as CanvasComponentResult<TNode>;
			return run(group ? 'Reset Override' : 'Reset All Changes', (n) => resetCanvasInstanceOverrides(n, at, group, syncOptions()));
		},
		canResetOverrides(id?: string): true | string {
			const at = target(id);
			const info = at ? inspectCanvasInstance(nodes(), at) : undefined;
			if (!info) return 'Select an instance or a layer inside one.';
			const changedProps = !info.nested && info.properties.some((p) => p.value !== p.default);
			const own = info.id === at ? info.overrides.length > 0 : getNodeOverrides(nodes().find((n) => n.id === at)).length > 0;
			return own || (info.id === at && changedProps) ? true : 'No overrides to reset.';
		},

		/** Push the (outermost) instance's overrides to its main component. */
		pushOverrides(id?: string) {
			const at = target(id);
			if (!at) return { ok: false, nodes: nodes(), code: 'not-found', reason: 'Select an instance.' } as CanvasComponentResult<TNode>;
			return run('Push Changes to Main Component', (n) => pushCanvasInstanceOverrides(n, at, syncOptions()));
		},
		canPushOverrides(id?: string): true | string {
			const at = target(id);
			return at ? reason(pushCanvasInstanceOverrides(nodes(), at, { layout: false })) : 'Select an instance.';
		},

		/** Swap the selected instances to another component (or a set's default variant). */
		swapInstance(componentId: string, ids?: Iterable<string>, swapOptions: { keepTextOverridesOnly?: boolean } = {}) {
			const list = selection(ids);
			return run('Swap Instance', (n) => swapCanvasInstance(n, list, componentId, { ...syncOptions(), ...swapOptions }));
		},
		canSwapInstance(componentId?: string, ids?: Iterable<string>): true | string {
			const list = nodes();
			const instances = selection(ids).filter((id) => getInstanceData(list.find((n) => n.id === id)));
			if (instances.length === 0) return 'Select an instance.';
			if (componentId === undefined) return true;
			const main = list.find((n) => n.id === componentId);
			if (!main || (!isCanvasComponent(main) && !isCanvasComponentSet(main))) return 'Choose a component or component set.';
			for (const id of instances) {
				const node = list.find((n) => n.id === id)!;
				if (wouldCreateComponentCycle(list, componentId, node.parentId)) return "An instance can't show the component it is inside.";
			}
			return true;
		},

		/** Set variant / component property values on the selected instances (one step). */
		setInstanceProperties(properties: Record<string, unknown>, ids?: Iterable<string>) {
			const list = selection(ids);
			return run('Set Instance Properties', (n) => setCanvasInstanceProperties(n, list, properties, syncOptions()));
		},
		canSetInstanceProperties(ids?: Iterable<string>): true | string {
			const list = nodes();
			const sel = selection(ids);
			return sel.length > 0 && sel.every((id) => getInstanceData(list.find((n) => n.id === id))) ? true : 'Select instances.';
		},

		/** Restore Main Component from an instance whose main was deleted. */
		restoreMainComponent(id?: string) {
			const at = target(id);
			if (!at) return { ok: false, nodes: nodes(), code: 'not-found', reason: 'Select an instance.' } as CanvasComponentResult<TNode>;
			return run('Restore Main Component', (n) => restoreCanvasMainComponent(n, at, syncOptions()));
		},
		canRestoreMainComponent(id?: string): true | string {
			const at = target(id);
			return at ? reason(restoreCanvasMainComponent(nodes(), at, { layout: false })) : 'Select an instance.';
		},

		/** Adds, edits or (with `null`) deletes a component property. */
		setComponentProperty(componentId: string, name: string, def: CanvasComponentPropertyDef | null, propertyOptions: { newName?: string } = {}) {
			return run(def ? 'Edit Component Property' : 'Delete Component Property', (n) =>
				setCanvasComponentProperty(n, componentId, name, def, { ...syncOptions(), ...propertyOptions })
			);
		},

		/**
		 * Adds a variant to a set (default: the selection's set) by duplicating `from` (default:
		 * the selected variant, else the default variant) with the given `variant` values.
		 */
		addVariant(setId?: string, variantOptions: VariantOptions = {}) {
			const set = setOf(setId);
			if (!set) return refused(NO_SET);
			const opts = addOptions(setId, variantOptions);
			return run('Add Variant', (n) => addCanvasVariant(n, set, { ...syncOptions(), ...opts }));
		},
		canAddVariant(setId?: string, variantOptions: VariantOptions = {}): true | string {
			const set = setOf(setId);
			return set ? reason(addCanvasVariant(nodes(), set, { ...addOptions(setId, variantOptions), layout: false })) : NO_SET;
		},

		/** Removes a variant (default: the selected one); its instances switch to the closest variant. */
		removeVariant(variantId?: string) {
			const v = variantOf(variantId);
			if (!v) return refused(NO_VARIANT);
			return run('Remove Variant', (n) => removeCanvasVariant(n, v, syncOptions()));
		},
		canRemoveVariant(variantId?: string): true | string {
			const v = variantOf(variantId);
			return v ? reason(removeCanvasVariant(nodes(), v, { layout: false })) : NO_VARIANT;
		},

		/** Edits a variant's property values (default: the selected variant). */
		setVariantProperties(values: Record<string, string>, variantId?: string, variantOptions: { defaultValue?: string } = {}) {
			const v = variantOf(variantId);
			if (!v) return refused(NO_VARIANT);
			return run('Edit Variant', (n) => setCanvasVariantProperties(n, v, values, { ...syncOptions(), ...variantOptions }));
		},
		canSetVariantProperties(values?: Record<string, string>, variantId?: string): true | string {
			const v = variantOf(variantId);
			if (!v) return NO_VARIANT;
			return values ? reason(setCanvasVariantProperties(nodes(), v, values, { layout: false })) : true;
		},

		/** Renames a variant property across a set (default: the selection's set). */
		renameVariantProperty(name: string, newName: string, setId?: string) {
			const set = setOf(setId);
			if (!set) return refused(NO_SET);
			return run('Rename Variant Property', (n) => renameCanvasVariantProperty(n, set, name, newName, syncOptions()));
		},
		canRenameVariantProperty(name?: string, newName?: string, setId?: string): true | string {
			const set = setOf(setId);
			if (!set) return NO_SET;
			return name !== undefined && newName !== undefined ? reason(renameCanvasVariantProperty(nodes(), set, name, newName, { layout: false })) : true;
		},

		/** Renames a value of a variant property across a set (default: the selection's set). */
		renameVariantValue(property: string, value: string, newValue: string, setId?: string) {
			const set = setOf(setId);
			if (!set) return refused(NO_SET);
			return run('Rename Variant Value', (n) => renameCanvasVariantValue(n, set, property, value, newValue, syncOptions()));
		},
		canRenameVariantValue(property?: string, value?: string, newValue?: string, setId?: string): true | string {
			const set = setOf(setId);
			if (!set) return NO_SET;
			return property !== undefined && value !== undefined && newValue !== undefined
				? reason(renameCanvasVariantValue(nodes(), set, property, value, newValue, { layout: false }))
				: true;
		},

		/** Binds (or with `null` unbinds) a main layer's field to a component property. */
		bindComponentProperty(layerId: string, field: CanvasComponentPropertyField, name: string | null) {
			return run('Bind Component Property', (n) => bindCanvasComponentProperty(n, layerId, field, name, syncOptions()));
		},

		/** Selects the main component of an instance (or of the instance a layer is in). */
		goToMainComponent(id?: string): string | undefined {
			const at = target(id);
			const list = sync();
			const inst = at ? getOwningInstance(list, at) : undefined;
			const main = inst ? getInstanceData(list.find((n) => n.id === inst))?.componentId : undefined;
			const node = main ? list.find((n) => n.id === main) : undefined;
			if (!node) return undefined;
			const next = list.map((n) => (!!n.selected === (n.id === main) ? n : ({ ...n, selected: n.id === main } as TNode)));
			set(next);
			options.onReveal?.(next.find((n) => n.id === main)!);
			return main;
		},
		canGoToMainComponent(id?: string): true | string {
			const at = target(id);
			const list = nodes();
			const inst = at ? getOwningInstance(list, at) : undefined;
			if (!inst) return 'Select an instance.';
			const main = getInstanceData(list.find((n) => n.id === inst))!.componentId;
			return list.some((n) => n.id === main) ? true : 'The main component was deleted.';
		},

		/** Components and component sets, for a components panel. */
		list: () => listCanvasComponents(nodes()),
		/** The instance inspector's view of an instance or a layer inside one (default: the selection). */
		inspect: (id?: string) => {
			const at = target(id);
			return at ? inspectCanvasInstance(nodes(), at) : undefined;
		},
		/** The outermost instance containing `id`. */
		rootInstanceOf: (id: string) => getRootInstance(nodes(), id)
	};
	return controller;
}

export type CanvasComponentsController<TNode extends CanvasNode = CanvasNode> = ReturnType<typeof createCanvasComponentsController<TNode>>;

/** Drag data type for dragging a component from a components panel onto a canvas. */
export const CANVAS_COMPONENT_DRAG_TYPE = 'application/x-pixerate-component';

/** Reads the component id a components panel put on a drag (or `undefined`). */
export function getCanvasComponentDragId(dataTransfer: Pick<DataTransfer, 'getData'> | null | undefined): string | undefined {
	const id = dataTransfer?.getData(CANVAS_COMPONENT_DRAG_TYPE);
	return id ? id : undefined;
}

