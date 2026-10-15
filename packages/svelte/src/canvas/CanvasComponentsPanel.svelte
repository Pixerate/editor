<script lang="ts">
	import { CANVAS_COMPONENT_DRAG_TYPE, listCanvasComponents, type CanvasComponentsController } from '@pixerate/editor/canvas';
	import type { CanvasNode } from './types.js';

	/** The variant-editing actions the panel runs (a components controller or rune satisfies it). */
	type Actions = Pick<
		CanvasComponentsController<any>,
		'addVariant' | 'removeVariant' | 'setVariantProperties' | 'renameVariantProperty' | 'renameVariantValue'
	>;

	interface Props {
		nodes: CanvasNode[];
		/** Inserts an instance of a component (or a set's default variant); called on click. */
		oninsert: (componentId: string) => void;
		/**
		 * Variant editing: with it, sets get "+ Variant" and a properties editor (rename properties
		 * and values inline), and variants a menu (also on right click) to edit, duplicate or remove them.
		 */
		components?: Actions;
		/** Receives refusals (e.g. a duplicate variant combination). */
		onerror?: (reason: string) => void;
		/** Show the search field (default `true`). */
		search?: boolean;
		class?: string;
	}

	let { nodes, oninsert, components, onerror, search = true, class: className = '' }: Props = $props();

	let query = $state('');
	let propsOpen = $state<string | null>(null);
	let menuFor = $state<string | null>(null);
	let editing = $state<string | null>(null);
	const listed = $derived(listCanvasComponents(nodes as any[]));
	const q = $derived(query.trim().toLowerCase());
	const match = (name: string) => !q || name.toLowerCase().includes(q);
	const lone = $derived(listed.components.filter((c) => !c.setId && match(c.name)));
	const sets = $derived(listed.sets.filter((s) => match(s.name) || s.variants.some((v) => match(v.name))));
	const small = 'shrink-0 rounded px-1 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40';
	const menuItem = 'rounded px-2 py-0.5 text-left hover:bg-muted disabled:opacity-40';
	const field = 'min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-xs';

	function report(result: { ok: boolean; reason?: string } | undefined): boolean {
		if (result && !result.ok && result.reason) onerror?.(result.reason);
		return !!result?.ok;
	}

	function dragStart(event: DragEvent, id: string, name: string) {
		if (!event.dataTransfer) return;
		event.dataTransfer.setData(CANVAS_COMPONENT_DRAG_TYPE, id);
		event.dataTransfer.setData('text/plain', name);
		event.dataTransfer.effectAllowed = 'copy';
	}

	/** Commits an inline rename on blur when the value changed (an empty value reverts). */
	function commitInline(event: FocusEvent, value: string, apply: (next: string) => void) {
		const input = event.currentTarget as HTMLInputElement;
		const next = input.value.trim();
		if (next && next !== value) apply(next);
		else input.value = value;
	}
	function inlineKey(event: KeyboardEvent, value: string) {
		const input = event.currentTarget as HTMLInputElement;
		if (event.key === 'Enter') input.blur();
		if (event.key === 'Escape') {
			input.value = value;
			input.blur();
		}
	}

	function saveVariant(event: SubmitEvent, id: string) {
		event.preventDefault();
		if (!components) return;
		const values: Record<string, string> = {};
		for (const input of (event.currentTarget as HTMLFormElement).querySelectorAll<HTMLInputElement>('input[data-variant-value]')) {
			values[input.dataset.variantValue!] = input.value;
		}
		if (report(components.setVariantProperties(values, id))) editing = null;
	}
</script>

{#snippet item(id: string, name: string, count: number, kind: string, oncontextmenu?: (e: MouseEvent) => void)}
	<button
		type="button"
		draggable="true"
		data-component-id={id}
		data-kind={kind}
		class="flex w-full min-w-0 items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted"
		title="Insert an instance of {name}"
		onclick={() => oninsert(id)}
		{oncontextmenu}
		ondragstart={(e) => dragStart(e, id, name)}
	>
		<span class="truncate"><span aria-hidden="true" class="mr-1 text-muted-foreground">◇</span>{name}</span>
		<span class="text-[10px] text-muted-foreground" data-instance-count="">{count}</span>
	</button>
{/snippet}

{#snippet inline(value: string, label: string, apply: (next: string) => void)}
	{#key value}
		<input
			type="text"
			aria-label={label}
			{value}
			class={field}
			onblur={(e) => commitInline(e, value, apply)}
			onkeydown={(e) => inlineKey(e, value)}
		/>
	{/key}
{/snippet}

<div data-components-panel="" class="flex flex-col gap-1 text-xs text-foreground {className}">
	{#if search}
		<input
			type="search"
			aria-label="Search components"
			placeholder="Search components"
			class="rounded border border-border bg-background px-2 py-1 text-xs"
			oninput={(e) => (query = e.currentTarget.value)}
		/>
	{/if}
	{#each sets as set (set.id)}
		<div data-component-set={set.id} class="flex flex-col">
			<div class="flex items-center gap-1">
				{@render item(set.id, set.name, set.variants.reduce((sum, v) => sum + v.instanceCount, 0), 'set')}
				{#if components}
					<button
						type="button"
						class={small}
						data-action="add-variant"
						aria-label="Add a variant to {set.name}"
						title="Add a variant (duplicates the default variant)"
						onclick={() => report(components.addVariant(set.id))}>+&nbsp;Variant</button
					>
					<button
						type="button"
						class={small}
						data-action="variant-properties"
						aria-expanded={propsOpen === set.id}
						aria-label="Edit the variant properties of {set.name}"
						title="Rename variant properties and values"
						onclick={() => (propsOpen = propsOpen === set.id ? null : set.id)}>⚙</button
					>
				{/if}
			</div>
			{#if components && propsOpen === set.id}
				<div data-variant-properties={set.id} class="ml-3 flex flex-col gap-1 border-l border-border py-1 pl-2">
					{#each set.options as option (option.name)}
						<div data-variant-option={option.name} class="flex flex-col gap-0.5">
							{@render inline(option.name, `Rename property ${option.name}`, (next) =>
								report(components.renameVariantProperty(option.name, next, set.id))
							)}
							<div class="ml-2 flex flex-wrap gap-1">
								{#each option.values as value (value)}
									{@render inline(value, `Rename ${option.name} value ${value}`, (next) =>
										report(components.renameVariantValue(option.name, value, next, set.id))
									)}
								{/each}
							</div>
						</div>
					{/each}
				</div>
			{/if}
			<div class="ml-3 flex flex-col border-l border-border pl-1">
				{#each set.variants as v (v.id)}
					<div data-variant-row={v.id} class="flex flex-col">
						<div class="flex items-center gap-1">
							{@render item(
								v.id,
								v.name,
								v.instanceCount,
								'variant',
								components
									? (e: MouseEvent) => {
											e.preventDefault();
											menuFor = v.id;
										}
									: undefined
							)}
							{#if components}
								<button
									type="button"
									class={small}
									data-action="variant-menu"
									aria-haspopup="menu"
									aria-expanded={menuFor === v.id}
									aria-label="Variant actions for {v.name}"
									onclick={() => (menuFor = menuFor === v.id ? null : v.id)}>⋯</button
								>
							{/if}
						</div>
						{#if components && menuFor === v.id}
							<div role="menu" data-variant-menu={v.id} class="ml-2 flex flex-col rounded border border-border bg-background p-1 shadow">
								<button
									type="button"
									role="menuitem"
									class={menuItem}
									data-action="edit-variant"
									onclick={() => {
										editing = v.id;
										menuFor = null;
									}}>Edit values…</button
								>
								<button
									type="button"
									role="menuitem"
									class={menuItem}
									data-action="duplicate-variant"
									onclick={() => {
										menuFor = null;
										report(components.addVariant(set.id, { from: v.id }));
									}}>Duplicate</button
								>
								<button
									type="button"
									role="menuitem"
									class={menuItem}
									data-action="remove-variant"
									disabled={set.variants.length < 2}
									title={set.variants.length < 2 ? 'A component set needs at least one variant.' : 'Its instances switch to the closest variant'}
									onclick={() => {
										menuFor = null;
										report(components.removeVariant(v.id));
									}}>Remove variant</button
								>
							</div>
						{/if}
						{#if components && editing === v.id}
							<form data-variant-editor={v.id} class="ml-2 flex flex-col gap-1 py-1" onsubmit={(e) => saveVariant(e, v.id)}>
								{#each set.options as option (option.name)}
									<label class="flex items-center gap-2">
										<span class="w-16 shrink-0 truncate text-muted-foreground">{option.name}</span>
										<input type="text" data-variant-value={option.name} aria-label="{option.name} value" value={v.variant?.[option.name] ?? ''} class={field} />
									</label>
								{/each}
								<div class="flex gap-1">
									<button type="submit" class="rounded border border-border px-2 py-0.5 hover:bg-muted" data-action="save-variant">Save</button>
									<button type="button" class="rounded px-2 py-0.5 hover:bg-muted" data-action="cancel-variant" onclick={() => (editing = null)}
										>Cancel</button
									>
								</div>
							</form>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	{/each}
	{#each lone as c (c.id)}
		{@render item(c.id, c.name, c.instanceCount, 'component')}
	{/each}
	{#if listed.components.length === 0}
		<p class="text-muted-foreground">No components yet. Select a frame and choose Create Component.</p>
	{/if}
</div>
