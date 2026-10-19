<script lang="ts">
  import type { SliderControl } from '@pixerate/editor/paint-editor';

  interface Props {
    control: SliderControl;
    value: number;
    /** Runs while dragging. */
    onchange?: (v: number) => void;
    /** Runs once on release (the native `change` event), for settings that are undo steps. */
    oncommit?: (v: number) => void;
  }
  let { control, value, onchange, oncommit }: Props = $props();
  let draft = $state<number | null>(null);
  const shown = $derived(draft ?? value);
  const fmt = (v: number) => (control.step >= 1 ? String(Math.round(v)) : v.toFixed(2));
</script>

<label class="flex flex-col gap-0.5" data-path={control.path}>
  <span class="flex justify-between text-slate-400">
    <span>{control.label}</span>
    <span class="font-mono">{fmt(shown)}</span>
  </span>
  <input
    type="range"
    aria-label={control.label}
    min={control.min}
    max={control.max}
    step={control.step}
    value={shown}
    oninput={(e) => {
      const v = Number(e.currentTarget.value);
      if (oncommit) draft = v;
      onchange?.(v);
    }}
    onchange={(e) => {
      oncommit?.(Number(e.currentTarget.value));
      draft = null;
    }}
    class="w-full accent-indigo-500"
  />
</label>
