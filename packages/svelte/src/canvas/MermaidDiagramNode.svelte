<script lang="ts">
	import type { Snippet } from 'svelte';
	import { MERMAID_SHAPE_PAINT, mermaidLabelLines, mermaidNodeMembers, mermaidNodePaint, mermaidShapePaths } from '@pixerate/editor/canvas';

	interface Props {
		id?: string;
		/** Node data as `mermaidToCanvas` produces it (`data.node`, `data.resolvedStyles`). */
		data: { node?: { id: string; label: string; shape: string; data?: Record<string, unknown> }; resolvedStyles?: Record<string, string>; [key: string]: any };
		width?: number;
		height?: number;
		selected?: boolean;
		class?: string;
		/** Rendered over the node, e.g. SvelteFlow `<Handle>`s. */
		children?: Snippet;
		[key: string]: any;
	}

	let { data, width = 160, height = 56, selected = false, class: className = '', children }: Props = $props();

	const node = $derived(data?.node);
	const paths = $derived(node ? mermaidShapePaths(node.shape, width, height) : []);
	const members = $derived(node ? mermaidNodeMembers(node.data) : []);
	const paint = $derived(
		Object.entries(mermaidNodePaint(data?.resolvedStyles, selected))
			.map(([k, v]) => `${k}: ${v}`)
			.join('; ')
	);
</script>

<!--
	Headless Mermaid node: draws the node's shape (flowchart, state, class, ER) as SVG with
	its label, painted from its Mermaid styles. Register it as the `mermaid-node` SvelteFlow
	node type and pass `<Handle>`s as children.
-->
{#if node}
	<div
		class="pixerate-diagram-node {className}"
		data-shape={node.shape}
		data-selected={selected ? 'true' : undefined}
		style="position: relative; width: 100%; height: 100%; {paint}"
	>
		<svg viewBox="0 0 {width} {height}" preserveAspectRatio="none" width="100%" height="100%" style="position: absolute; inset: 0; overflow: visible;" aria-hidden="true">
			{#each paths as path}
				<path d={path.d} style="fill: {MERMAID_SHAPE_PAINT[path.paint].fill}; stroke: {MERMAID_SHAPE_PAINT[path.paint].stroke}; vector-effect: non-scaling-stroke;" />
			{/each}
		</svg>
		<div
			style="position: relative; display: flex; flex-direction: column; align-items: center; justify-content: {members.length ? 'flex-start' : 'center'}; height: 100%; padding: 6px 10px; box-sizing: border-box; font-size: 13px; line-height: 1.3; text-align: center; pointer-events: none;"
		>
			{#each mermaidLabelLines(node.label) as line}
				<span style={members.length ? 'font-weight: 600;' : undefined}>{line}</span>
			{/each}
			{#if members.length}
				<div style="align-self: stretch; margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--pixerate-diagram-node-border); text-align: left; font-size: 12px;">
					{#each members as member}
						<div>{member}</div>
					{/each}
				</div>
			{/if}
		</div>
		{@render children?.()}
	</div>
{/if}
