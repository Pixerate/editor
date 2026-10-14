<script lang="ts" module>
  let nextId = 0;
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import {
    getGenerationControls,
    getReferenceSlots,
    getRequestValue,
    parseControlValue,
    planGenerationRequest,
    removeReference,
    setRequestValue,
    type GenerationControl,
    type GenerationPlan,
    type GenerationReference,
    type GenerationRequest,
    type ModelCapabilities,
    type PlanStrategy,
    type ReferenceRole
  } from '@pixerate/editor/generation';

  interface Props {
    capabilities: ModelCapabilities;
    /** The request being edited (controlled). */
    value: GenerationRequest;
    onchange: (next: GenerationRequest) => void;
    /** A plan computed elsewhere; otherwise one is computed with `strategy`. */
    plan?: GenerationPlan;
    /** Strategy for the built-in plan (default `nearest`). */
    strategy?: PlanStrategy;
    /** List plan adjustments and errors under the controls (default `true`). */
    showAdjustments?: boolean;
    /** Shows an "Add" button per reference role; you pick the asset and call `onchange`. */
    onaddreference?: (role: ReferenceRole) => void;
    /** Custom rendering of a reference chip (default: its id). */
    reference?: Snippet<[GenerationReference]>;
    class?: string;
  }

  let {
    capabilities,
    value,
    onchange,
    plan: planProp,
    strategy,
    showAdjustments = true,
    onaddreference,
    reference,
    class: className = ''
  }: Props = $props();

  const baseId = `generation-settings-${++nextId}`;
  const controls = $derived(getGenerationControls(capabilities));
  const plan = $derived(planProp ?? planGenerationRequest(value, capabilities, { strategy }));
  const slots = $derived(getReferenceSlots(capabilities, value));

  const inputClass =
    'w-full rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring';

  const shown = (control: GenerationControl) => getRequestValue(value, control.key) ?? control.defaultValue;
  const update = (control: GenerationControl, raw: string | boolean) =>
    onchange(setRequestValue(value, control.key, parseControlValue(control, raw)));
</script>

<!-- Headless-styled settings form generated from a model's capabilities. -->
<div class="flex flex-col gap-3 text-sm {className}" data-generation-settings="" data-model={capabilities.id}>
  {#each controls as control (control.key)}
    {@const id = `${baseId}-${control.key}`}
    {@const current = shown(control)}
    <div class="flex flex-col gap-1" data-control={control.key}>
      <label for={id} class="text-xs font-medium text-muted-foreground" title={control.description}>{control.label}</label>
      {#if control.kind === 'checkbox'}
        <input
          {id}
          type="checkbox"
          data-field={control.key}
          checked={Boolean(current)}
          onchange={(e) => update(control, e.currentTarget.checked)}
        />
      {:else if control.kind === 'select'}
        <select
          {id}
          data-field={control.key}
          class={inputClass}
          value={current === undefined ? '' : String(current)}
          onchange={(e) => update(control, e.currentTarget.value)}
        >
          {#if current === undefined}<option value="">Default</option>{/if}
          {#each control.options ?? [] as option (option.value)}
            <option value={String(option.value)}>{option.label}</option>
          {/each}
        </select>
      {:else if control.kind === 'textarea'}
        <textarea
          {id}
          data-field={control.key}
          class={inputClass}
          rows="2"
          maxlength={control.maxLength}
          value={typeof getRequestValue(value, control.key) === 'string' ? (getRequestValue(value, control.key) as string) : ''}
          oninput={(e) => update(control, e.currentTarget.value)}
        ></textarea>
      {:else}
        <div class="flex items-center gap-2">
          <input
            {id}
            type={control.kind === 'range' ? 'range' : 'number'}
            data-field={control.key}
            class={control.kind === 'range' ? 'flex-1' : inputClass}
            min={control.min}
            max={control.max}
            step={control.step ?? 'any'}
            value={typeof current === 'number' ? current : control.kind === 'range' ? (control.min ?? 0) : ''}
            oninput={(e) => update(control, e.currentTarget.value)}
          />
          {#if control.kind === 'range'}
            <span class="w-10 text-right tabular-nums text-muted-foreground" data-field-value="">
              {typeof current === 'number' ? current : '–'}
            </span>
          {/if}
        </div>
      {/if}
    </div>
  {/each}

  {#each slots as slot (slot.role)}
    <fieldset class="flex flex-col gap-1" data-reference-role={slot.role}>
      <legend class="text-xs font-medium text-muted-foreground" title={slot.description}>
        {slot.label}
        <span class="tabular-nums" data-reference-count="">({slot.references.length}/{slot.max})</span>
        {#if slot.min > 0}<span class="text-destructive"> *</span>{/if}
      </legend>
      <ul class="flex flex-wrap gap-1">
        {#each slot.references as ref (ref.id)}
          <li class="flex items-center gap-1 rounded border border-border px-1.5 py-0.5" data-reference-id={ref.id}>
            {#if reference}{@render reference(ref)}{:else}<span class="max-w-[10rem] truncate">{ref.id}</span>{/if}
            <button
              type="button"
              aria-label="Remove {slot.label} {ref.id}"
              class="text-muted-foreground hover:text-foreground"
              onclick={() => onchange(removeReference(value, slot.role, ref.id))}>×</button
            >
          </li>
        {/each}
        {#if onaddreference && slot.canAdd}
          <li>
            <button
              type="button"
              class="rounded border border-dashed border-border px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
              onclick={() => onaddreference(slot.role)}>Add</button
            >
          </li>
        {/if}
      </ul>
    </fieldset>
  {/each}

  {#if showAdjustments && plan.adjustments.length > 0}
    <ul role="status" class="flex flex-col gap-0.5 text-xs text-muted-foreground" data-generation-adjustments="">
      {#each plan.adjustments as adjustment, index (index)}
        <li data-adjustment-field={adjustment.field} data-adjustment-kind={adjustment.kind}>{adjustment.reason}</li>
      {/each}
    </ul>
  {/if}
  {#if showAdjustments && plan.errors.length > 0}
    <ul role="alert" class="flex flex-col gap-0.5 text-xs text-destructive" data-generation-errors="">
      {#each plan.errors as error, index (index)}
        <li data-error-field={error.field}>{error.message}</li>
      {/each}
    </ul>
  {/if}
</div>
