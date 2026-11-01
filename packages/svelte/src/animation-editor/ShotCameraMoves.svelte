<script lang="ts">
  import { motionShotCameraMove, type AnimationEditorController, type MotionCameraMoveResult } from '@pixerate/editor/animation-editor';
  import type { CameraMoveRole, EffectSummary } from '@pixerate/editor/effects';
  import EffectParameters from '../effects/EffectParameters.svelte';
  import { effectDescriptionOf } from '../effects/effects.svelte.js';
  import { animationEditorStateOf } from './createAnimationEditor.svelte.js';

  interface Props {
    controller: AnimationEditorController;
    /** The shot whose moves to edit. */
    shot: string;
    class?: string;
  }

  let { controller, shot, class: className = '' }: Props = $props();
  const view = animationEditorStateOf(() => controller);
  const editor = $derived(view.current);
  const current = $derived(editor.scene.shots.find((s) => s.id === shot));
  const roles: { role: CameraMoveRole; label: string; none: string }[] = [
    { role: 'transition', label: 'Move in', none: 'ease in' },
    { role: 'hold', label: 'While holding', none: 'stay still' }
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
  const has = $derived(moves.transition.length + moves.hold.length > 0);
  const named = $derived(current?.camera?.in !== undefined || current?.camera?.during !== undefined);
  const inMove = $derived(motionShotCameraMove(current, 'transition'));
  const holdMove = $derived(motionShotCameraMove(current, 'hold'));
  const inDescription = effectDescriptionOf(() => controller.effectsProvider, () => inMove?.move);
  const holdDescription = effectDescriptionOf(() => controller.effectsProvider, () => holdMove?.move);
  let message = $state<string | null>(null);

  function report(r: Promise<MotionCameraMoveResult> | MotionCameraMoveResult) {
    void Promise.resolve(r).then((x) => (message = x.ok ? null : x.error));
  }
  function pick(role: CameraMoveRole, id: string) {
    report(id ? controller.setShotCameraMove(shot, role, id) : controller.clearShotCameraMove(shot, role));
  }
  // Changes over the move as saved; null removes a field (a changed value drops the preset's name).
  function set(role: CameraMoveRole, changes: { values?: Record<string, unknown>; preset?: string | null; ms?: number | null }, merge?: string | null) {
    const move = motionShotCameraMove(current, role);
    if (!move) return;
    const next: Record<string, unknown> = { ...move, ...changes };
    for (const k of Object.keys(next)) if (next[k] === null || (k === 'values' && !Object.keys(next[k] as object).length)) delete next[k];
    report(controller.setShotCameraMove(shot, role, next as never, { merge: merge ?? undefined }));
  }
  function length(raw: string) {
    if (raw.trim() === '') return set('transition', { ms: null });
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) set('transition', { ms: n });
    else message = 'Length is a number of ms, 0 or more.';
  }
  function reset(role: CameraMoveRole, k: string) {
    const { [k]: _gone, ...rest } = motionShotCameraMove(current, role)?.values ?? {};
    set(role, { values: rest, preset: null });
  }
</script>

<!--
  A shot's camera moves from the effects provider: the move it gets in with and the move it makes
  while it holds, each with its length (a move in), presets and controls. Hidden with the reason
  when the provider has no camera moves. Every change is one undo step (a slider drag is one).
-->
{#if current}
  {#if !has}
    {#if named}
      <p class="text-[10px] text-muted-foreground {className}" data-camera-moves="unavailable">
        This shot names camera moves, but {editor.effectsProvider ? `${editor.effectsProvider.name} has none` : 'no effects provider is set'}, so the camera eases instead.
      </p>
    {/if}
  {:else}
    <div class="grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1 {className}" data-camera-moves="">
      {#each roles as { role, label, none } (role)}
        {@const move = role === 'transition' ? inMove : holdMove}
        {@const loaded = role === 'transition' ? inDescription : holdDescription}
        {@const known = moves[role].some((m) => m.id === move?.move)}
        <span class="text-muted-foreground">{label}</span>
        <select class={input} aria-label={label} disabled={editor.readOnly} value={move?.move ?? ''} onchange={(e) => pick(role, e.currentTarget.value)}>
          <option value="">{none}</option>
          {#if move && !known}<option value={move.move}>{move.move} (not in the provider)</option>{/if}
          {#each moves[role] as m (m.id)}
            <option value={m.id}>{m.name}</option>
          {/each}
        </select>
        {#if move && known && !editor.readOnly}
          {#if loaded.error}
            <p class="col-span-2 text-[11px] text-amber-500">{loaded.error}</p>
          {:else if loaded.description}
            <div class="col-span-2 flex flex-col gap-1 border-l border-border pl-2" data-camera-move-controls={role}>
              {#if role === 'transition'}
                <div class="flex items-center gap-1">
                  <span class="w-16 text-muted-foreground">Length</span>
                  <input class={input} type="number" min="0" step="50" aria-label="Move length" placeholder={String(loaded.description.camera?.durationMs ?? '')} value={move.ms ?? ''} onchange={(e) => length(e.currentTarget.value)} />
                  <span class="text-[10px] text-muted-foreground">ms</span>
                </div>
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
      {#if message}<p class="col-span-2 text-[11px] text-destructive" role="alert">{message}</p>{/if}
    </div>
  {/if}
{/if}
