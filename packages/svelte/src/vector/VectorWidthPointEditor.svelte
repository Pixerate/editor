<!--
  Width Point Edit: the position (percent along the path) and the left / right side widths
  (document units) of the width point a width-tool double-click opened. Apply (or Enter) sets
  them with `commitWidthPointEdit`; Cancel or Escape closes it. `<VectorCanvas>` shows it next
  to the point; use it on its own to place it elsewhere.
-->
<script lang="ts">
  import { VECTOR_OVERLAY_THEME as THEME, type VectorEditorController, type VectorWidthPointEdit } from '@pixerate/editor/vector';

  interface Props {
    controller: VectorEditorController;
    /** The point being edited (`state.widthPointEdit`). */
    edit: VectorWidthPointEdit;
    /** Accent colour of the Apply button (default sky blue). */
    accentColor?: string;
    class?: string;
    style?: string;
  }

  let { controller, edit, accentColor = THEME.accent, class: className = '', style = '' }: Props = $props();

  const round = (v: number, digits: number) => String(Math.round(v * 10 ** digits) / 10 ** digits);
  // The fields start from the point; the canvas re-keys the editor when it opens on another one.
  // svelte-ignore state_referenced_locally
  let position = $state<string | number | null>(round(edit.t * 100, 2));
  // svelte-ignore state_referenced_locally
  let left = $state<string | number | null>(round(edit.left, 3));
  // svelte-ignore state_referenced_locally
  let right = $state<string | number | null>(round(edit.right, 3));
  let form: HTMLFormElement | undefined = $state();

  const num = (v: unknown) => (String(v ?? '').trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

  // Hand the keyboard back to the canvas around it.
  function refocus() {
    (form?.closest('svg') as SVGSVGElement | null)?.focus?.({ preventScroll: true });
  }

  function close() {
    refocus();
    controller.closeWidthPointEdit();
  }

  function apply(e: SubmitEvent) {
    e.preventDefault();
    const t = num(position);
    refocus();
    controller.commitWidthPointEdit({ t: t === undefined ? undefined : Math.min(Math.max(t, 0), 100) / 100, left: num(left), right: num(right) });
  }

  function onKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  const stop = (e: Event) => e.stopPropagation();
  const fieldStyle = 'display:flex;align-items:center;justify-content:space-between;gap:6px';
  const inputStyle = 'width:72px;font:inherit;padding:1px 4px';
</script>

<!-- Keep the canvas from treating clicks, keys and clipboard use in here as editing gestures. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<form
  bind:this={form}
  data-vector-width-point-editor=""
  aria-label="Width point"
  class={className}
  style="display:grid;gap:4px;padding:8px;background:#ffffff;border:1px solid rgba(0,0,0,0.15);border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,0.15);font:12px system-ui,sans-serif;color:#18181b;{style}"
  onpointerdown={stop}
  onpointermove={stop}
  onpointerup={stop}
  ondblclick={stop}
  oncopy={stop}
  oncut={stop}
  onpaste={stop}
  onkeydown={onKeyDown}
  onsubmit={apply}
>
  <label style={fieldStyle}>
    Position %
    <!-- svelte-ignore a11y_autofocus -->
    <input aria-label="Width point position" type="number" min="0" max="100" step="any" bind:value={position} style={inputStyle} autofocus />
  </label>
  <label style={fieldStyle}>
    Left
    <input aria-label="Width point left side" type="number" min="0" step="any" bind:value={left} style={inputStyle} />
  </label>
  <label style={fieldStyle}>
    Right
    <input aria-label="Width point right side" type="number" min="0" step="any" bind:value={right} style={inputStyle} />
  </label>
  <div style="display:flex;justify-content:flex-end;gap:4px;margin-top:2px">
    <button type="button" onclick={close}>Cancel</button>
    <button type="submit" style="background:{accentColor};color:#ffffff;border:none;border-radius:4px;padding:2px 8px">{edit.index === null ? 'Add' : 'Apply'}</button>
  </div>
</form>
