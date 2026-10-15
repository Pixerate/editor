<script lang="ts">
  import type { ParameterKeyState } from '@pixerate/editor/parameters';

  interface Props {
    state: ParameterKeyState;
    ontoggle: () => void;
    /** The parameter's label (for the accessible name). */
    label: string;
    disabled?: boolean;
    class?: string;
  }

  let { state, ontoggle, label, disabled = false, class: className = '' }: Props = $props();

  const keyed = $derived(state === 'keyed');
</script>

<!-- A keyframe toggle: filled when a key sits at the playhead, tinted when the value is animated. -->
<button
  type="button"
  data-key-state={state}
  aria-pressed={keyed}
  aria-label="{keyed ? 'Remove' : 'Add'} keyframe for {label}"
  title={keyed ? 'Remove keyframe here' : 'Add keyframe at the playhead'}
  {disabled}
  onclick={ontoggle}
  class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40 {state ===
  'none'
    ? 'text-muted-foreground hover:text-foreground'
    : 'text-amber-500'} {className}"
>
  <svg viewBox="0 0 10 10" class="h-2.5 w-2.5" aria-hidden="true">
    <path
      d="M5 0.8 9.2 5 5 9.2 0.8 5Z"
      fill={keyed ? 'currentColor' : 'none'}
      stroke="currentColor"
      stroke-width="1.3"
      opacity={state === 'animated' ? 0.7 : 1}
    />
  </svg>
</button>
