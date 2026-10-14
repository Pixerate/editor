<script lang="ts">
	import { CANVAS_COMPONENT_DRAG_TYPE, listCanvasComponents } from '@pixerate/editor/canvas';
	import type { CanvasNode } from './types.js';

	interface Props {
		nodes: CanvasNode[];
		/** Inserts an instance of a component (or a set's default variant); called on click. */
		oninsert: (componentId: string) => void;
		/** Show the search field (default `true`). */
		search?: boolean;
		class?: string;
	}

	let { nodes, oninsert, search = true, class: className = '' }: Props = $props();

	let query = $state('');
	const listed = $derived(listCanvasComponents(nodes as any[]));
	const q = $derived(query.trim().toLowerCase());
	const match = (name: string) => !q || name.toLowerCase().includes(q);
	const lone = $derived(listed.components.filter((c) => !c.setId && match(c.name)));
	const sets = $derived(listed.sets.filter((s) => match(s.name) || s.variants.some((v) => match(v.name))));

	function dragStart(event: DragEvent, id: string, name: string) {
		if (!event.dataTransfer) return;
		event.dataTransfer.setData(CANVAS_COMPONENT_DRAG_TYPE, id);
		event.dataTransfer.setData('text/plain', name);
		event.dataTransfer.effectAllowed = 'copy';
	}
</script>

{#snippet item(id: string, name: string, count: number, kind: string)}
	<button
		type="button"
		draggable="true"
		data-component-id={id}
		data-kind={kind}
		class="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted"
		title="Insert an instance of {name}"
		onclick={() => oninsert(id)}
		ondragstart={(e) => dragStart(e, id, name)}
	>
		<span class="truncate"><span aria-hidden="true" class="mr-1 text-muted-foreground">◇</span>{name}</span>
		<span class="text-[10px] text-muted-foreground" data-instance-count="">{count}</span>
	</button>
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
			{@render item(set.id, set.name, set.variants.reduce((sum, v) => sum + v.instanceCount, 0), 'set')}
			<div class="ml-3 flex flex-col border-l border-border pl-1">
				{#each set.variants as v (v.id)}
					{@render item(v.id, v.name, v.instanceCount, 'variant')}
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
