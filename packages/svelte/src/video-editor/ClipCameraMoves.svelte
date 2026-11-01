<script lang="ts">
  import { findVideoClip, videoClipCameraMove, type VideoCameraMoveResult, type VideoEditorController } from '@pixerate/editor/video-editor';
  import type { CameraMoveRole, EffectSummary } from '@pixerate/editor/effects';
  import EffectParameters from '../effects/EffectParameters.svelte';
  import { effectDescriptionOf } from '../effects/effects.svelte.js';
  import { videoEditorStateOf } from './createVideoEditor.svelte.js';

  interface Props {
    controller: VideoEditorController;
    /** The clip whose moves to edit. */
    clip: string;
    class?: string;
  }

  let { controller, clip, class: className = '' }: Props = $props();
  const view = videoEditorStateOf(() => controller);
  const editor = $derived(view.current);
  const at = $derived(findVideoClip(editor.project, clip));
  const current = $derived(at && at.track.kind !== 'audio' && at.clip.type !== 'adjustment' ? at.clip : undefined);
  const disabled = $derived(editor.readOnly || !!at?.track.locked);
  const roles: { role: CameraMoveRole; label: string }[] = [
    { role: 'transition', label: 'Move in' },
    { role: 'hold', label: 'While holding' }
  ];
  const input = 'w-full min-w-0 rounded border border-border bg-transparent px-1 py-0.5 text-xs';

  // The provider's camera moves of each role, loaded when the provider changes.
  let moves = $state<Record<CameraMoveRole, EffectSummary[]>>({ transition: [], hold: [] });
  $effect(() => {
    void editor.effectsProvider;
    let live = true;
    void Promise.all([controller.cameraMoves('transition'), controller.cameraMoves('hold')]).then(
      ([transition, hold]) => live && (moves = { transition, hold }),
      () => live && (moves = { transition: [], hold: [] })
    );
    return () => (live = false);
  });
  const inMove = $derived(videoClipCameraMove(current, 'transition'));
  const holdMove = $derived(videoClipCameraMove(current, 'hold'));
  const inDescription = effectDescriptionOf(() => controller.effectsProvider, () => inMove?.move);
  const holdDescription = effectDescriptionOf(() => controller.effectsProvider, () => holdMove?.move);
  let message = $state<string | null>(null);

  function report(r: Promise<VideoCameraMoveResult>) {
    void r.then((x) => (message = x.ok ? null : x.error));
  }
  function pick(role: CameraMoveRole, id: string) {
    report(id ? controller.setClipCameraMove(clip, role, id) : controller.clearClipCameraMove(clip, role));
  }
  // Changes over the move as saved; null removes a field (a changed value drops the preset's name).
  function set(role: CameraMoveRole, changes: { values?: Record<string, unknown>; preset?: string | null; ms?: number | null }, merge?: string | null) {
    const move = videoClipCameraMove(current, role);
    if (!move) return;
    const next: Record<string, unknown> = { ...move, ...changes };
    for (const k of Object.keys(next)) if (next[k] === null || (k === 'values' && !Object.keys(next[k] as object).length)) delete next[k];
    report(controller.setClipCameraMove(clip, role, next as never, { merge: merge ?? undefined }));
  }
  function length(raw: string) {
    if (raw.trim() === '') return set('transition', { ms: null });
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) set('transition', { ms: n });
    else message = 'Length is a number of ms, 0 or more.';
  }
  function reset(role: CameraMoveRole, k: string) {
    const { [k]: _gone, ...rest } = videoClipCameraMove(current, role)?.values ?? {};
    set(role, { values: rest, preset: null });
  }
  function zoom(raw: string) {
    if (!current?.camera) return;
    const role: CameraMoveRole = current.camera.in !== undefined ? 'transition' : 'hold';
    const z = Number(raw);
    if (raw.trim() !== '' && !(z > 0)) {
      message = 'Zoom is a number above 0 (1 shows the whole picture).';
      return;
    }
    report(controller.setClipCameraMove(clip, role, videoClipCameraMove(current, role)!, { framing: raw.trim() === '' ? null : { ...current.camera.framing, zoom: z } }));
  }
</script>

<!--
  A clip's camera moves from the effects provider: the move into the clip and the move across the
  rest of it, with the zoom they frame, a move in's length, presets and controls. The moves are
  baked into the clip's transform keys. Hidden with the reason when the provider has no camera
  moves. Every change is one undo step (a slider drag is one).
-->
{#if current}
  {#if !moves.transition.length && !moves.hold.length}
    {#if current.camera}
      <p class="text-[10px] text-muted-foreground {className}" data-camera-moves="unavailable">
        This clip's camera moves are baked into its keys; {editor.effectsProvider ? `${editor.effectsProvider.name} has no camera moves` : 'no effects provider is set'}, so they cannot be changed here.
      </p>
    {/if}
  {:else}
    <div class="flex flex-col gap-1 text-xs {className}" data-camera-moves="">
      {#each roles as { role, label } (role)}
        {@const move = role === 'transition' ? inMove : holdMove}
        {@const loaded = role === 'transition' ? inDescription : holdDescription}
        {@const known = moves[role].some((m) => m.id === move?.move)}
        <label class="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2">
          <span class="text-muted-foreground">{label}</span>
          <select class={input} aria-label={label} {disabled} value={move?.move ?? ''} onchange={(e) => pick(role, e.currentTarget.value)}>
            <option value="">none</option>
            {#if move && !known}<option value={move.move}>{move.move} (not in the provider)</option>{/if}
            {#each moves[role] as m (m.id)}
              <option value={m.id}>{m.name}</option>
            {/each}
          </select>
        </label>
        {#if move && known && !disabled}
          {#if loaded.error}
            <p class="text-[11px] text-amber-500">{loaded.error}</p>
          {:else if loaded.description}
            <div class="flex flex-col gap-1 border-l border-border pl-2" data-camera-move-controls={role}>
              {#if role === 'transition'}
                <label class="flex items-center gap-1">
                  <span class="w-16 text-muted-foreground">Length</span>
                  <input class={input} type="number" min="0" step="50" aria-label="Move length" placeholder={String(loaded.description.camera?.durationMs ?? '')} value={move.ms ?? ''} onchange={(e) => length(e.currentTarget.value)} />
                  <span class="text-[10px] text-muted-foreground">ms</span>
                </label>
              {/if}
              <EffectParameters
                description={loaded.description}
                values={move.values ?? {}}
                onchange={(k, v, g) => set(role, { values: { ...(move.values ?? {}), [k]: v }, preset: null }, g)}
                onreset={(k) => reset(role, k)}
                onpresetname={(name) => set(role, { preset: name, values: {} })}
              />
            </div>
          {/if}
        {/if}
      {/each}
      {#if current.camera && !disabled}
        <label class="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2">
          <span class="text-muted-foreground">Camera zoom</span>
          <input class={input} type="number" min="0.1" step="0.1" aria-label="Camera zoom" placeholder="1" value={current.camera.framing?.zoom ?? ''} onchange={(e) => zoom(e.currentTarget.value)} />
        </label>
      {/if}
      {#if message}<p class="text-[11px] text-destructive" role="alert">{message}</p>{/if}
    </div>
  {/if}
{/if}
