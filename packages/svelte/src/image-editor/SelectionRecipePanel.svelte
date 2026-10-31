<script lang="ts">
  import type { ImageEditorController, SelectionMask, SelectionRecipeStep } from '@pixerate/editor/image-editor';
  import { describeRecipeStep, recipeStepSetting } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';

  /**
   * Live selection: the steps that made the selection, editable afterwards (each change replays
   * them as one undo step), as the `*_selection_step` tools do. Freeze keeps the selection and drops
   * the steps. Hidden while the selection is frozen or empty.
   */
  interface Props {
    controller: ImageEditorController;
    /** The current selection (`state.selection`), so the panel re-renders with it. */
    selection?: SelectionMask | null;
    class?: string;
  }

  let { controller, selection, class: className = '' }: Props = $props();

  const MODES = ['replace', 'add', 'subtract', 'intersect'] as const;
  const button =
    'px-1.5 py-0.5 rounded border border-border bg-background text-[11px] text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40';
  let tick = $state(0);
  $effect(() => {
    const c = controller;
    return untrack(() => c.subscribe(() => tick++));
  });
  let error = $state<string | null>(null);
  const recipe = $derived.by(() => {
    void tick;
    void selection;
    return controller.getSelectionRecipe();
  });
  const isShape = (step: { op: string }) => ['rect', 'ellipse', 'polygon', 'magic-wand', 'color-range', 'color-range-preset'].includes(step.op);

  function run(p: Promise<unknown> | unknown) {
    error = null;
    Promise.resolve(p).catch((err) => (error = err instanceof Error ? err.message : String(err)));
  }
</script>

{#if recipe.live}
  <div data-testid="selection-recipe" class="flex flex-col gap-1 text-xs {className}">
    <div class="flex items-center justify-between">
      <span class="text-muted-foreground">Selection steps</span>
      <button type="button" class={button} title="Keep the selection, drop its steps" onclick={() => run(controller.freezeSelection())}>Freeze</button>
    </div>
    <ol class="flex flex-col gap-1">
      {#each recipe.steps as step (`${step.index}:${JSON.stringify(step)}`)}
        {@const setting = recipeStepSetting(step)}
        <li data-testid="selection-step" class="flex flex-wrap items-center gap-1">
          <span class="flex-1 min-w-0 truncate text-foreground">{describeRecipeStep(step as SelectionRecipeStep)}</span>
          {#if isShape(step) && step.index > 0}
            <select
              aria-label="Step {step.index + 1} mode"
              value={(step as { mode?: string }).mode ?? 'replace'}
              onchange={(e) => run(controller.editSelectionStep(step.index, { mode: (e.currentTarget as HTMLSelectElement).value }))}
              class="bg-background border border-border rounded px-1 py-0.5 text-foreground"
            >
              {#each MODES as m (m)}
                <option value={m}>{m}</option>
              {/each}
            </select>
          {/if}
          {#if setting}
            <label class="flex items-center gap-1 text-muted-foreground">
              {setting.label}
              <input
                type="number"
                min={setting.min}
                max={setting.max}
                aria-label="Step {step.index + 1} {setting.label}"
                value={setting.value}
                onblur={(e) => {
                  const v = Number((e.currentTarget as HTMLInputElement).value);
                  if (v !== setting.value) run(controller.editSelectionStep(step.index, setting.change(v)));
                }}
                onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
                class="w-12 bg-background border border-border rounded px-1 py-0.5 text-foreground"
              />
            </label>
          {/if}
          <button type="button" class={button} aria-label="Remove step {step.index + 1}" disabled={recipe.steps.length === 1} onclick={() => run(controller.removeSelectionStep(step.index))}>×</button>
        </li>
      {/each}
    </ol>
    {#if error}
      <p role="alert" class="text-destructive">{error}</p>
    {/if}
  </div>
{/if}
