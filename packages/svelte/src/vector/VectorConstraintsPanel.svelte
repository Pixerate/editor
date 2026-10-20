<script lang="ts">
  import { getVectorConstraintPanel, type VectorConstraintAction, type VectorEditorController } from '@pixerate/editor/vector';
  import { vectorStateOf } from './subscribe.svelte.js';

  /**
   * Constraints: the degrees of freedom left, the constraints the selection allows (pick anchors
   * with the direct tool, or round paths), Auto Constrain, the constraints of the selection with
   * their values, and the named parameters. Each change is one undo step.
   */
  interface Props {
    controller: VectorEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();

  const store = vectorStateOf(() => controller);
  const view = $derived(store.current);
  const panel = $derived(getVectorConstraintPanel(view));
  const shown = $derived(panel.actions.length > 0 || panel.constraints.length > 0 || !!view.document.constraints?.length || view.tool === 'direct');
  let error: string | null = $state(null);
  let paramName = $state('');
  let paramValue = $state('');
  const report = (r: { ok: boolean; message?: string }) => {
    error = r.ok ? null : (r.message ?? null);
  };
  const add = (a: VectorConstraintAction) => report(controller.addConstraint({ kind: a.kind, refs: a.refs }));
  function addParameter(e: SubmitEvent) {
    e.preventDefault();
    if (!paramName.trim()) return;
    const r = controller.setConstraintValue(paramName.trim(), paramValue);
    report(r);
    if (r.ok) {
      paramName = '';
      paramValue = '';
    }
  }
  const blurOnEnter = (e: KeyboardEvent) => {
    if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
  };

  const buttonClass =
    'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40';
  const inputClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
  const labelClass = 'w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground';
</script>

{#if shown}
  <div class="space-y-2 {className}" data-vector-constraints-panel="" data-dof-status={panel.dof.status} aria-label="Constraints">
    <div class="flex items-center gap-1">
      <span class={labelClass}>Constraints</span>
      <span class="flex-1 truncate text-[11px] text-muted-foreground" data-vector-dof="">{panel.dof.message}</span>
      <button type="button" class={buttonClass} title="Auto Constrain: add what the selection (or the drawing) nearly satisfies" onclick={() => report(controller.autoConstrain())}>Auto</button>
    </div>
    {#if panel.actions.length}
      <div class="flex flex-wrap gap-1" role="group" aria-label="Add constraint">
        {#each panel.actions as a (a.kind)}
          <button type="button" class={buttonClass} data-vector-constraint-action={a.kind} title="Add {a.label}" onclick={() => add(a)}>{a.label}</button>
        {/each}
      </div>
    {/if}
    {#if panel.constraints.length}
      <ul class="space-y-1">
        {#each panel.constraints as c (c.id)}
          <li data-vector-constraint={c.id} data-satisfied={c.satisfied && !c.conflict ? 'true' : 'false'} class="flex items-center gap-1 text-xs text-foreground">
            <span class="min-w-0 flex-1 truncate {c.conflict || !c.satisfied ? 'text-destructive' : ''}">{c.label}{c.name ? ` ${c.name}` : ''}</span>
            {#if c.value !== undefined}
              {#key `${c.id}:${c.value}`}
                <input
                  aria-label="Value of {c.name ?? c.id}"
                  class="{inputClass} w-16 flex-none"
                  value={c.value}
                  onkeydown={blurOnEnter}
                  onblur={(e) => {
                    const v = (e.currentTarget as HTMLInputElement).value;
                    if (v.trim() !== c.value) report(controller.setConstraintValue(c.id, v));
                  }}
                />
              {/key}
            {/if}
            <button type="button" class={buttonClass} aria-label="Remove {c.label} constraint" onclick={() => report(controller.removeConstraints([c.id]))}>×</button>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="space-y-1" aria-label="Parameters">
      {#each panel.parameters as p (p.name)}
        <div class="flex items-center gap-1 text-xs">
          <span class="w-12 truncate font-mono">{p.name}</span>
          {#key `${p.name}:${p.value}`}
            <input
              aria-label="Parameter {p.name}"
              class={inputClass}
              value={p.value}
              onkeydown={blurOnEnter}
              onblur={(e) => {
                const v = (e.currentTarget as HTMLInputElement).value;
                if (v.trim() !== p.value) report(controller.setConstraintValue(p.name, v));
              }}
            />
          {/key}
          <span class="w-10 text-right text-muted-foreground">{p.result === null ? '!' : Math.round(p.result * 100) / 100}</span>
        </div>
      {/each}
      <form class="flex items-center gap-1" onsubmit={addParameter}>
        <input aria-label="New parameter name" placeholder="name" class="{inputClass} w-12 flex-none" bind:value={paramName} />
        <input aria-label="New parameter value" placeholder="value" class={inputClass} bind:value={paramValue} />
        <button type="submit" class={buttonClass} aria-label="Add parameter">+</button>
      </form>
    </div>
    {#if error}<p class="text-[11px] text-destructive">{error}</p>{/if}
  </div>
{/if}
