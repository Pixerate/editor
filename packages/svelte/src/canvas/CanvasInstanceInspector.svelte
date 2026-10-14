<script lang="ts">
	import { inspectCanvasInstance, listCanvasComponents, type CanvasComponentsController } from '@pixerate/editor/canvas';
	import type { CanvasNode } from './types.js';

	type Actions = Pick<
		CanvasComponentsController<any>,
		'setInstanceProperties' | 'resetOverrides' | 'detachInstance' | 'goToMainComponent' | 'pushOverrides' | 'restoreMainComponent'
	>;

	interface Props {
		nodes: CanvasNode[];
		/** An instance, or a layer inside one; nothing is shown otherwise. */
		nodeId: string | null | undefined;
		components: Actions;
		/** Receives refusals (e.g. a property value that would nest a component in itself). */
		onerror?: (reason: string) => void;
		class?: string;
	}

	let { nodes, nodeId, components, onerror, class: className = '' }: Props = $props();

	const info = $derived(nodeId ? inspectCanvasInstance(nodes as any[], nodeId) : undefined);
	const allComponents = $derived(listCanvasComponents(nodes as any[]).components);
	const btn = 'rounded border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-40';

	function report(result: { ok: boolean; reason?: string } | undefined) {
		if (result && !result.ok && result.reason) onerror?.(result.reason);
	}
	function setProp(name: string, value: unknown) {
		if (info) report(components.setInstanceProperties({ [name]: value }, [info.id]));
	}
</script>

{#if info}
	<div data-instance-inspector="" data-instance-id={info.id} class="flex flex-col gap-2 text-xs text-foreground {className}">
		<div class="flex items-center justify-between gap-2">
			<span class="truncate font-medium" data-instance-main="">
				{info.status === 'linked' ? info.componentName : 'Main component missing'}
			</span>
			{#if info.nested}<span class="text-muted-foreground">Nested</span>{/if}
		</div>
		{#each info.variantOptions as option (option.name)}
			<label class="flex items-center gap-2" data-variant-property={option.name}>
				<span class="w-24 shrink-0 truncate text-muted-foreground">{option.name}</span>
				<select
					aria-label="{option.name} variant"
					class="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-xs"
					value={info.variant[option.name] ?? ''}
					onchange={(e) => setProp(option.name, e.currentTarget.value)}
				>
					{#each option.values as v (v)}
						<option value={v}>{v}</option>
					{/each}
				</select>
			</label>
		{/each}
		{#each info.properties as p (p.name)}
			<label class="flex items-center gap-2" data-component-property={p.name}>
				<span class="w-24 shrink-0 truncate text-muted-foreground">{p.name}</span>
				{#if p.type === 'boolean'}
					<input type="checkbox" aria-label={p.name} checked={p.value === true} onchange={(e) => setProp(p.name, e.currentTarget.checked)} />
				{:else if p.type === 'text'}
					{#key p.value}
						<input
							type="text"
							aria-label={p.name}
							value={String(p.value)}
							class="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-xs"
							onblur={(e) => {
								if (e.currentTarget.value !== p.value) setProp(p.name, e.currentTarget.value);
							}}
							onkeydown={(e) => {
								if (e.key === 'Enter') e.currentTarget.blur();
							}}
						/>
					{/key}
				{:else}
					<select
						aria-label={p.name}
						class="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-xs"
						value={String(p.value)}
						onchange={(e) => setProp(p.name, e.currentTarget.value)}
					>
						{#each allComponents.filter((c) => !p.preferred?.length || p.preferred.includes(c.id) || c.id === p.value) as c (c.id)}
							<option value={c.id}>{c.name}</option>
						{/each}
					</select>
				{/if}
			</label>
		{/each}
		{#if info.overrides.length}
			<div class="flex flex-col gap-1" data-instance-overrides="">
				<span class="text-muted-foreground">Overrides</span>
				{#each info.overrides as o (o.id)}
					<div class="flex flex-wrap items-center gap-1" data-override-layer={o.id}>
						<span class="mr-1 truncate">{o.name}</span>
						{#each o.groups as g (g)}
							<button
								type="button"
								class="rounded bg-muted px-1 text-[10px]"
								data-override-group={g}
								title="Reset {g}"
								onclick={() => report(components.resetOverrides(o.id, g))}>{g} ×</button
							>
						{/each}
					</div>
				{/each}
			</div>
		{/if}
		<div class="flex flex-wrap gap-1">
			{#if info.status === 'linked'}
				<button type="button" class={btn} data-action="reset" onclick={() => report(components.resetOverrides(info!.id))}>Reset all</button>
				<button type="button" class={btn} data-action="go-to-main" onclick={() => components.goToMainComponent(info!.id)}>Go to main</button>
				<button
					type="button"
					class={btn}
					data-action="push"
					disabled={info.overrides.length === 0}
					onclick={() => report(components.pushOverrides(info!.rootId))}>Push changes</button
				>
			{:else}
				<button type="button" class={btn} data-action="restore" onclick={() => report(components.restoreMainComponent(info!.rootId))}
					>Restore main component</button
				>
			{/if}
			<button
				type="button"
				class={btn}
				data-action="detach"
				disabled={info.nested}
				title={info.nested ? 'Detach the outer instance first' : undefined}
				onclick={() => report(components.detachInstance([info!.id]))}>Detach</button
			>
		</div>
	</div>
{/if}
