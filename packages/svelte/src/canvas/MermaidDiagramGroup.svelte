<script lang="ts">
	import type { Snippet } from 'svelte';
	import { mermaidLabelLines } from '@pixerate/editor/canvas';

	interface Props {
		id?: string;
		/** Group data as `mermaidToCanvas` produces it (`data.group`, `data.resolvedStyles`). */
		data: { group?: { id: string; label: string }; resolvedStyles?: Record<string, string>; [key: string]: any };
		selected?: boolean;
		class?: string;
		children?: Snippet;
		[key: string]: any;
	}

	let { data, selected = false, class: className = '', children }: Props = $props();
	const styles = $derived(data?.resolvedStyles ?? {});
</script>

<!-- Headless Mermaid group (subgraph, composite state, namespace): a titled frame. Register as `mermaid-group`. -->
{#if data?.group}
	<div
		class="pixerate-diagram-group {className}"
		data-selected={selected ? 'true' : undefined}
		style="width: 100%; height: 100%; box-sizing: border-box; border-radius: 8px; border: 1px {selected ? 'solid' : 'dashed'} {selected ? 'var(--primary, #2563eb)' : (styles.stroke ?? 'var(--border, #cbd5e1)')}; background: {styles.fill ?? 'var(--muted, rgba(148, 163, 184, 0.08))'}; color: {styles.color ?? 'var(--muted-foreground, #475569)'};"
	>
		<div style="padding: 6px 10px; font-size: 12px; font-weight: 600;">{mermaidLabelLines(data.group.label).join(' ')}</div>
		{@render children?.()}
	</div>
{/if}
