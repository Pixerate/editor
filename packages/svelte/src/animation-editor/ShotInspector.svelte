<script lang="ts">
  import { describeMotionElements, freshShotId, motionCueChoices, motionCueFromKey, motionCueKey, type AnimationEditorController, type MotionEdit } from '@pixerate/editor/animation-editor';
  import { animationEditorStateOf } from './createAnimationEditor.svelte.js';

  interface Props {
    controller: AnimationEditorController;
    /** The shot to edit (default: the selected shot, else the first). */
    shot?: string;
    class?: string;
  }

  let { controller, shot, class: className = '' }: Props = $props();
  const view = animationEditorStateOf(() => controller);
  const editor = $derived(view.current);
  const elements = $derived(describeMotionElements(editor.scene));
  const cues = $derived(motionCueChoices(editor.scene));
  const id = $derived(shot ?? editor.selection?.shot ?? editor.scene.shots[0]?.id);
  const index = $derived(editor.scene.shots.findIndex((s) => s.id === id));
  const current = $derived(editor.scene.shots[index]);
  const cueKey = $derived(current ? motionCueKey(current.at) : '');
  const frame = $derived(current?.camera && 'frame' in current.camera ? current.camera.frame : '');
  let localError = $state<{ text: string; revision: number } | null>(null);
  // A local error shows until the editor changes; then the editor's own error (if any) shows.
  const message = $derived((localError && localError.revision === editor.revision ? localError.text : null) ?? editor.error);
  function setLocal(text: string | null) {
    localError = text ? { text, revision: editor.revision } : null;
  }
  const input = 'w-full min-w-0 rounded border border-border bg-transparent px-1 py-0.5 text-xs';
  const btn = 'rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-40';

  function apply(edit: MotionEdit | MotionEdit[], label: string) {
    setLocal(null);
    return controller.apply(edit, label);
  }
  function addShot() {
    const newId = freshShotId(editor.scene, 'shot');
    const at = index >= 0 ? index + 1 : editor.scene.shots.length;
    if (apply({ op: 'insert_shots', shots: [{ id: newId, label: 'New shot', run: [] }], at }, 'Add shot').ok) {
      controller.select({ shot: newId });
      controller.seekShot(newId);
    }
  }
  function number(key: 'hold' | 'speed', raw: string, label: string) {
    const n = Number(raw);
    if (raw.trim() === '') return apply({ op: 'update_shot', shot: current.id, remove: [key] }, label);
    if (!Number.isFinite(n) || n < 0 || (key === 'speed' && n <= 0)) {
      setLocal(key === 'speed' ? 'Speed must be a number above 0 (1 = as written).' : 'Hold must be a number of ms, 0 or more.');
      return;
    }
    apply({ op: 'update_shot', shot: current.id, set: { [key]: n } }, label);
  }
  function rename(raw: string) {
    apply(raw.trim() ? { op: 'update_shot', shot: current.id, set: { label: raw.trim() } } : { op: 'update_shot', shot: current.id, remove: ['label'] }, 'Rename shot');
  }
  function setCamera(v: string) {
    if (!v) apply({ op: 'update_shot', shot: current.id, remove: ['camera'] }, 'Clear camera');
    else if (v.startsWith('frame:')) apply({ op: 'update_shot', shot: current.id, set: { camera: { frame: v.slice(6), padding: 24 } } }, 'Frame camera');
  }
  function setCue(v: string) {
    const cue = motionCueFromKey(v);
    apply(cue ? { op: 'update_shot', shot: current.id, set: { at: cue } } : { op: 'update_shot', shot: current.id, remove: ['at'] }, 'Cue shot');
  }
</script>

<!--
  The selected shot: label, hold, speed, the node the camera frames and the cue it starts on (a
  beat or a narration word). Also adds, moves and deletes shots. Every change is one undo step.
-->
<div class="flex flex-col gap-1.5 text-xs {className}" data-shot-inspector="">
  <div class="flex items-center gap-1">
    <span class="font-medium">Shot</span>
    {#if current}<code class="text-[10px] text-muted-foreground">{current.id}</code>{/if}
    <span class="ml-auto flex gap-0.5">
      <button type="button" class={btn} disabled={editor.readOnly} onclick={addShot} data-add-shot="">+ Shot</button>
      {#if current}
        <button type="button" class={btn} aria-label="Move shot earlier" disabled={editor.readOnly || index === 0} onclick={() => apply({ op: 'move_shot', shot: current.id, to: index - 1 }, 'Move shot')}>←</button>
        <button type="button" class={btn} aria-label="Move shot later" disabled={editor.readOnly || index === editor.scene.shots.length - 1} onclick={() => apply({ op: 'move_shot', shot: current.id, to: index + 1 }, 'Move shot')}>→</button>
        <button type="button" class={btn} aria-label="Delete shot" disabled={editor.readOnly} onclick={() => apply({ op: 'delete_shots', shots: [current.id] }, 'Delete shot')}>✕</button>
      {/if}
    </span>
  </div>
  {#if current}
    <div class="grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1">
      <span class="text-muted-foreground">Label</span>
      <input class={input} aria-label="Shot label" disabled={editor.readOnly} value={current.label ?? ''} onchange={(e) => rename(e.currentTarget.value)} />
      <span class="text-muted-foreground">Hold</span>
      <div class="flex items-center gap-1">
        <input class={input} type="number" min="0" step="50" aria-label="Hold" placeholder="600" disabled={editor.readOnly} value={current.hold ?? ''} onchange={(e) => number('hold', e.currentTarget.value, 'Change hold')} />
        <span class="text-[10px] text-muted-foreground">ms</span>
      </div>
      <span class="text-muted-foreground">Speed</span>
      <div class="flex items-center gap-1">
        <input class={input} type="number" min="0.05" step="0.05" aria-label="Speed" placeholder="1" disabled={editor.readOnly} value={current.speed ?? ''} onchange={(e) => number('speed', e.currentTarget.value, 'Change speed')} />
        <span class="text-[10px] text-muted-foreground">×</span>
      </div>
      <span class="text-muted-foreground">Camera</span>
      <select class={input} aria-label="Camera frames" disabled={editor.readOnly} value={current.camera ? (frame ? `frame:${frame}` : 'rect') : ''} onchange={(e) => setCamera(e.currentTarget.value)}>
        <option value="">keep framing</option>
        {#if current.camera && !frame}<option value="rect">a rectangle</option>{/if}
        {#each elements as e (e.id)}
          <option value="frame:{e.id}">frame {e.name ?? e.id}</option>
        {/each}
      </select>
      <span class="text-muted-foreground">Starts on</span>
      <select class={input} aria-label="Cue" disabled={editor.readOnly || index === 0} value={cueKey} onchange={(e) => setCue(e.currentTarget.value)}>
        <option value="">after the shot before</option>
        {#if cueKey && !cues.some((c) => c.value === cueKey)}<option value={cueKey}>{cueKey}</option>{/if}
        {#each cues as c (c.value)}
          <option value={c.value}>{c.label}</option>
        {/each}
      </select>
      {#if !cues.length && index > 0}
        <p class="col-span-2 text-[10px] text-muted-foreground">Add a beat grid or narration in the scene settings to cue shots to them.</p>
      {/if}
    </div>
  {/if}
  {#if message}
    <p class="text-red-500" role="alert" data-edit-error="">{message}</p>
  {/if}
</div>
