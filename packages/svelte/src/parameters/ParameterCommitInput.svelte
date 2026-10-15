<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { parameterInputClass } from './styles.js';

  interface Props extends Omit<HTMLInputAttributes, 'value' | 'class'> {
    value: string;
    oncommit: (value: string) => void;
    /** A textarea that commits on blur or Mod+Enter. */
    multiline?: boolean;
    class?: string;
  }

  let { value, oncommit, multiline = false, class: className = parameterInputClass, onkeydown, ...rest }: Props = $props();

  function commit(el: HTMLInputElement | HTMLTextAreaElement) {
    if (el.value !== value) oncommit(el.value);
  }

  function keydown(e: KeyboardEvent & { currentTarget: HTMLInputElement | HTMLTextAreaElement }) {
    (onkeydown as ((e: KeyboardEvent) => void) | undefined)?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit(e.currentTarget);
    }
    if (e.key === 'Escape') e.currentTarget.value = value;
  }
</script>

{#if multiline}
  <textarea
    {...rest as any}
    class="{className} h-auto min-h-[3.5rem] py-1"
    {value}
    onblur={(e) => commit(e.currentTarget)}
    onkeydown={keydown}
  ></textarea>
{:else}
  <input type="text" {...rest} class={className} {value} onblur={(e) => commit(e.currentTarget)} onkeydown={keydown} />
{/if}
