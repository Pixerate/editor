<script lang="ts">
  import {
    DATA_VALIDATION_ERROR_STYLE_OPTIONS,
    DATA_VALIDATION_OPERATOR_OPTIONS,
    DATA_VALIDATION_TYPE_OPTIONS,
    describeDataValidation,
    formatRuleRanges,
    parseRuleRanges,
    type DataValidationErrorStyle,
    type DataValidationOperator,
    type DataValidationType
  } from '@pixerate/editor/spreadsheet';
  import type { createReactiveSpreadsheet } from './spreadsheet.svelte.js';

  interface Props {
    sheetState: ReturnType<typeof createReactiveSpreadsheet>;
    onClose: () => void;
  }

  let { sheetState, onClose }: Props = $props();

  const inputClass = 'w-full rounded border border-border bg-background px-1.5 py-0.5 text-xs text-foreground';
  const buttonClass = 'rounded border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-40';
  const selectionText = () => (sheetState.selectedRange ? formatRuleRanges([sheetState.selectedRange]) : 'A1');

  let rules = $derived(sheetState.document.table?.dataValidations ?? []);
  let type = $state<DataValidationType>('list');
  let operator = $state<DataValidationOperator>('between');
  let formula1 = $state('');
  let formula2 = $state('');
  let errorStyle = $state<DataValidationErrorStyle>('stop');
  let errorMessage = $state('');
  let inputMessage = $state('');
  let ignoreBlank = $state(true);
  let appliesTo = $state(selectionText());
  let ranges = $derived(parseRuleRanges(appliesTo));
  let usesOperator = $derived(type === 'whole' || type === 'decimal' || type === 'date' || type === 'time' || type === 'textLength');
  let needsTwo = $derived(usesOperator && (operator === 'between' || operator === 'notBetween'));
  let circles = $derived.by(() => {
    void sheetState.document;
    return sheetState.getInvalidDataCircles();
  });

  function apply() {
    if (!ranges) return;
    sheetState.addDataValidation({
      ranges,
      type,
      ...(usesOperator ? { operator } : {}),
      ...(formula1 ? { formula1 } : {}),
      ...(needsTwo && formula2 ? { formula2 } : {}),
      errorStyle,
      ...(errorMessage ? { errorMessage } : {}),
      ...(inputMessage ? { inputMessage } : {}),
      ignoreBlank
    });
  }
</script>

<!-- Data validation manager: rules, a form to validate a range, and "circle invalid data". -->
<div
  role="dialog"
  aria-label="Data validation rules"
  tabindex="-1"
  class="fixed right-4 top-16 z-40 flex max-h-[calc(100vh-5rem)] w-80 flex-col overflow-y-auto rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg"
  style="background: var(--popover, var(--background, #fff));"
  onkeydown={(e) => {
    e.stopPropagation();
    if (e.key === 'Escape') onClose();
  }}
  oncontextmenu={(e) => e.stopPropagation()}
>
  <div class="mb-2 flex items-center justify-between">
    <h2 class="text-sm font-semibold">Data validation</h2>
    <button type="button" aria-label="Close" class="px-1 text-muted-foreground hover:text-foreground" onclick={onClose}>✕</button>
  </div>
  <ul class="mb-3 flex flex-col gap-1" aria-label="Validation rules">
    {#if rules.length === 0}
      <li class="text-muted-foreground">No validation on this sheet.</li>
    {/if}
    {#each rules as rule (rule.id)}
      <li data-rule-id={rule.id} class="flex items-center gap-1.5 rounded border border-border px-1.5 py-1">
        <div class="min-w-0 flex-1">
          <div class="truncate" title={describeDataValidation(rule)}>{describeDataValidation(rule)}</div>
          <div class="truncate font-mono text-[10px] text-muted-foreground">{formatRuleRanges(rule.ranges)} · {rule.errorStyle ?? 'stop'}</div>
        </div>
        <button type="button" aria-label="Delete rule" class={buttonClass} onclick={() => sheetState.deleteDataValidation(rule.id)}>✕</button>
      </li>
    {/each}
  </ul>

  <fieldset class="flex flex-col gap-1.5 border-t border-border pt-2">
    <legend class="sr-only">New validation</legend>
    <label class="flex flex-col gap-0.5">
      Allow
      <select aria-label="Allow" class={inputClass} bind:value={type}>
        {#each DATA_VALIDATION_TYPE_OPTIONS as o (o.type)}
          <option value={o.type}>{o.label}</option>
        {/each}
      </select>
    </label>
    {#if usesOperator}
      <select aria-label="Operator" class={inputClass} bind:value={operator}>
        {#each DATA_VALIDATION_OPERATOR_OPTIONS as o (o.operator)}
          <option value={o.operator}>{o.label}</option>
        {/each}
      </select>
    {/if}
    {#if type !== 'any'}
      <input
        aria-label={type === 'list' ? 'Source' : type === 'custom' ? 'Formula' : needsTwo ? 'Minimum' : 'Value'}
        placeholder={type === 'list' ? 'Low,Medium,High or =$H$1:$H$5' : type === 'custom' ? '=A1>0' : 'Value or =formula'}
        class={inputClass}
        bind:value={formula1}
      />
    {/if}
    {#if needsTwo}
      <input aria-label="Maximum" placeholder="Maximum" class={inputClass} bind:value={formula2} />
    {/if}
    <label class="flex items-center gap-1"><input type="checkbox" bind:checked={ignoreBlank} /> Ignore blank</label>
    <input aria-label="Input message" placeholder="Input message (optional)" class={inputClass} bind:value={inputMessage} />
    <select aria-label="Error style" class={inputClass} bind:value={errorStyle}>
      {#each DATA_VALIDATION_ERROR_STYLE_OPTIONS as o (o.style)}
        <option value={o.style}>{o.label}</option>
      {/each}
    </select>
    <input aria-label="Error message" placeholder="Error message (optional)" class={inputClass} bind:value={errorMessage} />
    <label class="flex flex-col gap-0.5">
      Applies to
      <input aria-label="Applies to" class="{inputClass} font-mono" bind:value={appliesTo} />
    </label>
    <div class="flex flex-wrap justify-between gap-2">
      <button type="button" class={buttonClass} onclick={() => (appliesTo = selectionText())}>Use selection</button>
      <button type="button" class={buttonClass} disabled={!ranges} onclick={() => ranges?.forEach((r) => sheetState.clearDataValidation(r))}>Clear</button>
      <button type="button" class={buttonClass} disabled={!ranges} onclick={apply}>Apply</button>
    </div>
    <button type="button" class={buttonClass} aria-pressed={circles} onclick={() => sheetState.setInvalidDataCircles(!circles)}>
      {circles ? 'Clear validation circles' : 'Circle invalid data'}
    </button>
  </fieldset>
</div>
