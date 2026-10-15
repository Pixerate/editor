import React, { useState } from 'react';
import {
	CANVAS_COMPONENT_DRAG_TYPE,
	inspectCanvasInstance,
	listCanvasComponents,
	type CanvasComponentsController,
	type CanvasNode
} from '@pixerate/editor/canvas';

/** The variant-editing actions the components panel runs (a components controller or hook satisfies it). */
export type CanvasComponentsPanelActions = Pick<
	CanvasComponentsController<any>,
	'addVariant' | 'removeVariant' | 'setVariantProperties' | 'renameVariantProperty' | 'renameVariantValue'
>;

export interface CanvasComponentsPanelProps<TNode extends CanvasNode = CanvasNode> {
	nodes: TNode[];
	/** Inserts an instance of a component (or a set's default variant); called on click. */
	onInsert: (componentId: string) => void;
	/**
	 * Variant editing: with it, sets get "+ Variant" and a properties editor (rename properties
	 * and values inline), and variants a menu (also on right click) to edit, duplicate or remove them.
	 */
	components?: CanvasComponentsPanelActions;
	/** Receives refusals (e.g. a duplicate variant combination). */
	onError?: (reason: string) => void;
	/** Show the search field (default `true`). */
	search?: boolean;
	className?: string;
}

type Outcome = { ok: boolean; reason?: string } | undefined;

/** A text field that commits on blur / Enter when its value changed (Escape reverts). */
function InlineField({ value, label, onCommit }: { value: string; label: string; onCommit: (next: string) => void }) {
	return (
		<input
			key={value}
			type="text"
			aria-label={label}
			defaultValue={value}
			className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-xs"
			onBlur={(e) => {
				const next = e.currentTarget.value.trim();
				if (next && next !== value) onCommit(next);
				else e.currentTarget.value = value;
			}}
			onKeyDown={(e) => {
				if (e.key === 'Enter') e.currentTarget.blur();
				if (e.key === 'Escape') {
					e.currentTarget.value = value;
					e.currentTarget.blur();
				}
			}}
		/>
	);
}

/**
 * Components panel: component sets (with their variants) and lone components. Click one to
 * insert an instance, or drag it onto the canvas (the drag carries the id as
 * `CANVAS_COMPONENT_DRAG_TYPE`; read it with `getCanvasComponentDragId`). With `components`,
 * sets and variants can be edited: "+ Variant", rename properties / values, edit, duplicate or
 * remove a variant.
 */
export function CanvasComponentsPanel<TNode extends CanvasNode = CanvasNode>({
	nodes,
	onInsert,
	components,
	onError,
	search = true,
	className = ''
}: CanvasComponentsPanelProps<TNode>) {
	const [query, setQuery] = useState('');
	const [propsOpen, setPropsOpen] = useState<string | null>(null);
	const [menuFor, setMenuFor] = useState<string | null>(null);
	const [editing, setEditing] = useState<string | null>(null);
	const { components: all, sets } = listCanvasComponents(nodes);
	const q = query.trim().toLowerCase();
	const match = (name: string) => !q || name.toLowerCase().includes(q);
	const lone = all.filter((c) => !c.setId && match(c.name));
	const shownSets = sets.filter((s) => match(s.name) || s.variants.some((v) => match(v.name)));
	const report = (result: Outcome) => {
		if (result && !result.ok && result.reason) onError?.(result.reason);
		return !!result?.ok;
	};
	const small = 'shrink-0 rounded px-1 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40';
	const menuItem = 'rounded px-2 py-0.5 text-left hover:bg-muted disabled:opacity-40';
	const item = (id: string, name: string, count: number, extra: Record<string, string> = {}, onContextMenu?: (e: React.MouseEvent) => void) => (
		<button
			key={id}
			type="button"
			draggable
			data-component-id={id}
			{...extra}
			className="flex w-full min-w-0 items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted"
			title={`Insert an instance of ${name}`}
			onClick={() => onInsert(id)}
			onContextMenu={onContextMenu}
			onDragStart={(e) => {
				e.dataTransfer.setData(CANVAS_COMPONENT_DRAG_TYPE, id);
				e.dataTransfer.setData('text/plain', name);
				e.dataTransfer.effectAllowed = 'copy';
			}}
		>
			<span className="truncate">
				<span aria-hidden className="mr-1 text-muted-foreground">
					◇
				</span>
				{name}
			</span>
			<span className="text-[10px] text-muted-foreground" data-instance-count="">
				{count}
			</span>
		</button>
	);
	return (
		<div data-components-panel="" className={`flex flex-col gap-1 text-xs text-foreground ${className}`}>
			{search ? (
				<input
					type="search"
					aria-label="Search components"
					placeholder="Search components"
					className="rounded border border-border bg-background px-2 py-1 text-xs"
					onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
				/>
			) : null}
			{shownSets.map((set) => (
				<div key={set.id} data-component-set={set.id} className="flex flex-col">
					<div className="flex items-center gap-1">
						{item(set.id, set.name, set.variants.reduce((sum, v) => sum + v.instanceCount, 0), { 'data-kind': 'set' })}
						{components ? (
							<>
								<button
									type="button"
									className={small}
									data-action="add-variant"
									aria-label={`Add a variant to ${set.name}`}
									title="Add a variant (duplicates the default variant)"
									onClick={() => report(components.addVariant(set.id))}
								>
									+&nbsp;Variant
								</button>
								<button
									type="button"
									className={small}
									data-action="variant-properties"
									aria-expanded={propsOpen === set.id}
									aria-label={`Edit the variant properties of ${set.name}`}
									title="Rename variant properties and values"
									onClick={() => setPropsOpen(propsOpen === set.id ? null : set.id)}
								>
									⚙
								</button>
							</>
						) : null}
					</div>
					{components && propsOpen === set.id ? (
						<div data-variant-properties={set.id} className="ml-3 flex flex-col gap-1 border-l border-border py-1 pl-2">
							{set.options.map((option) => (
								<div key={option.name} data-variant-option={option.name} className="flex flex-col gap-0.5">
									<InlineField
										value={option.name}
										label={`Rename property ${option.name}`}
										onCommit={(next) => report(components.renameVariantProperty(option.name, next, set.id))}
									/>
									<div className="ml-2 flex flex-wrap gap-1">
										{option.values.map((value) => (
											<InlineField
												key={value}
												value={value}
												label={`Rename ${option.name} value ${value}`}
												onCommit={(next) => report(components.renameVariantValue(option.name, value, next, set.id))}
											/>
										))}
									</div>
								</div>
							))}
						</div>
					) : null}
					<div className="ml-3 flex flex-col border-l border-border pl-1">
						{set.variants.map((v) => (
							<div key={v.id} data-variant-row={v.id} className="flex flex-col">
								<div className="flex items-center gap-1">
									{item(
										v.id,
										v.name,
										v.instanceCount,
										{ 'data-kind': 'variant' },
										components
											? (e) => {
													e.preventDefault();
													setMenuFor(v.id);
												}
											: undefined
									)}
									{components ? (
										<button
											type="button"
											className={small}
											data-action="variant-menu"
											aria-haspopup="menu"
											aria-expanded={menuFor === v.id}
											aria-label={`Variant actions for ${v.name}`}
											onClick={() => setMenuFor(menuFor === v.id ? null : v.id)}
										>
											⋯
										</button>
									) : null}
								</div>
								{components && menuFor === v.id ? (
									<div role="menu" data-variant-menu={v.id} className="ml-2 flex flex-col rounded border border-border bg-background p-1 shadow">
										<button
											type="button"
											role="menuitem"
											className={menuItem}
											data-action="edit-variant"
											onClick={() => {
												setEditing(v.id);
												setMenuFor(null);
											}}
										>
											Edit values…
										</button>
										<button
											type="button"
											role="menuitem"
											className={menuItem}
											data-action="duplicate-variant"
											onClick={() => {
												setMenuFor(null);
												report(components.addVariant(set.id, { from: v.id }));
											}}
										>
											Duplicate
										</button>
										<button
											type="button"
											role="menuitem"
											className={menuItem}
											data-action="remove-variant"
											disabled={set.variants.length < 2}
											title={set.variants.length < 2 ? 'A component set needs at least one variant.' : 'Its instances switch to the closest variant'}
											onClick={() => {
												setMenuFor(null);
												report(components.removeVariant(v.id));
											}}
										>
											Remove variant
										</button>
									</div>
								) : null}
								{components && editing === v.id ? (
									<form
										data-variant-editor={v.id}
										className="ml-2 flex flex-col gap-1 py-1"
										onSubmit={(e) => {
											e.preventDefault();
											const values: Record<string, string> = {};
											for (const input of e.currentTarget.querySelectorAll<HTMLInputElement>('input[data-variant-value]')) {
												values[input.dataset.variantValue!] = input.value;
											}
											if (report(components.setVariantProperties(values, v.id))) setEditing(null);
										}}
									>
										{set.options.map((option) => (
											<label key={option.name} className="flex items-center gap-2">
												<span className="w-16 shrink-0 truncate text-muted-foreground">{option.name}</span>
												<input
													type="text"
													data-variant-value={option.name}
													aria-label={`${option.name} value`}
													defaultValue={v.variant?.[option.name] ?? ''}
													className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-xs"
												/>
											</label>
										))}
										<div className="flex gap-1">
											<button type="submit" className="rounded border border-border px-2 py-0.5 hover:bg-muted" data-action="save-variant">
												Save
											</button>
											<button type="button" className="rounded px-2 py-0.5 hover:bg-muted" data-action="cancel-variant" onClick={() => setEditing(null)}>
												Cancel
											</button>
										</div>
									</form>
								) : null}
							</div>
						))}
					</div>
				</div>
			))}
			{lone.map((c) => item(c.id, c.name, c.instanceCount, { 'data-kind': 'component' }))}
			{all.length === 0 ? <p className="text-muted-foreground">No components yet. Select a frame and choose Create Component.</p> : null}
		</div>
	);
}

/** The actions the instance inspector runs (a components controller or hook satisfies it). */
export type CanvasInstanceInspectorActions = Pick<
	CanvasComponentsController<any>,
	'setInstanceProperties' | 'resetOverrides' | 'detachInstance' | 'goToMainComponent' | 'pushOverrides' | 'restoreMainComponent'
>;

export interface CanvasInstanceInspectorProps<TNode extends CanvasNode = CanvasNode> {
	nodes: TNode[];
	/** An instance, or a layer inside one; nothing is shown otherwise. */
	nodeId: string | null | undefined;
	components: CanvasInstanceInspectorActions;
	/** Receives refusals (e.g. a property value that would nest a component in itself). */
	onError?: (reason: string) => void;
	className?: string;
}

/**
 * Instance inspector: main component (or "missing main" with Restore), variant pickers,
 * component property controls, the overrides of its layers (each resettable), and Reset all,
 * Detach, Go to main and Push changes.
 */
export function CanvasInstanceInspector<TNode extends CanvasNode = CanvasNode>({
	nodes,
	nodeId,
	components,
	onError,
	className = ''
}: CanvasInstanceInspectorProps<TNode>) {
	const info = nodeId ? inspectCanvasInstance(nodes, nodeId) : undefined;
	if (!info) return null;
	const report = (result: { ok: boolean; reason?: string } | undefined) => {
		if (result && !result.ok && result.reason) onError?.(result.reason);
	};
	const setProp = (name: string, value: unknown) => report(components.setInstanceProperties({ [name]: value }, [info.id]));
	const allComponents = listCanvasComponents(nodes).components;
	const linked = info.status === 'linked';
	const btn = 'rounded border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-40';
	return (
		<div data-instance-inspector="" data-instance-id={info.id} className={`flex flex-col gap-2 text-xs text-foreground ${className}`}>
			<div className="flex items-center justify-between gap-2">
				<span className="truncate font-medium" data-instance-main="">
					{linked ? info.componentName : 'Main component missing'}
				</span>
				{info.nested ? <span className="text-muted-foreground">Nested</span> : null}
			</div>
			{info.variantOptions.map((option) => (
				<label key={option.name} className="flex items-center gap-2" data-variant-property={option.name}>
					<span className="w-24 shrink-0 truncate text-muted-foreground">{option.name}</span>
					<select
						aria-label={`${option.name} variant`}
						className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-xs"
						value={info.variant[option.name] ?? ''}
						onChange={(e) => setProp(option.name, e.currentTarget.value)}
					>
						{option.values.map((v) => (
							<option key={v} value={v}>
								{v}
							</option>
						))}
					</select>
				</label>
			))}
			{info.properties.map((p) => (
				<label key={p.name} className="flex items-center gap-2" data-component-property={p.name}>
					<span className="w-24 shrink-0 truncate text-muted-foreground">{p.name}</span>
					{p.type === 'boolean' ? (
						<input type="checkbox" aria-label={p.name} checked={p.value === true} onChange={(e) => setProp(p.name, e.currentTarget.checked)} />
					) : p.type === 'text' ? (
						<input
							key={String(p.value)}
							type="text"
							aria-label={p.name}
							defaultValue={String(p.value)}
							className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-xs"
							onBlur={(e) => {
								if (e.currentTarget.value !== p.value) setProp(p.name, e.currentTarget.value);
							}}
							onKeyDown={(e) => {
								if (e.key === 'Enter') e.currentTarget.blur();
							}}
						/>
					) : (
						<select
							aria-label={p.name}
							className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-xs"
							value={String(p.value)}
							onChange={(e) => setProp(p.name, e.currentTarget.value)}
						>
							{allComponents
								.filter((c) => !p.preferred?.length || p.preferred.includes(c.id) || c.id === p.value)
								.map((c) => (
									<option key={c.id} value={c.id}>
										{c.name}
									</option>
								))}
						</select>
					)}
				</label>
			))}
			{info.overrides.length ? (
				<div className="flex flex-col gap-1" data-instance-overrides="">
					<span className="text-muted-foreground">Overrides</span>
					{info.overrides.map((o) => (
						<div key={o.id} className="flex flex-wrap items-center gap-1" data-override-layer={o.id}>
							<span className="mr-1 truncate">{o.name}</span>
							{o.groups.map((g) => (
								<button
									key={g}
									type="button"
									className="rounded bg-muted px-1 text-[10px]"
									data-override-group={g}
									title={`Reset ${g}`}
									onClick={() => report(components.resetOverrides(o.id, g))}
								>
									{g} ×
								</button>
							))}
						</div>
					))}
				</div>
			) : null}
			<div className="flex flex-wrap gap-1">
				{linked ? (
					<>
						<button type="button" className={btn} data-action="reset" onClick={() => report(components.resetOverrides(info.id))}>
							Reset all
						</button>
						<button type="button" className={btn} data-action="go-to-main" onClick={() => components.goToMainComponent(info.id)}>
							Go to main
						</button>
						<button
							type="button"
							className={btn}
							data-action="push"
							disabled={info.overrides.length === 0}
							onClick={() => report(components.pushOverrides(info.rootId))}
						>
							Push changes
						</button>
					</>
				) : (
					<button type="button" className={btn} data-action="restore" onClick={() => report(components.restoreMainComponent(info.rootId))}>
						Restore main component
					</button>
				)}
				<button
					type="button"
					className={btn}
					data-action="detach"
					disabled={info.nested}
					title={info.nested ? 'Detach the outer instance first' : undefined}
					onClick={() => report(components.detachInstance([info.id]))}
				>
					Detach
				</button>
			</div>
		</div>
	);
}
