<script lang="ts">
  import {
    findVideoClip,
    formatVideoSeconds,
    formatVideoTimecode,
    VIDEO_CLIP_ANIMATION_EFFECTS,
    VIDEO_CLIP_ANIMATION_LABELS,
    normalizeVideoGrade,
    VIDEO_GRADE_CONTROLS,
    VIDEO_GRADE_PRESET_NAMES,
    videoGradeLook,
    videoLutEdits,
    VIDEO_BLEND_MODE_LABELS,
    VIDEO_BLEND_MODES,
    VIDEO_FADE_CURVE_LABELS,
    VIDEO_FADE_CURVES,
    VIDEO_TRANSITION_LABELS,
    VIDEO_TRANSITION_TYPES,
    VIDEO_WIPE_DIRECTIONS,
    videoTransitionHasDirection,
    videoFreezeFrameEdit,
    videoKeyframeRows,
    videoSlowMotionRamp,
    videoSpeedRampEdit,
    videoTransitionAudioCurve,
    videoKeyframeToggleEdit,
    videoKeyframeValueEdit,
    videoClipHeading,
    videoMaskEdit,
    videoSkinProtectionEdits,
    VIDEO_ADJUSTMENT_SCOPES,
    VIDEO_ADJUSTMENT_SCOPE_LABELS,
    VIDEO_MASK_SHAPES,
    VIDEO_MASK_SHAPE_LABELS,
    type VideoAdjustmentScope,
    type VideoClipMask,
    type VideoMaskShape,
    type VideoEdit,
    type VideoEditorController,
    type VideoFadeCurve,
    type VideoGradeControl,
    type VideoGradeLut,
    type VideoGradePreset,
    type VideoKeyframeRow,
    type VideoTransitionType,
    type VideoWipeDirection
  } from '@pixerate/editor/video-editor';
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
  const rows = $derived(clip ? videoKeyframeRows(editor.project, clip.id, editor.time) : []);
  const btn = 'rounded border border-border px-1.5 py-0.5 text-[10px] disabled:opacity-40';
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
  /** The value shown in a property's field: blank when it is plain and at its default. */
  function shown(row: VideoKeyframeRow): string | number {
    if (!clip || row.keyed) return row.value;
    const plain = row.property === 'opacity' ? clip.opacity : row.property === 'volume' ? (clip as { volume?: unknown }).volume : clip.transform?.[row.property];
    return plain === undefined ? '' : row.value;
  }
  /** Typing a value: sets the key at the playhead when the property is keyed, else the plain value (empty resets it). */
  function animatable(row: VideoKeyframeRow, raw: string) {
    if (!clip) return;
    const n = Number(raw);
    if (raw.trim() !== '' && (!Number.isFinite(n) || (row.min !== undefined && n < row.min) || (row.max !== undefined && n > row.max))) {
      localError = { text: `${row.label} must be ${row.max !== undefined ? `between ${row.min} and ${row.max}` : row.min !== undefined ? `${row.min} or more` : 'a number'}.`, revision: editor.revision };
      return;
    }
    const edit = videoKeyframeValueEdit(editor.project, clip.id, row.property, editor.time, raw.trim() === '' ? undefined : n);
    if (edit) apply(edit, row.keyed ? `Keyframe ${row.label.toLowerCase()}` : `Change ${row.label.toLowerCase()}`);
  }
  function toggleKey(row: VideoKeyframeRow) {
    if (!clip) return;
    const edit = videoKeyframeToggleEdit(editor.project, clip.id, row.property, editor.time);
    if (edit) apply(edit, `${row.onKey ? 'Remove' : 'Add'} ${row.label.toLowerCase()} keyframe`);
  }
  function setTransition(type: string) {
    if (!clip) return;
    if (!type) apply({ op: 'set_transition', clip: clip.id, transition: null }, 'Remove transition');
    else {
      // A provider transition's effect does not carry over to a built-in type.
      const { effect: _effect, ...rest } = clip.transition ?? { duration: 500 };
      apply({ op: 'set_transition', clip: clip.id, transition: { ...rest, type: type as VideoTransitionType, duration: clip.transition?.duration ?? 500 } }, 'Set transition');
    }
  }
  function gradeValue(c: VideoGradeControl, raw: string) {
    if (!clip) return;
    const n = raw.trim() ? Number(raw) : 0;
    if (!Number.isFinite(n)) {
      localError = { text: `${c.label} must be a number from ${c.min} to ${c.max}.`, revision: editor.revision };
      return;
    }
    // Out-of-range values are clamped to the control's range.
    set('grade', normalizeVideoGrade({ ...clip.grade, [c.key]: n }), `Change ${c.label.toLowerCase()}`);
  }
  function gradePreset(name: string) {
    const grade = clip && name ? videoGradeLook(clip.grade, name as VideoGradePreset) : undefined;
    if (clip && grade) apply({ op: 'update_clip', clip: clip.id, set: { grade } }, `Apply ${name} look`);
  }
  /** Gives the clip a LUT (keeping its other grade settings), or takes it off with `null`. */
  function setLut(setting: VideoGradeLut | null, label: string) {
    if (!clip) return;
    localError = null;
    const r = controller.apply(videoLutEdits(editor.project, [clip.id], setting), label);
    if (!r.ok) localError = { text: r.error, revision: editor.revision };
  }
  /** A `.cube` path or URL, checked by loading it; empty removes the LUT. */
  async function chooseLut(src: string) {
    if (!clip) return;
    const strength = clip.grade?.lut?.strength;
    if (!src) return clip.grade?.lut && setLut(null, 'Remove LUT');
    try {
      const table = await controller.luts.load(src);
      setLut({ src, ...(strength !== undefined ? { strength } : {}), ...(table.title ? { name: table.title } : {}) }, 'Apply LUT');
    } catch (e) {
      localError = { text: e instanceof Error ? e.message : String(e), revision: editor.revision };
    }
  }
  /** A `.cube` file read in place: its name becomes the `src`, so keep the file beside the export. */
  async function loadLutFile(file: File | undefined) {
    if (!file || !clip) return;
    const strength = clip.grade?.lut?.strength;
    try {
      const table = controller.luts.set(file.name, await file.text());
      setLut({ src: file.name, ...(strength !== undefined ? { strength } : {}), ...(table.title ? { name: table.title } : {}) }, 'Apply LUT');
    } catch (e) {
      localError = { text: `${file.name}: ${e instanceof Error ? e.message : String(e)}`, revision: editor.revision };
    }
  }
  function lutStrength(raw: string) {
    const lut = clip?.grade?.lut;
    const n = Number(raw);
    if (!lut || !raw.trim() || !Number.isFinite(n)) return;
    // A strength of 0 changes nothing, so it takes the LUT off.
    setLut(n > 0 ? { ...lut, strength: Math.min(1, n) } : null, n > 0 ? 'Change LUT strength' : 'Remove LUT');
  }
  function skinProtection(raw: string) {
    const n = Number(raw);
    if (!clip || !raw.trim() || !Number.isFinite(n)) return;
    const r = controller.apply(videoSkinProtectionEdits(editor.project, [clip.id], n), n > 0 ? 'Protect skin tones' : 'Stop protecting skin tones');
    if (!r.ok) localError = { text: r.error, revision: editor.revision };
  }
  function setScope(scope: VideoAdjustmentScope) {
    if (!clip || !at) return;
    const target = editor.project.tracks.find((t) => t.kind === 'video' && t.id !== at.track.id)?.id;
    if (scope === 'track') apply({ op: 'update_clip', clip: clip.id, set: { scope, targetTrack: (clip.type === 'adjustment' ? clip.targetTrack : undefined) ?? target ?? at.track.id } }, 'Change adjustment scope');
    else apply({ op: 'update_clip', clip: clip.id, ...(scope === 'underneath' ? { remove: ['scope', 'targetTrack'] } : { set: { scope }, remove: ['targetTrack'] }) }, 'Change adjustment scope');
  }
  function setMaskShape(shape: VideoMaskShape | '') {
    if (!clip) return;
    const { points: _p, cornerRadius: _c, ...rest } = clip.mask ?? ({ shape: 'ellipse' } as VideoClipMask);
    const points = [
      { x: 0.5, y: 0.2 },
      { x: 0.8, y: 0.8 },
      { x: 0.2, y: 0.8 }
    ];
    apply(videoMaskEdit(clip.id, shape ? { ...rest, shape, ...(shape === 'polygon' ? { points } : {}) } : null), shape ? 'Mask clip' : 'Remove mask');
  }
  function setMaskValue(key: 'width' | 'height' | 'feather' | 'rotation', raw: string) {
    if (!clip?.mask) return;
    const n = Number(raw);
    if (raw.trim() && !Number.isFinite(n)) return;
    const { [key]: _old, ...rest } = clip.mask;
    apply(videoMaskEdit(clip.id, raw.trim() ? { ...rest, [key]: n } : rest), 'Change mask');
  }
  function invertMask(on: boolean) {
    if (!clip?.mask) return;
    const { inverted: _i, ...rest } = clip.mask;
    apply(videoMaskEdit(clip.id, on ? { ...rest, inverted: true } : rest), 'Invert mask');
  }
  const MASK_FIELDS = [
    { key: 'width', label: 'Mask width', step: 0.05, placeholder: '0.5' },
    { key: 'height', label: 'Mask height', step: 0.05, placeholder: '0.5' },
    { key: 'feather', label: 'Feather (px)', step: 5, placeholder: '0' },
    { key: 'rotation', label: 'Mask angle', step: 5, placeholder: '0' }
  ] as const;
  function transitionAudioCurve(curve: string) {
    if (!clip?.transition) return;
    const { audioCurve: _, ...rest } = clip.transition;
    // The type's own default is stored as no curve, so it follows the type if that changes.
    const next = curve === videoTransitionAudioCurve(rest) ? rest : { ...rest, audioCurve: curve as VideoFadeCurve };
    apply({ op: 'set_transition', clip: clip.id, transition: next }, 'Change transition sound');
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
  The selected clip: its name, timing and fades; opacity, volume and transform, each with a keyframe
  toggle at the playhead (◆ adds a key holding the value there or removes the one there; typing a
  value on a keyed property sets the key at the playhead); speed and mute for media; text,
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
      <span class="font-medium">{videoClipHeading(clip)}</span>
      <code class="text-[10px] text-muted-foreground">{clip.id}</code>
      {#if at?.track.locked}<span class="ml-auto text-[10px] text-amber-500">Track {at.track.name ?? at.track.id} is locked</span>{/if}
    </div>
    <div class="grid grid-cols-[5.5rem_1fr] items-center gap-x-2 gap-y-1">
      <span class="text-muted-foreground">Name</span>
      <input class={input} aria-label="Clip name" {disabled} value={clip.name ?? ''} onchange={(e) => text('name', e.currentTarget.value, 'Rename clip')} data-field="name" />
      <span class="text-muted-foreground">Start</span>
      <span class="tabular-nums" data-field="start">{formatVideoTimecode(clip.start, fps)}</span>
      <span class="text-muted-foreground">Duration</span>
      <span class="tabular-nums" data-field="duration">{formatVideoTimecode(clip.duration, fps)} ({(clip.duration / 1000).toFixed(2)} s)</span>
      {#if at?.track.kind === 'video'}
        <span class="text-muted-foreground">Blend</span>
        <select class={input} aria-label="Blend mode" {disabled} value={clip.blend ?? 'normal'} onchange={(e) => set('blend', e.currentTarget.value === 'normal' ? undefined : e.currentTarget.value, 'Change blend mode')} data-field="blend">
          {#each VIDEO_BLEND_MODES as m (m)}
            <option value={m}>{VIDEO_BLEND_MODE_LABELS[m]}</option>
          {/each}
        </select>
      {/if}
      {#if at?.track.kind === 'video'}
        <span class="text-muted-foreground">Look</span>
        <select class={input} aria-label="Apply a look" {disabled} value="" onchange={(e) => gradePreset(e.currentTarget.value)} data-field="gradePreset">
          <option value="">{clip.grade ? 'graded' : 'none'}</option>
          {#each VIDEO_GRADE_PRESET_NAMES as name (name)}
            <option value={name}>{name.replace(/-/g, ' ')}</option>
          {/each}
        </select>
        {#each VIDEO_GRADE_CONTROLS as c (c.key)}
          <span class="text-muted-foreground">{c.label}</span>
          <input class={input} type="number" min={c.min} max={c.max} step={c.step} placeholder="0" aria-label={c.label} {disabled} value={clip.grade?.[c.key] ?? ''} onchange={(e) => gradeValue(c, e.currentTarget.value)} data-field="grade.{c.key}" />
        {/each}
        <span class="text-muted-foreground">LUT</span>
        <div class="flex min-w-0 gap-1" data-field="grade.lut">
          <input class={input} placeholder="look.cube" aria-label="LUT file" {disabled} value={clip.grade?.lut?.src ?? ''} onchange={(e) => chooseLut(e.currentTarget.value.trim())} />
          <label class="{btn} cursor-pointer whitespace-nowrap" title="Load a .cube file">
            Load
            <input type="file" accept=".cube" class="sr-only" {disabled} aria-label="Load a .cube LUT" onchange={(e) => loadLutFile(e.currentTarget.files?.[0])} />
          </label>
          {#if clip.grade?.lut}
            <button type="button" class={btn} {disabled} aria-label="Remove LUT" onclick={() => setLut(null, 'Remove LUT')}>✕</button>
          {/if}
        </div>
        {#if clip.grade?.lut}
          <span class="text-muted-foreground">LUT strength</span>
          <input class={input} type="number" min="0" max="1" step="0.05" aria-label="LUT strength" {disabled} value={clip.grade.lut.strength ?? 1} onchange={(e) => lutStrength(e.currentTarget.value)} data-field="grade.lut.strength" />
          <span class="text-muted-foreground">Protect skin</span>
          <input class={input} type="number" min="0" max="1" step="0.1" aria-label="Protect skin tones" title="How much of the LUT to hold back on skin tones (0 to 1)" {disabled} value={clip.grade.lut.preserveSkinTones ?? 0} onchange={(e) => skinProtection(e.currentTarget.value)} data-field="grade.lut.preserveSkinTones" />
        {/if}
      {/if}
      {#if clip.type === 'adjustment'}
        <span class="text-muted-foreground">Changes</span>
        <select class={input} aria-label="Adjustment scope" {disabled} value={clip.scope ?? 'underneath'} onchange={(e) => setScope(e.currentTarget.value as VideoAdjustmentScope)} data-field="scope">
          {#each VIDEO_ADJUSTMENT_SCOPES as s (s)}
            <option value={s}>{VIDEO_ADJUSTMENT_SCOPE_LABELS[s]}</option>
          {/each}
        </select>
        {#if clip.scope === 'track'}
          <span class="text-muted-foreground">Track</span>
          <select class={input} aria-label="Adjusted track" {disabled} value={clip.targetTrack ?? ''} onchange={(e) => set('targetTrack', e.currentTarget.value, 'Change adjusted track')} data-field="targetTrack">
            {#each editor.project.tracks.filter((t) => t.kind === 'video') as t (t.id)}
              <option value={t.id}>{t.name ?? t.id}</option>
            {/each}
          </select>
        {/if}
      {/if}
      {#if at?.track.kind === 'video'}
        <span class="text-muted-foreground">Mask</span>
        <select class={input} aria-label="Mask shape" {disabled} value={clip.mask?.shape ?? ''} onchange={(e) => setMaskShape(e.currentTarget.value as VideoMaskShape | '')} data-field="mask">
          <option value="">none</option>
          {#each VIDEO_MASK_SHAPES as s (s)}
            <option value={s}>{VIDEO_MASK_SHAPE_LABELS[s]}</option>
          {/each}
        </select>
        {#if clip.mask}
          {#each MASK_FIELDS as f (f.key)}
            <span class="text-muted-foreground">{f.label}</span>
            <input class={input} type="number" step={f.step} min={f.key === 'rotation' ? undefined : 0} placeholder={f.placeholder} aria-label={f.label} {disabled} value={clip.mask[f.key] ?? ''} onchange={(e) => setMaskValue(f.key, e.currentTarget.value)} data-field="mask.{f.key}" />
          {/each}
          <span class="text-muted-foreground">Invert mask</span>
          <input type="checkbox" class="justify-self-start" aria-label="Invert mask" {disabled} checked={!!clip.mask.inverted} onchange={(e) => invertMask(e.currentTarget.checked)} data-field="mask.inverted" />
        {/if}
      {/if}
      {#if at?.track.kind === 'video'}
        {#each [{ key: 'animateIn', label: 'Animate in', change: 'Change entrance' }, { key: 'animateOut', label: 'Animate out', change: 'Change exit' }] as const as row (row.key)}
          <span class="text-muted-foreground">{row.label}</span>
          <select class={input} aria-label={row.label} {disabled} value={clip[row.key]?.effect ?? ''} onchange={(e) => set(row.key, e.currentTarget.value ? { ...clip?.[row.key], effect: e.currentTarget.value } : undefined, row.change)} data-field={row.key}>
            <option value="">none</option>
            {#each VIDEO_CLIP_ANIMATION_EFFECTS as effect (effect)}
              <option value={effect}>{VIDEO_CLIP_ANIMATION_LABELS[effect]}</option>
            {/each}
          </select>
        {/each}
      {/if}
      <span class="text-muted-foreground">Fade in</span>
      <input class={input} type="number" min="0" step="100" placeholder="0 ms" aria-label="Fade in" {disabled} value={clip.fadeIn ?? ''} onchange={(e) => number('fadeIn', e.currentTarget.value, 'Change fade in', { min: 0, what: 'Fade in must be a number of ms, 0 or more.' })} data-field="fadeIn" />
      <span class="text-muted-foreground">Fade out</span>
      <input class={input} type="number" min="0" step="100" placeholder="0 ms" aria-label="Fade out" {disabled} value={clip.fadeOut ?? ''} onchange={(e) => number('fadeOut', e.currentTarget.value, 'Change fade out', { min: 0, what: 'Fade out must be a number of ms, 0 or more.' })} data-field="fadeOut" />
      {#each rows as row (row.property)}
        <span class="text-muted-foreground">{row.label}</span>
        <div class="flex min-w-0 items-center gap-1" data-keyframe-row={row.property}>
          <input class={input} type="number" min={row.min} max={row.max} step={row.step} placeholder={String(row.value)} aria-label={row.label} {disabled} value={shown(row)} onchange={(e) => animatable(row, e.currentTarget.value)} data-field={row.property} />
          <button
            type="button"
            class="shrink-0 rounded px-1 disabled:opacity-50 {row.onKey ? 'text-amber-500' : row.keyed ? 'text-foreground' : 'text-muted-foreground'}"
            aria-label="{row.onKey ? 'Remove' : 'Add'} {row.label.toLowerCase()} keyframe at playhead"
            aria-pressed={row.onKey}
            title={row.keyed ? `${row.keys} key${row.keys === 1 ? '' : 's'}; ${row.onKey ? 'remove the one' : 'add one'} at the playhead` : 'Animate: add a key at the playhead'}
            {disabled}
            onclick={() => toggleKey(row)}
            data-keyframe-toggle={row.property}>{row.onKey ? '◆' : '◇'}</button
          >
          {#if row.keyed}<span class="shrink-0 text-[10px] tabular-nums text-muted-foreground" data-keyframe-count={row.property}>{row.keys}</span>{/if}
        </div>
      {/each}
      {#if clip.type === 'media'}
        <span class="text-muted-foreground">Speed</span>
        {#if clip.timeRemap}
          <span class="flex items-center gap-1" data-ramped="">
            <span class="text-muted-foreground">ramped</span>
            <button type="button" class={btn} {disabled} onclick={() => clip && apply({ op: 'set_time_remap', clip: clip.id, keys: null, ripple: true }, 'Remove speed ramp')}>Remove ramp</button>
          </span>
        {:else}
          <input class={input} type="number" min="0.05" step="0.05" placeholder="1" aria-label="Speed" {disabled} value={clip.speed ?? ''} onchange={(e) => number('speed', e.currentTarget.value, 'Change speed', { above: 0, what: 'Speed must be a number above 0 (1 = normal speed).' })} data-field="speed" />
        {/if}
        {#if editor.project.assets.find((a) => a.id === clip.asset)?.kind !== 'image'}
        <span class="text-muted-foreground">Retime</span>
        <span class="flex flex-wrap gap-1">
          <button type="button" class={btn} disabled={disabled || editor.time < clip.start || editor.time > clip.start + clip.duration} title="Hold the frame at the playhead for a second, pushing later clips along" onclick={() => clip?.type === 'media' && apply(videoFreezeFrameEdit(clip, editor.time - clip.start, 1000), 'Freeze frame')} data-action="freeze">Freeze 1 s here</button>
          <button type="button" class={btn} {disabled} title="Normal speed, then a glide into 0.3× slow motion" onclick={() => clip?.type === 'media' && apply(videoSpeedRampEdit(clip, videoSlowMotionRamp(clip.duration)), 'Speed ramp')} data-action="slow-mo">Slow-mo ramp</button>
        </span>
        {/if}
        <span class="text-muted-foreground">Muted</span>
        <input type="checkbox" class="justify-self-start" aria-label="Muted" {disabled} checked={!!clip.muted} onchange={(e) => set('muted', e.currentTarget.checked || undefined, e.currentTarget.checked ? 'Mute clip' : 'Unmute clip')} data-field="muted" />
        {#each [{ key: 'fadeInCurve', on: clip.fadeIn, label: 'Fade in sound', aria: 'Fade in curve', change: 'Change fade in curve' }, { key: 'fadeOutCurve', on: clip.fadeOut, label: 'Fade out sound', aria: 'Fade out curve', change: 'Change fade out curve' }] as const as row (row.key)}
          {#if row.on}
            <span class="text-muted-foreground">{row.label}</span>
            <select class={input} aria-label={row.aria} {disabled} value={clip[row.key] ?? 'linear'} onchange={(e) => set(row.key, e.currentTarget.value === 'linear' ? undefined : e.currentTarget.value, row.change)} data-field={row.key}>
              {#each VIDEO_FADE_CURVES as c (c)}
                <option value={c}>{VIDEO_FADE_CURVE_LABELS[c]}</option>
              {/each}
            </select>
          {/if}
        {/each}
      {:else if clip.type === 'text'}
        <span class="text-muted-foreground">Text</span>
        <textarea class={input} rows="2" aria-label="Text" {disabled} value={clip.text} onchange={(e) => text('text', e.currentTarget.value, 'Change text', true)} data-field="text"></textarea>
        <span class="text-muted-foreground">Colour</span>
        <input class={input} placeholder="white" aria-label="Text colour" {disabled} value={clip.color ?? ''} onchange={(e) => text('color', e.currentTarget.value, 'Change text colour')} data-field="color" />
        <span class="text-muted-foreground">Font size</span>
        <input class={input} type="number" min="1" step="1" placeholder="64" aria-label="Font size" {disabled} value={clip.fontSize ?? ''} onchange={(e) => number('fontSize', e.currentTarget.value, 'Change font size', { above: 0, what: 'Font size must be a number of pixels above 0.' })} data-field="fontSize" />
        <span class="text-muted-foreground">Background</span>
        <input class={input} placeholder="none" aria-label="Text background" {disabled} value={clip.background ?? ''} onchange={(e) => text('background', e.currentTarget.value, 'Change text background')} data-field="background" />
      {:else if clip.type === 'sequence'}
        {@const sequence = editor.project.sequences?.find((q) => q.id === clip.sequence)}
        <span class="text-muted-foreground">Sequence</span>
        <span class="truncate" title="A compound clip plays its sequence as one picture and sound; its clips cannot be edited here yet" data-field="sequence">{sequence?.name ?? clip.sequence} · from {formatVideoSeconds(clip.in ?? 0)}</span>
        <span class="text-muted-foreground">Muted</span>
        <input type="checkbox" class="justify-self-start" aria-label="Muted" {disabled} checked={!!clip.muted} onchange={(e) => set('muted', e.currentTarget.checked || undefined, e.currentTarget.checked ? 'Mute clip' : 'Unmute clip')} data-field="muted" />
      {:else if clip.type === 'effect'}
        <span class="text-muted-foreground">Effect</span>
        <span class="truncate" title="Change its controls in the Effects panel" data-field="effect">{clip.name ?? clip.effect}</span>
      {:else if clip.type === 'color'}
        <span class="text-muted-foreground">Colour</span>
        <input class={input} aria-label="Clip colour" {disabled} value={clip.color} onchange={(e) => text('color', e.currentTarget.value, 'Change colour', true)} data-field="color" />
      {/if}
      <span class="text-muted-foreground">Transition</span>
      <div class="flex items-center gap-1">
        <select class={input} aria-label="Transition" {disabled} value={clip.transition?.type ?? ''} onchange={(e) => setTransition(e.currentTarget.value)} data-field="transition">
          <option value="">none</option>
          {#each VIDEO_TRANSITION_TYPES.filter((t) => t !== 'effect' || clip?.transition?.type === 'effect') as t (t)}
            <option value={t}>{t === 'effect' ? `Effect: ${clip.transition?.effect?.name ?? clip.transition?.effect?.effect}` : VIDEO_TRANSITION_LABELS[t]}</option>
          {/each}
        </select>
        {#if clip.transition}
          <input class="{input} w-20" type="number" min="1" step="50" aria-label="Transition duration" {disabled} value={clip.transition.duration} onchange={(e) => transitionDuration(e.currentTarget.value)} data-field="transitionDuration" />
          <span class="text-[10px] text-muted-foreground">ms</span>
        {/if}
      </div>
      {#if clip.transition && videoTransitionHasDirection(clip.transition.type)}
        <span class="text-muted-foreground">Direction</span>
        <select class={input} aria-label="Transition direction" {disabled} value={clip.transition.direction ?? 'right'} onchange={(e) => clip?.transition && apply({ op: 'set_transition', clip: clip.id, transition: { ...clip.transition, direction: e.currentTarget.value as VideoWipeDirection } }, 'Change transition direction')} data-field="transitionDirection">
          {#each VIDEO_WIPE_DIRECTIONS as d (d)}
            <option value={d}>{d}</option>
          {/each}
        </select>
      {/if}
      {#if clip.transition}
        <span class="text-muted-foreground">Transition sound</span>
        <select class={input} aria-label="Transition sound curve" {disabled} value={videoTransitionAudioCurve(clip.transition)} onchange={(e) => transitionAudioCurve(e.currentTarget.value)} data-field="transitionAudioCurve">
          {#each VIDEO_FADE_CURVES as c (c)}
            <option value={c}>{VIDEO_FADE_CURVE_LABELS[c]}</option>
          {/each}
        </select>
      {/if}
    </div>
  {/if}
  {#if message}
    <p class="text-red-500" role="alert" data-edit-error="">{message}</p>
  {/if}
</div>
