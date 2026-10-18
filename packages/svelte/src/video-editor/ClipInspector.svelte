<script lang="ts">
  import { findVideoClip, formatVideoTimecode, VIDEO_TRANSITION_TYPES, type VideoEdit, type VideoEditorController, type VideoTransitionType } from '@pixerate/editor/video-editor';
  import { videoEditorStateOf } from './createVideoEditor.svelte.js';

  interface Props {
    controller: VideoEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();
  const view = videoEditorStateOf(() => controller);
  const editor = $derived(view.current);
  const fps = $derived(editor.project.fps);
  const at = $derived(editor.selection.length === 1 ? findVideoClip(editor.project, editor.selection[0]) : null);
  const clip = $derived(at?.clip);
  const disabled = $derived(editor.readOnly || !!at?.track.locked);
  let localError = $state<{ text: string; revision: number } | null>(null);
  // A local error shows until the editor changes; then the editor's own error (if any) shows.
  const message = $derived((localError && localError.revision === editor.revision ? localError.text : null) ?? editor.error);
  const input = 'w-full min-w-0 rounded border border-border bg-transparent px-1 py-0.5 text-xs disabled:opacity-50';

  function apply(edit: VideoEdit, label: string) {
    localError = null;
    return controller.apply(edit, label);
  }
  /** One field: a value sets it, `undefined` removes it (back to its default). */
  function set(key: string, value: unknown, label: string) {
    if (!clip) return;
    apply(value === undefined ? { op: 'update_clip', clip: clip.id, remove: [key] } : { op: 'update_clip', clip: clip.id, set: { [key]: value } }, label);
  }
  /** A number field; empty removes it. */
  function number(key: string, raw: string, label: string, check: { min?: number; max?: number; above?: number; what: string }) {
    if (raw.trim() === '') return set(key, undefined, label);
    const n = Number(raw);
    if (!Number.isFinite(n) || (check.min !== undefined && n < check.min) || (check.max !== undefined && n > check.max) || (check.above !== undefined && n <= check.above)) {
      localError = { text: check.what, revision: editor.revision };
      return;
    }
    set(key, n, label);
  }
  /** A text field; empty removes it unless it is required. */
  function text(key: string, raw: string, label: string, required = false) {
    if (raw.trim() === '' && !required) return set(key, undefined, label);
    if (raw.trim() === '') {
      localError = { text: `${label.replace(/^Change /, '')} cannot be empty.`, revision: editor.revision };
      return;
    }
    set(key, key === 'text' ? raw : raw.trim(), label);
  }
  function setTransition(type: string) {
    if (!clip) return;
    if (!type) apply({ op: 'set_transition', clip: clip.id, transition: null }, 'Remove transition');
    else apply({ op: 'set_transition', clip: clip.id, transition: { ...clip.transition, type: type as VideoTransitionType, duration: clip.transition?.duration ?? 500 } }, 'Set transition');
  }
  function transitionDuration(raw: string) {
    if (!clip?.transition) return;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      localError = { text: 'Transition duration must be a number of ms above 0.', revision: editor.revision };
      return;
    }
    apply({ op: 'set_transition', clip: clip.id, transition: { ...clip.transition, duration: n } }, 'Change transition');
  }
</script>

<!--
  The selected clip: its name, timing, opacity and fades; volume, speed and mute for media; text,
  colours and size for titles; the colour of a colour clip; and the transition into it. Every
  committed change is one undo step.
-->
<div class="flex flex-col gap-1.5 text-xs {className}" data-clip-inspector="" data-clip={clip?.id}>
  {#if !clip}
    <p class="text-muted-foreground" data-inspector-hint="">
      {editor.selection.length > 1 ? `${editor.selection.length} clips selected; select one to edit it.` : 'Select a clip on the timeline to edit it.'}
    </p>
  {:else}
    <div class="flex items-center gap-1">
      <span class="font-medium">Clip</span>
      <code class="text-[10px] text-muted-foreground">{clip.id}</code>
      <span class="text-[10px] text-muted-foreground">{clip.type}</span>
      {#if at?.track.locked}<span class="ml-auto text-[10px] text-amber-500">Track {at.track.name ?? at.track.id} is locked</span>{/if}
    </div>
    <div class="grid grid-cols-[5.5rem_1fr] items-center gap-x-2 gap-y-1">
      <span class="text-muted-foreground">Name</span>
      <input class={input} aria-label="Clip name" {disabled} value={clip.name ?? ''} onchange={(e) => text('name', e.currentTarget.value, 'Rename clip')} data-field="name" />
      <span class="text-muted-foreground">Start</span>
      <span class="tabular-nums" data-field="start">{formatVideoTimecode(clip.start, fps)}</span>
      <span class="text-muted-foreground">Duration</span>
      <span class="tabular-nums" data-field="duration">{formatVideoTimecode(clip.duration, fps)} ({(clip.duration / 1000).toFixed(2)} s)</span>
      <span class="text-muted-foreground">Opacity</span>
      <input class={input} type="number" min="0" max="1" step="0.05" placeholder="1" aria-label="Opacity" {disabled} value={clip.opacity ?? ''} onchange={(e) => number('opacity', e.currentTarget.value, 'Change opacity', { min: 0, max: 1, what: 'Opacity must be between 0 and 1.' })} data-field="opacity" />
      <span class="text-muted-foreground">Fade in</span>
      <input class={input} type="number" min="0" step="100" placeholder="0 ms" aria-label="Fade in" {disabled} value={clip.fadeIn ?? ''} onchange={(e) => number('fadeIn', e.currentTarget.value, 'Change fade in', { min: 0, what: 'Fade in must be a number of ms, 0 or more.' })} data-field="fadeIn" />
      <span class="text-muted-foreground">Fade out</span>
      <input class={input} type="number" min="0" step="100" placeholder="0 ms" aria-label="Fade out" {disabled} value={clip.fadeOut ?? ''} onchange={(e) => number('fadeOut', e.currentTarget.value, 'Change fade out', { min: 0, what: 'Fade out must be a number of ms, 0 or more.' })} data-field="fadeOut" />
      {#if clip.type === 'media'}
        <span class="text-muted-foreground">Volume</span>
        <input class={input} type="number" min="0" step="0.05" placeholder="1" aria-label="Volume" {disabled} value={clip.volume ?? ''} onchange={(e) => number('volume', e.currentTarget.value, 'Change volume', { min: 0, what: 'Volume must be 0 or more (1 = unchanged).' })} data-field="volume" />
        <span class="text-muted-foreground">Speed</span>
        <input class={input} type="number" min="0.05" step="0.05" placeholder="1" aria-label="Speed" {disabled} value={clip.speed ?? ''} onchange={(e) => number('speed', e.currentTarget.value, 'Change speed', { above: 0, what: 'Speed must be a number above 0 (1 = normal speed).' })} data-field="speed" />
        <span class="text-muted-foreground">Muted</span>
        <input type="checkbox" class="justify-self-start" aria-label="Muted" {disabled} checked={!!clip.muted} onchange={(e) => set('muted', e.currentTarget.checked || undefined, e.currentTarget.checked ? 'Mute clip' : 'Unmute clip')} data-field="muted" />
      {:else if clip.type === 'text'}
        <span class="text-muted-foreground">Text</span>
        <textarea class={input} rows="2" aria-label="Text" {disabled} value={clip.text} onchange={(e) => text('text', e.currentTarget.value, 'Change text', true)} data-field="text"></textarea>
        <span class="text-muted-foreground">Colour</span>
        <input class={input} placeholder="white" aria-label="Text colour" {disabled} value={clip.color ?? ''} onchange={(e) => text('color', e.currentTarget.value, 'Change text colour')} data-field="color" />
        <span class="text-muted-foreground">Font size</span>
        <input class={input} type="number" min="1" step="1" placeholder="64" aria-label="Font size" {disabled} value={clip.fontSize ?? ''} onchange={(e) => number('fontSize', e.currentTarget.value, 'Change font size', { above: 0, what: 'Font size must be a number of pixels above 0.' })} data-field="fontSize" />
        <span class="text-muted-foreground">Background</span>
        <input class={input} placeholder="none" aria-label="Text background" {disabled} value={clip.background ?? ''} onchange={(e) => text('background', e.currentTarget.value, 'Change text background')} data-field="background" />
      {:else}
        <span class="text-muted-foreground">Colour</span>
        <input class={input} aria-label="Clip colour" {disabled} value={clip.color} onchange={(e) => text('color', e.currentTarget.value, 'Change colour', true)} data-field="color" />
      {/if}
      <span class="text-muted-foreground">Transition</span>
      <div class="flex items-center gap-1">
        <select class={input} aria-label="Transition" {disabled} value={clip.transition?.type ?? ''} onchange={(e) => setTransition(e.currentTarget.value)} data-field="transition">
          <option value="">none</option>
          {#each VIDEO_TRANSITION_TYPES as t (t)}
            <option value={t}>{t}</option>
          {/each}
        </select>
        {#if clip.transition}
          <input class="{input} w-20" type="number" min="1" step="50" aria-label="Transition duration" {disabled} value={clip.transition.duration} onchange={(e) => transitionDuration(e.currentTarget.value)} data-field="transitionDuration" />
          <span class="text-[10px] text-muted-foreground">ms</span>
        {/if}
      </div>
    </div>
  {/if}
  {#if message}
    <p class="text-red-500" role="alert" data-edit-error="">{message}</p>
  {/if}
</div>
