<script lang="ts">
  import { fitMotionSceneEdits, formatMotionDrivers, formatMotionNarration, parseMotionDrivers, parseMotionNarration, type AnimationEditorController, type MotionEdit, type MotionTrigger } from '@pixerate/editor/animation-editor';
  import { animationEditorStateOf } from './createAnimationEditor.svelte.js';

  interface Props {
    controller: AnimationEditorController;
    class?: string;
  }

  type Settings = Omit<Extract<MotionEdit, { op: 'set_settings' }>, 'op'>;

  let { controller, class: className = '' }: Props = $props();
  const view = animationEditorStateOf(() => controller);
  const editor = $derived(view.current);
  const scene = $derived(editor.scene);
  const beat = $derived(scene.beat);
  const target = $derived(scene.target);
  const narration = $derived(formatMotionNarration(scene.narration));
  const drivers = $derived(formatMotionDrivers(scene.drivers));
  let localError = $state<{ text: string; revision: number } | null>(null);
  let fitTo = $state('');
  const fitSeconds = $derived(fitTo || String(target ? (target[0] + target[1]) / 2 : Math.round(editor.duration / 100) / 10));
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
  const settings = (set: Settings, label: string) => apply({ op: 'set_settings', ...set }, label);
  function num(raw: string, what: string, ok: (n: number) => boolean, then: (n: number | null) => void) {
    if (raw.trim() === '') return then(null);
    const n = Number(raw);
    if (!Number.isFinite(n) || !ok(n)) {
      setLocal(what);
      return;
    }
    then(n);
  }
  function setTarget(i: 0 | 1, raw: string) {
    num(raw, 'Target lengths are seconds, 0 or more.', (n) => n >= 0, (n) => {
      if (n === null) return settings({ target: null }, 'Clear target length');
      const next: [number, number] = target ? [target[0], target[1]] : [n, n];
      next[i] = n;
      if (next[0] > next[1]) {
        setLocal('The shortest target length must not be longer than the longest.');
        return;
      }
      settings({ target: next }, 'Change target length');
    });
  }
  function fit() {
    const s = Number(fitSeconds);
    if (!(Number.isFinite(s) && s > 0)) {
      setLocal('Give the length to fit in seconds, above 0.');
      return;
    }
    try {
      const edits = fitMotionSceneEdits(scene, s * 1000);
      if (edits.length) apply(edits, `Fit to ${s} s`);
      else setLocal(null);
    } catch (e) {
      setLocal((e as Error).message);
    }
  }
  function setDrivers(text: string) {
    if (text === drivers) return;
    const parsed = parseMotionDrivers(text);
    if ('error' in parsed) {
      setLocal(parsed.error);
      return;
    }
    apply({ op: 'set_drivers', drivers: parsed.drivers }, parsed.drivers.length ? 'Set drivers' : 'Clear drivers');
  }
  function setNarration(text: string) {
    if (text === narration) return;
    const parsed = parseMotionNarration(text);
    if ('error' in parsed) {
      setLocal(parsed.error);
      return;
    }
    settings({ narration: parsed.narration }, parsed.narration ? 'Change narration' : 'Clear narration');
  }
</script>

<!--
  Scene settings: loop, frame rate, stepped time, the wanted length with a Fit button
  (fitMotionScene, as fit_animation does), a beat grid and narration words to cue shots to.
-->
<div class="flex flex-col gap-1.5 text-xs {className}" data-scene-settings="">
  <div class="grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1">
    <span class="text-muted-foreground">Loop</span>
    <select class={input} aria-label="Scene loop" disabled={editor.readOnly} value={scene.loop ?? 'none'} onchange={(e) => settings({ loop: e.currentTarget.value as 'none' }, 'Change loop')}>
      <option value="none">Off</option>
      <option value="loop">Loop</option>
      <option value="ping-pong">Ping-pong</option>
    </select>
    <span class="text-muted-foreground">Plays on</span>
    <select class={input} aria-label="Scene trigger" title="How a viewer plays it when exported to Flair" disabled={editor.readOnly} value={scene.trigger ?? ''} onchange={(e) => settings({ trigger: (e.currentTarget.value || null) as MotionTrigger | null }, 'Change trigger')}>
      <option value="">Its own (autoplay)</option>
      <option value="click">Click (a shot per click)</option>
      <option value="hover">Hover</option>
      <option value="press">Press</option>
      <option value="scroll">Scroll</option>
    </select>
    <span class="text-muted-foreground">Frame rate</span>
    <div class="flex items-center gap-1">
      <input class={input} type="number" min="1" max="120" aria-label="Frame rate" placeholder="30" disabled={editor.readOnly} value={scene.fps ?? ''}
        onchange={(e) => num(e.currentTarget.value, 'Frame rate must be 1 to 120 fps.', (n) => n >= 1 && n <= 120, (n) => n !== null && settings({ fps: n }, 'Change frame rate'))} />
      <span class="shrink-0 text-[10px] text-muted-foreground">fps</span>
    </div>
    <span class="text-muted-foreground" title="Hold changes on a grid of this many frames a second (12 = on twos); empty is smooth">Steps</span>
    <div class="flex items-center gap-1">
      <input class={input} type="number" min="1" max="120" aria-label="Steps" placeholder="smooth" disabled={editor.readOnly} value={scene.steps ?? ''}
        onchange={(e) => num(e.currentTarget.value, 'Steps must be above 0 and at most 120 fps, or empty for smooth.', (n) => n > 0 && n <= 120, (n) => settings({ steps: n }, 'Change steps'))} />
      <span class="shrink-0 text-[10px] text-muted-foreground">fps</span>
    </div>
    <span class="text-muted-foreground">Target length</span>
    <div class="flex items-center gap-1">
      <input class={input} type="number" min="0" step="0.5" aria-label="Target min" placeholder="min" disabled={editor.readOnly} value={target ? target[0] : ''} onchange={(e) => setTarget(0, e.currentTarget.value)} />
      <input class={input} type="number" min="0" step="0.5" aria-label="Target max" placeholder="max" disabled={editor.readOnly} value={target ? target[1] : ''} onchange={(e) => setTarget(1, e.currentTarget.value)} />
      <span class="shrink-0 text-[10px] text-muted-foreground">s</span>
    </div>
    <span class="text-muted-foreground">Fit to</span>
    <div class="flex items-center gap-1">
      <input class={input} type="number" min="0.1" step="0.5" aria-label="Fit to" value={fitSeconds} oninput={(e) => (fitTo = e.currentTarget.value)} />
      <span class="shrink-0 text-[10px] text-muted-foreground">s</span>
      <button type="button" class={btn} disabled={editor.readOnly || !scene.shots.length} onclick={fit} data-fit="" title="Change the shots' speeds so the scene lasts this long">Fit</button>
    </div>
    <span class="text-muted-foreground">Beat grid</span>
    <div class="flex items-center gap-1" data-beat-grid="">
      <input class={input} type="number" min="1" aria-label="BPM" placeholder="bpm" disabled={editor.readOnly} value={beat ? beat.bpm : ''}
        onchange={(e) => num(e.currentTarget.value, 'BPM must be above 0.', (n) => n > 0, (n) => settings({ beat: n === null ? null : { ...(beat ?? {}), bpm: n } }, n === null ? 'Clear beat grid' : 'Change tempo'))} />
      <input class={input} type="number" aria-label="Beat offset" placeholder="offset ms" disabled={editor.readOnly || !beat} value={beat?.offset ?? ''}
        onchange={(e) => beat && num(e.currentTarget.value, 'The offset is a number of ms.', () => true, (n) => settings({ beat: { ...beat, offset: n ?? 0 } }, 'Change beat offset'))} />
      <input class={input} type="number" min="1" step="1" aria-label="Meter" placeholder="4/bar" disabled={editor.readOnly || !beat} value={beat?.meter ?? ''}
        onchange={(e) => beat && num(e.currentTarget.value, 'The meter is a whole number of beats a bar.', (n) => Number.isInteger(n) && n >= 1, (n) => settings({ beat: { ...beat, meter: n ?? 4 } }, 'Change meter'))} />
    </div>
  </div>
  <label class="flex flex-col gap-0.5">
    <span class="text-muted-foreground">Narration (a word a line: start ms, then the word)</span>
    <textarea class="{input} h-20 font-mono" aria-label="Narration" placeholder={'0 Meet\n320 the\n480 badge'} disabled={editor.readOnly} value={narration} onchange={(e) => setNarration(e.currentTarget.value)}></textarea>
  </label>
  <label class="flex flex-col gap-0.5">
    <span class="text-muted-foreground">Drivers (one a line: target.property &lt;- source.property * factor)</span>
    <textarea class="{input} h-14 font-mono" aria-label="Drivers" placeholder={'back.x <- front.x * 0.5\nwheel.rotation <- wheel.x * 2.86'} disabled={editor.readOnly} value={drivers} onchange={(e) => setDrivers(e.currentTarget.value)}></textarea>
  </label>
  {#if message}
    <p class="text-red-500" role="alert" data-edit-error="">{message}</p>
  {/if}
</div>
