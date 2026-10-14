<script lang="ts">
  import type { SpreadsheetValidationAction, SpreadsheetValidationPrompt } from '@pixerate/editor/spreadsheet';

  interface Props {
    prompt: SpreadsheetValidationPrompt;
    onResolve: (action: SpreadsheetValidationAction) => void;
  }

  let { prompt, onResolve }: Props = $props();
  let firstButton = $state<HTMLButtonElement | null>(null);

  const style = $derived(prompt.result.errorStyle ?? 'stop');
  // Stop: Retry / Cancel; Warning: "Continue?" Yes / No / Cancel; Information: OK / Cancel.
  const buttons = $derived<Array<{ label: string; action: SpreadsheetValidationAction }>>(
    style === 'stop'
      ? [
          { label: 'Retry', action: 'retry' },
          { label: 'Cancel', action: 'cancel' }
        ]
      : style === 'warning'
        ? [
            { label: 'Yes', action: 'accept' },
            { label: 'No', action: 'retry' },
            { label: 'Cancel', action: 'cancel' }
          ]
        : [
            { label: 'OK', action: 'accept' },
            { label: 'Cancel', action: 'cancel' }
          ]
  );
  const icon = $derived(style === 'stop' ? '⛔' : style === 'warning' ? '⚠' : 'ℹ');

  $effect(() => {
    void prompt;
    firstButton?.focus();
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-[60] flex items-center justify-center bg-black/30"
  onmousedown={(e) => e.preventDefault()}
  onkeydown={(e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onResolve('cancel');
    }
  }}
>
  <div
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="spreadsheet-validation-title"
    aria-describedby="spreadsheet-validation-message"
    data-error-style={style}
    tabindex="-1"
    class="w-[22rem] max-w-[calc(100vw-2rem)] rounded-md border border-border bg-popover p-4 text-xs text-popover-foreground shadow-xl"
    style="background: var(--popover, var(--background, #fff));"
  >
    <div class="flex items-start gap-3">
      <span aria-hidden="true" class="text-lg leading-none">{icon}</span>
      <div class="min-w-0 flex-1">
        <h2 id="spreadsheet-validation-title" class="mb-1 text-sm font-semibold">{prompt.result.title}</h2>
        <p id="spreadsheet-validation-message" class="whitespace-pre-wrap">{prompt.result.message}</p>
        {#if style === 'warning'}
          <p class="mt-2">Continue?</p>
        {/if}
      </div>
    </div>
    <div class="mt-4 flex justify-end gap-2">
      {#each buttons as button, i (button.action)}
        {#if i === 0}
          <button
            bind:this={firstButton}
            type="button"
            data-action={button.action}
            class="rounded border border-border px-3 py-1 bg-primary text-primary-foreground"
            onclick={() => onResolve(button.action)}>{button.label}</button
          >
        {:else}
          <button
            type="button"
            data-action={button.action}
            class="rounded border border-border px-3 py-1 hover:bg-muted"
            onclick={() => onResolve(button.action)}>{button.label}</button
          >
        {/if}
      {/each}
    </div>
  </div>
</div>
