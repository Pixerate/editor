<script lang="ts">
  import { indexMotionNodes, motionIssueLine, type AnimationEditorController, type MotionFrameOptions, type MotionOnionSkin, type MotionRecordGestureMode } from '@pixerate/editor/animation-editor';
  import AnimationRecordPanel from './AnimationRecordPanel.svelte';
  import AnimationStage from './AnimationStage.svelte';
  import CommandInspector from './CommandInspector.svelte';
  import CommandList from './CommandList.svelte';
  import PlayheadScrubber from './PlayheadScrubber.svelte';
  import SceneSettings from './SceneSettings.svelte';
  import ShotInspector from './ShotInspector.svelte';
  import { animationEditorStateOf } from './createAnimationEditor.svelte.js';
  import type { EffectProvider } from '@pixerate/editor/effects';
  import { useEffects } from '../effects/effects.svelte.js';
  import AnimationEffectsPanel from './AnimationEffectsPanel.svelte';
  import type { AgentPlayback } from '@pixerate/editor/tools';
  import { createElementPlaybackSurface, getAgentPlayback } from '../playback/playback.svelte.js';
  import PresenceLayer from '../playback/PresenceLayer.svelte';

  interface Props {
    controller: AnimationEditorController;
    values?: MotionFrameOptions['values'];
    /** Faded frames either side of the playhead (see `<AnimationStage onionSkin>`). Default: an Onion skin toggle. */
    onionSkin?: MotionOnionSkin;
    /** Draw where nodes travel (see `<AnimationStage motionPaths>`). Default: a Motion paths toggle. */
    motionPaths?: boolean | readonly string[];
    /** List the scene's issues under the timeline (default true). */
    showIssues?: boolean;
    /**
     * Show the hand-editing panels: the command list and inspector, the shot inspector, scene
     * settings, undo / redo and picking on the stage (default true). False shows the stage,
     * scrubber and issues only.
     */
    editable?: boolean;
    /**
     * An effects provider (see `@pixerate/editor/effects`), registered with the controller while
     * mounted: provider motion applied to the picked element and vector effects, with an Effects
     * panel. Optional: without one the editor is as before.
     */
    effects?: EffectProvider | null;
    class?: string;
    /**
     * Agent playback: act out the animation tools' calls here with the agent's cursor (default:
     * `setAgentPlayback` above; `null` turns it off).
     */
    playback?: AgentPlayback | null;
    /** The playback surface id (default `animation`, where the animation tool providers play). */
    playbackId?: string;
    /** Bring the editor on screen (switch to its tab) before the agent acts. */
    onplaybackreveal?: () => void | Promise<void>;
  }

  let { controller, values, onionSkin, motionPaths, showIssues = true, editable = true, effects, class: className = '', playback, playbackId = 'animation', onplaybackreveal }: Props = $props();

  // Agent playback: the cursor clicks shots in the timeline and visits elements on the stage
  // (whose SVG keeps the artwork's ids, prefixed `ae-`).
  let root: HTMLDivElement | undefined = $state();
  const ambientPlayback = getAgentPlayback();
  const playing = $derived((playback === undefined ? ambientPlayback : playback) ?? null);
  const agentPresence = createElementPlaybackSurface(() => playing, () => playbackId, () => root, () => ({
    defaultKind: 'shot',
    selectors: {
      shot: (id: string) => `[data-shot="${CSS.escape(id)}"]`,
      element: (id: string) => `[data-animation-stage] [id="ae-${CSS.escape(id)}"]`
    },
    reveal: onplaybackreveal
  }));
  useEffects(() => controller, () => effects);
  const view = animationEditorStateOf(() => controller);
  const editor = $derived(view.current);
  const ONION: MotionOnionSkin = { before: 3, after: 1 };
  const btn = 'rounded border border-border px-2 py-0.5 text-xs disabled:opacity-40';
  let picked: string | null = $state(null);
  let onion = $state(false);
  let paths = $state(false);
  let recordMode: MotionRecordGestureMode = $state('move');
  const nodes = $derived(indexMotionNodes(editor.scene.artwork.nodes));
  const pickedValid = $derived(picked && nodes.has(picked) ? picked : null);
  const command = $derived(editor.selection?.command !== undefined ? editor.scene.shots.find((s) => s.id === editor.selection!.shot)?.run[editor.selection.command] : undefined);
  const targets = $derived(command && 'targets' in command ? command.targets : []);
  const highlight = $derived(editable ? [...(pickedValid ? [pickedValid] : []), ...targets] : undefined);

  function onpick(id: string | null, event: { shiftKey: boolean }) {
    const sel = editor.selection;
    if (event.shiftKey && id && command && 'targets' in command && sel?.command !== undefined && !editor.readOnly) {
      const next = targets.includes(id) ? targets.filter((t) => t !== id) : [...targets, id];
      if (next.length) controller.apply({ op: 'update_command', shot: sel.shot, command: sel.command, set: { targets: next } }, next.length > targets.length ? 'Add target' : 'Remove target');
      return;
    }
    picked = id;
  }
  function onkeydown(e: KeyboardEvent) {
    const el = e.target as HTMLElement;
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    e.preventDefault();
    if (e.shiftKey) controller.redo();
    else controller.undo();
  }
</script>

{#snippet issueList()}
  {#if showIssues && editor.issues.length > 0}
    <ul class="space-y-0.5 text-xs" aria-label="Animation issues">
      {#each editor.issues as issue, i (i)}
        <li class={issue.severity === 'error' ? 'text-red-500' : issue.severity === 'warning' ? 'text-amber-500' : 'text-muted-foreground'}>{motionIssueLine(issue)}</li>
      {/each}
    </ul>
  {/if}
{/snippet}

<!--
  A whole animation editor: the stage (click to pick an element, shift-click to toggle it as a
  target of the selected command), the playhead scrubber, a Record button to perform changes live
  on the stage and keep them as a shot, and panels to edit commands, shots and scene settings by
  hand. Every edit is one undo step.
-->
{#if !editable}
  <div bind:this={root} class="relative flex flex-col gap-2 {className}" data-animation-editor="">
    {#if playing}
      <PresenceLayer presence={agentPresence} />
    {/if}
    <AnimationStage {controller} {values} onionSkin={onionSkin} {motionPaths} class="rounded-md border border-border bg-muted/40" />
    <PlayheadScrubber {controller} />
    {@render issueList()}
  </div>
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div bind:this={root} class="relative grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem] {className}" data-animation-editor="" {onkeydown}>
    {#if playing}
      <PresenceLayer presence={agentPresence} />
    {/if}
    <div class="flex min-w-0 flex-col gap-2">
      <AnimationStage
        {controller}
        {values}
        onionSkin={onionSkin ?? (onion ? ONION : undefined)}
        motionPaths={motionPaths ?? paths}
        {onpick}
        {highlight}
        {recordMode}
        class="rounded-md border border-border bg-muted/40"
      />
      <PlayheadScrubber {controller} />
      <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <button type="button" class={btn} onclick={() => controller.undo()} disabled={!editor.canUndo} title={editor.canUndo ? `Undo ${editor.undoLabel}` : 'Nothing to undo'} data-undo="">Undo</button>
        <button type="button" class={btn} onclick={() => controller.redo()} disabled={!editor.canRedo} title={editor.canRedo ? `Redo ${editor.redoLabel}` : 'Nothing to redo'} data-redo="">Redo</button>
        {#if onionSkin === undefined}
          <label class="flex items-center gap-1"><input type="checkbox" bind:checked={onion} /> Onion skin</label>
        {/if}
        {#if motionPaths === undefined}
          <label class="flex items-center gap-1"><input type="checkbox" bind:checked={paths} /> Motion paths</label>
        {/if}
        <span class="ml-auto" data-picked-element={pickedValid ?? undefined}>
          {#if pickedValid}
            Picked <code class="text-rose-500">{pickedValid}</code>
            <button type="button" class="underline" onclick={() => (picked = null)}>clear</button>
          {:else}
            Click the stage to pick an element; shift-click to toggle it as a target.
          {/if}
        </span>
      </div>
      {#if !editor.readOnly}
        <AnimationRecordPanel {controller} node={pickedValid} mode={recordMode} onmodechange={(m) => (recordMode = m)} class="border-t border-border pt-2" />
      {/if}
      {@render issueList()}
    </div>
    <div class="flex min-w-0 flex-col gap-3">
      <CommandList {controller} targets={pickedValid ? [pickedValid] : undefined} />
      {#if editor.effectsProvider || controller.appliedEffects().length > 0}<AnimationEffectsPanel {controller} node={pickedValid} class="border-t border-border pt-2" />{/if}
      <CommandInspector {controller} picked={pickedValid} class="border-t border-border pt-2" />
      <details open class="border-t border-border pt-2">
        <summary class="cursor-pointer text-xs font-medium">Shot</summary>
        <ShotInspector {controller} class="mt-1" />
      </details>
      <details class="border-t border-border pt-2">
        <summary class="cursor-pointer text-xs font-medium">Scene settings</summary>
        <SceneSettings {controller} class="mt-1" />
      </details>
    </div>
  </div>
{/if}
