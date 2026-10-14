<script lang="ts">
  import {
    CONDITIONAL_FORMAT_ICON_SETS,
    CONDITIONAL_FORMAT_PRESETS,
    CONDITIONAL_FORMAT_STYLE_PRESETS,
    CONDITIONAL_FORMAT_TIME_PERIODS,
    createConditionalFormatRule,
    describeConditionalFormat,
    formatRuleRanges,
    getConditionalFormatCss,
    conditionalFormatStyleString,
    parseRuleRanges,
    type ConditionalFormatIconSet,
    type ConditionalFormatPresetKind,
    type ConditionalFormatRule,
    type ConditionalFormatTimePeriod
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

  let rules = $derived(sheetState.document.table?.conditionalFormats ?? []);
  let kind = $state<ConditionalFormatPresetKind>('greaterThan');
  let appliesTo = $state(selectionText());
  let value = $state('');
  let value2 = $state('');
  let text = $state('');
  let formula = $state('=');
  let rank = $state('10');
  let period = $state<ConditionalFormatTimePeriod>('today');
  let iconSet = $state<ConditionalFormatIconSet>('3TrafficLights1');
  let color = $state('#638ec6');
  let styleId = $state(CONDITIONAL_FORMAT_STYLE_PRESETS[0].id);
  let preset = $derived(CONDITIONAL_FORMAT_PRESETS.find((p) => p.kind === kind)!);
  let ranges = $derived(parseRuleRanges(appliesTo));

  function add() {
    if (!ranges) return;
    sheetState.addConditionalFormat(
      createConditionalFormatRule({
        kind,
        ranges,
        value,
        value2,
        text,
        formula,
        rank: Number(rank) || 10,
        period,
        iconSet,
        color,
        style: CONDITIONAL_FORMAT_STYLE_PRESETS.find((s) => s.id === styleId)?.style
      })
    );
  }

  /** Swatch showing a rule's look (fill, font colour, bold) or its kind. */
  function swatchStyle(rule: ConditionalFormatRule): string {
    if (rule.type === 'colorScale') return `background: linear-gradient(90deg, ${rule.stops.map((s) => s.color).join(', ')});`;
    if (rule.type === 'dataBar') return `background: ${rule.color ?? '#638ec6'};`;
    if (rule.type === 'iconSet') return '';
    return conditionalFormatStyleString(getConditionalFormatCss(rule.style));
  }
</script>

<!-- Conditional formatting manager: rules in priority order and a form to add one. -->
<div
  role="dialog"
  aria-label="Conditional formatting rules"
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
    <h2 class="text-sm font-semibold">Conditional formatting</h2>
    <button type="button" aria-label="Close" class="px-1 text-muted-foreground hover:text-foreground" onclick={onClose}>✕</button>
  </div>
  <ol class="mb-3 flex flex-col gap-1" aria-label="Rules in priority order">
    {#if rules.length === 0}
      <li class="text-muted-foreground">No rules on this sheet.</li>
    {/if}
    {#each rules as rule, i (rule.id)}
      <li data-rule-id={rule.id} class="flex items-center gap-1.5 rounded border border-border px-1.5 py-1">
        <span aria-hidden="true" class="inline-flex h-4 w-6 shrink-0 items-center justify-center rounded-sm border border-border" style={swatchStyle(rule)}
          >{rule.type === 'iconSet' ? '●' : rule.type === 'colorScale' || rule.type === 'dataBar' ? '' : 'Aa'}</span
        >
        <div class="min-w-0 flex-1">
          <div class="truncate" title={describeConditionalFormat(rule)}>{describeConditionalFormat(rule)}</div>
          <div class="truncate font-mono text-[10px] text-muted-foreground">{formatRuleRanges(rule.ranges)}</div>
        </div>
        <label class="flex items-center gap-0.5 text-[10px]" title="Stop if true">
          <input
            type="checkbox"
            aria-label="Stop if true"
            checked={!!rule.stopIfTrue}
            onchange={(e) => sheetState.updateConditionalFormat(rule.id, { stopIfTrue: (e.currentTarget as HTMLInputElement).checked })}
          />
          Stop
        </label>
        <button type="button" aria-label="Move up" class={buttonClass} disabled={i === 0} onclick={() => sheetState.moveConditionalFormat(rule.id, { by: -1 })}>▲</button>
        <button
          type="button"
          aria-label="Move down"
          class={buttonClass}
          disabled={i === rules.length - 1}
          onclick={() => sheetState.moveConditionalFormat(rule.id, { by: 1 })}>▼</button
        >
        <button type="button" aria-label="Delete rule" class={buttonClass} onclick={() => sheetState.deleteConditionalFormat(rule.id)}>✕</button>
      </li>
    {/each}
  </ol>

  <fieldset class="flex flex-col gap-1.5 border-t border-border pt-2">
    <legend class="sr-only">New rule</legend>
    <label class="flex flex-col gap-0.5">
      Format cells
      <select aria-label="Rule type" class={inputClass} bind:value={kind}>
        {#each CONDITIONAL_FORMAT_PRESETS as p (p.kind)}
          <option value={p.kind}>{p.label}</option>
        {/each}
      </select>
    </label>
    {#if preset.fields.includes('value')}
      <input aria-label="Value" placeholder="Value or =formula" class={inputClass} bind:value />
    {/if}
    {#if preset.fields.includes('value2')}
      <input aria-label="Second value" placeholder="and" class={inputClass} bind:value={value2} />
    {/if}
    {#if preset.fields.includes('text')}
      <input aria-label="Text" placeholder="Text" class={inputClass} bind:value={text} />
    {/if}
    {#if preset.fields.includes('formula')}
      <input aria-label="Formula" placeholder="=$A1>10" class={inputClass} bind:value={formula} />
    {/if}
    {#if preset.fields.includes('rank')}
      <input aria-label="Rank" type="number" min="1" class={inputClass} bind:value={rank} />
    {/if}
    {#if preset.fields.includes('period')}
      <select aria-label="Period" class={inputClass} bind:value={period}>
        {#each CONDITIONAL_FORMAT_TIME_PERIODS as p (p.period)}
          <option value={p.period}>{p.label}</option>
        {/each}
      </select>
    {/if}
    {#if preset.fields.includes('iconSet')}
      <select aria-label="Icon set" class={inputClass} bind:value={iconSet}>
        {#each CONDITIONAL_FORMAT_ICON_SETS as set (set)}
          <option value={set}>{set}</option>
        {/each}
      </select>
    {/if}
    {#if preset.fields.includes('color')}
      <input aria-label="Bar colour" type="color" class="h-6 w-12" bind:value={color} />
    {/if}
    {#if preset.usesStyle}
      <select aria-label="Style" class={inputClass} bind:value={styleId}>
        {#each CONDITIONAL_FORMAT_STYLE_PRESETS as s (s.id)}
          <option value={s.id}>{s.label}</option>
        {/each}
      </select>
    {/if}
    <label class="flex flex-col gap-0.5">
      Applies to
      <input aria-label="Applies to" class="{inputClass} font-mono" bind:value={appliesTo} />
    </label>
    <div class="flex justify-between gap-2">
      <button type="button" class={buttonClass} onclick={() => (appliesTo = selectionText())}>Use selection</button>
      <button type="button" class={buttonClass} disabled={!ranges} onclick={add}>Add rule</button>
    </div>
  </fieldset>
</div>
