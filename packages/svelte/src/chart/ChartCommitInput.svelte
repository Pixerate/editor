<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { chartInputClass } from './styles.js';

  interface Props extends Omit<HTMLInputAttributes, 'value' | 'class'> {
    value: string;
    /** Called with the typed text. Return `false` to show the stored value again (a refused edit). */
    oncommit: (value: string) => boolean | void;
    class?: string;
  }

  let { value, oncommit, class: className = chartInputClass, onkeydown, onblur, ...rest }: Props = $props();

  // Follows `value` unless the user is typing.
  let draft = $state('');
  let typing = false;
  $effect.pre(() => {
    const next = value;
    if (!typing) draft = next;
  });

  function commit() {
    if (!typing) return;
    typing = false;
    if (draft === value) return;
    if (oncommit(draft) === false) draft = value;
  }

  function keydown(e: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    (onkeydown as ((e: KeyboardEvent) => void) | undefined)?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      typing = false;
      draft = value;
    }
  }
</script>

<input
  type="text"
  {...rest}
  class={className}
  value={draft}
  oninput={(e) => {
    typing = true;
    draft = e.currentTarget.value;
  }}
  onblur={(e) => {
    (onblur as ((e: FocusEvent) => void) | undefined)?.(e);
    commit();
  }}
  onkeydown={keydown}
/>
