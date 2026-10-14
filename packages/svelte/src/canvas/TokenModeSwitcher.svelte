<script lang="ts">
	import {
		getEffectiveTokenModes,
		getNodeTokenModes,
		setCanvasTokenMode,
		type CanvasTokenOptions
	} from '@pixerate/editor/canvas';
	import { getCurrentMode, type TokenState } from '@pixerate/editor/tokens';
	import type { CanvasNode } from './types.js';

	interface Props {
		state: TokenState;
		nodes: CanvasNode[];
		/** Frames / groups whose explicit mode is set (the first one's choice is shown). */
		nodeIds: readonly string[];
		onchange: (nodes: CanvasNode[]) => void;
		options?: CanvasTokenOptions;
		/** Show collections with a single mode too (default `false`). */
		showSingleMode?: boolean;
		class?: string;
	}

	let { state, nodes, nodeIds, onchange, options = {}, showSingleMode = false, class: className = '' }: Props = $props();

	const first = $derived(nodes.find((n) => nodeIds.includes(n.id)));
	const own = $derived(first ? getNodeTokenModes(first as any) : {});
	const inherited = $derived.by(() => {
		const parent = first?.parentId ? nodes.find((n) => n.id === first!.parentId) : undefined;
		return parent ? getEffectiveTokenModes(parent as any, nodes as any, state, options) : { ...options.modes };
	});
	const collections = $derived(state.collections.filter((c) => showSingleMode || c.modes.length > 1));
</script>

{#if first}
	<div data-token-mode-switcher="" class="flex flex-col gap-1 text-xs text-foreground {className}">
		{#each collections as collection (collection.id)}
			{@const explicit = collection.modes.some((m) => m.id === own[collection.id]) ? own[collection.id] : ''}
			<label class="flex items-center gap-2" data-token-collection={collection.id}>
				<span class="w-28 shrink-0 truncate text-muted-foreground">{collection.name}</span>
				<select
					aria-label="{collection.name} mode"
					class="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-xs"
					value={explicit}
					onchange={(e) =>
						onchange(setCanvasTokenMode(nodes as any[], nodeIds, collection.id, e.currentTarget.value || null, state, options))}
				>
					<option value="">Auto ({getCurrentMode(collection, inherited).name})</option>
					{#each collection.modes as m (m.id)}
						<option value={m.id}>{m.name}</option>
					{/each}
				</select>
			</label>
		{/each}
	</div>
{/if}
