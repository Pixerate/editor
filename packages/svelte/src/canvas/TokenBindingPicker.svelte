<script lang="ts">
	import {
		bindCanvasToken,
		getBindableTokenProperties,
		getEffectiveTokenModes,
		getNodeTokenBindings,
		getTokensForProperty,
		type CanvasTokenOptions
	} from '@pixerate/editor/canvas';
	import { resolveToken, type TokenState } from '@pixerate/editor/tokens';
	import type { CanvasNode } from './types.js';

	interface Props {
		state: TokenState;
		nodes: CanvasNode[];
		/** Nodes to bind (the first one decides which properties are listed). */
		selectedIds: readonly string[];
		/** Receives the nodes with the binding applied and resolved. */
		onchange: (nodes: CanvasNode[]) => void;
		options?: CanvasTokenOptions;
		/** Limit to these property keys (in this order). */
		properties?: readonly string[];
		onerror?: (error: Error) => void;
		class?: string;
	}

	let { state, nodes, selectedIds, onchange, options = {}, properties, onerror, class: className = '' }: Props = $props();

	const selected = $derived(nodes.filter((n) => selectedIds.includes(n.id)));
	const first = $derived(selected[0]);
	const rows = $derived.by(() => {
		if (!first) return [];
		const all = getBindableTokenProperties(first as any, options);
		return properties ? properties.map((key) => all.find((p) => p.key === key)).filter((p) => !!p) : all;
	});
	const modes = $derived(first ? getEffectiveTokenModes(first as any, nodes as any, state, options) : {});

	function valueOf(key: string) {
		const ids = new Set(selected.map((n) => getNodeTokenBindings(n as any)[key] ?? ''));
		return ids.size === 1 ? [...ids][0] : '__mixed';
	}

	function change(key: string, id: string) {
		try {
			onchange(bindCanvasToken(nodes as any[], selectedIds, key, id || null, state, options));
		} catch (error) {
			onerror?.(error as Error);
		}
	}
</script>

{#if first}
	<div data-token-binding-picker="" class="flex flex-col gap-1 text-xs text-foreground {className}">
		{#each rows as property (property!.key)}
			{@const value = valueOf(property!.key)}
			{@const resolved = value && value !== '__mixed' ? resolveToken(state, value, modes) : null}
			<label class="flex items-center gap-2" data-token-property={property!.key}>
				<span class="w-28 shrink-0 text-muted-foreground">{property!.label}</span>
				<select
					aria-label="{property!.label} variable"
					class="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-xs"
					{value}
					onchange={(e) => change(property!.key, e.currentTarget.value)}
				>
					{#if value === '__mixed'}<option value="__mixed">Mixed</option>{/if}
					<option value="">None</option>
					{#each getTokensForProperty(state, property!, first as any) as v (v.id)}
						{@const collection = state.collections.find((c) => c.id === v.collectionId)}
						<option value={v.id}>{v.name}{collection && state.collections.length > 1 ? ` (${collection.name})` : ''}</option>
					{/each}
				</select>
				<span class="w-16 shrink-0 truncate text-right text-muted-foreground" data-token-resolved="">
					{#if resolved?.ok}
						{#if property!.type === 'color'}
							<span
								class="inline-block h-3 w-3 rounded border border-border align-middle"
								style:background={String(resolved.value)}
								title={String(resolved.value)}
							></span>
						{:else}
							{String(resolved.value)}
						{/if}
					{:else if resolved}
						<span title={resolved.message}>⚠</span>
					{/if}
				</span>
			</label>
		{/each}
		{#if state.collections.length === 0}
			<p class="text-muted-foreground">No variables yet.</p>
		{/if}
	</div>
{/if}
