<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { parameterInputClass, parameterInputStyle } from './styles.js';

  interface Props extends Omit<HTMLInputAttributes, 'value' | 'class'> {
    value: string;
    /** Called with the text and the element (e.g. to show the stored value again after a refused edit). */
    oncommit: (value: string, input: HTMLInputElement | HTMLTextAreaElement) => void;
    /** A textarea that commits on blur or Mod+Enter. */
    multiline?: boolean;
    class?: string;
  }

  let { value, oncommit, multiline = false, class: className = parameterInputClass, onkeydown, onchange, style, ...rest }: Props = $props();

  let lastCommitted = $state('');

  $effect(() => {
    lastCommitted = value;
  });

  function commit(el: HTMLInputElement | HTMLTextAreaElement) {
    if (el.value === lastCommitted) return;
    const attempted = el.value;
    lastCommitted = attempted;
    if (attempted !== value) {
      oncommit(attempted, el);
      lastCommitted = el.value;
    }
  }

  function keydown(e: KeyboardEvent & { currentTarget: HTMLInputElement | HTMLTextAreaElement }) {
    (onkeydown as ((e: KeyboardEvent) => void) | undefined)?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'Tab') {
      commit(e.currentTarget);
      return;
    }
    if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit(e.currentTarget);
    }
    if (e.key === 'Escape') {
      e.currentTarget.value = value;
      lastCommitted = value;
    }
  }
</script>

{#if multiline}
  <textarea
    {...rest as any}
    class="{className} h-auto min-h-[3.5rem] py-1"
    style="{parameterInputStyle} {style ?? ''}"
    {value}
    onblur={(e) => commit(e.currentTarget)}
    onchange={(e) => {
      (onchange as ((e: Event) => void) | undefined)?.(e);
      commit(e.currentTarget);
    }}
    onkeydown={keydown}
  ></textarea>
{:else}
  <input
    type="text"
    {...rest}
    class={className}
    style="{parameterInputStyle} {style ?? ''}"
    {value}
    onblur={(e) => commit(e.currentTarget)}
    onchange={(e) => {
      (onchange as ((e: Event) => void) | undefined)?.(e);
      commit(e.currentTarget);
    }}
    onkeydown={keydown}
  />
{/if}
