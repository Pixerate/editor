<script lang="ts">
  import { tick } from 'svelte';
  import { applyFormulaSuggestion, getFormulaHints } from '@pixerate/editor';

  interface Props {
    /** The input being edited (a cell editor or the formula bar). */
    input?: HTMLInputElement | null;
    /** The input's current value. */
    value?: string;
    /** Called with the new value when a suggestion is accepted. */
    onAccept?: (value: string) => void;
    /** Maximum number of function suggestions (default 8). */
    limit?: number;
  }

  let { input = null, value = '', onAccept, limit = 8 }: Props = $props();

  let caret = $state<number | null>(null);
  let focused = $state(false);
  let selected = $state(0);
  let dismissed = $state(false);
  let position = $state<{ top: number; left: number; width: number } | null>(null);

  let hints = $derived(getFormulaHints(value, caret ?? value.length, { limit }));
  let suggestions = $derived(dismissed ? [] : hints.suggestions);
  let selectedIndex = $derived(Math.max(0, Math.min(selected, suggestions.length - 1)));
  let visible = $derived(
    focused && value.trimStart().startsWith('=') && (suggestions.length > 0 || !!hints.activeCall)
  );

  async function accept(index: number) {
    const suggestion = suggestions[index];
    if (!suggestion || !input) return;
    const next = applyFormulaSuggestion(value, caret ?? value.length, suggestion.name);
    caret = next.caret;
    selected = 0;
    onAccept?.(next.value);
    // Wait for the new value to reach the input, then put the caret inside "(".
    await tick();
    if (input.value === next.value) input.setSelectionRange(next.caret, next.caret);
  }

  $effect(() => {
    const el = input;
    if (!el) return;
    const syncCaret = () => (caret = el.selectionStart ?? el.value.length);
    const onInput = () => {
      dismissed = false;
      selected = 0;
      syncCaret();
    };
    const onFocus = () => {
      focused = true;
      syncCaret();
    };
    const onBlur = () => (focused = false);
    // A listener on the input runs before Svelte's delegated handlers (on the
    // root), so stopping propagation keeps these keys away from the grid.
    const onKeyDown = (e: KeyboardEvent) => {
      if (suggestions.length === 0) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        selected = (selectedIndex + step + suggestions.length) % suggestions.length;
      } else if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        accept(selectedIndex);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        dismissed = true;
      }
    };

    el.addEventListener('input', onInput);
    el.addEventListener('keyup', syncCaret);
    el.addEventListener('click', syncCaret);
    el.addEventListener('select', syncCaret);
    el.addEventListener('focus', onFocus);
    el.addEventListener('blur', onBlur);
    el.addEventListener('keydown', onKeyDown);
    if (typeof document !== 'undefined' && document.activeElement === el) onFocus();
    return () => {
      el.removeEventListener('input', onInput);
      el.removeEventListener('keyup', syncCaret);
      el.removeEventListener('click', syncCaret);
      el.removeEventListener('select', syncCaret);
      el.removeEventListener('focus', onFocus);
      el.removeEventListener('blur', onBlur);
      el.removeEventListener('keydown', onKeyDown);
    };
  });

  $effect(() => {
    if (!visible || !input) return;
    void value;
    const rect = input.getBoundingClientRect();
    position = { top: rect.bottom + 2, left: rect.left, width: rect.width };
  });
</script>

{#if visible}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    data-formula-hints=""
    class="rounded-md border border-border bg-popover text-popover-foreground shadow-md text-xs font-sans overflow-hidden"
    style="position: fixed; top: {position?.top ?? 0}px; left: {position?.left ?? 0}px; min-width: {Math.max(260, position?.width ?? 0)}px; max-width: 440px; z-index: 50; visibility: {position ? 'visible' : 'hidden'};"
    onmousedown={(e) => e.preventDefault()}
  >
    {#if hints.activeCall}
      <div data-formula-signature="" class="px-2 py-1.5 border-b border-border bg-muted/30">
        <div class="font-mono">
          {#each hints.activeCall.parts as part, i (i)}
            <span data-active={part.active ? '' : undefined} class={part.active ? 'font-bold text-primary underline' : ''}>{part.text}</span>
          {/each}
        </div>
        <div class="mt-0.5 text-muted-foreground">
          {#if hints.activeCall.argument}
            <span class="font-semibold">{hints.activeCall.argument.name}</span>: {hints.activeCall.argument.description}
          {:else}
            {hints.activeCall.description}
          {/if}
        </div>
      </div>
    {/if}
    {#if suggestions.length > 0}
      <ul role="listbox" aria-label="Formula suggestions" class="max-h-64 overflow-auto m-0 list-none p-0 py-1">
        {#each suggestions as s, i (s.name)}
          <li
            role="option"
            aria-selected={i === selectedIndex}
            class="cursor-pointer px-2 py-1 {i === selectedIndex ? 'bg-primary/10' : 'hover:bg-muted/50'}"
            onmouseenter={() => (selected = i)}
            onmousedown={(e) => {
              // Keep focus in the input so the edit isn't committed by blur.
              e.preventDefault();
              accept(i);
            }}
          >
            <div class="font-mono font-semibold text-foreground">{s.signature}</div>
            <div class="text-muted-foreground truncate">{s.description}</div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
