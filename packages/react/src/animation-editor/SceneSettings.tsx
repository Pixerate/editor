import React, { useState } from 'react';
import { fitMotionSceneEdits, formatMotionDrivers, formatMotionNarration, parseMotionDrivers, parseMotionNarration, type AnimationEditorController, type MotionEdit, type MotionTrigger } from '@pixerate/editor/animation-editor';
import { CommitInput } from './CommitInput';
import { useAnimationEditorState } from './useAnimationEditor';

export interface SceneSettingsProps {
  controller: AnimationEditorController;
  className?: string;
}

const input = 'w-full min-w-0 rounded border border-border bg-transparent px-1 py-0.5 text-xs';
const btn = 'rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-40';
const unit = (u: string) => <span className="shrink-0 text-[10px] text-muted-foreground">{u}</span>;

/**
 * Scene settings: loop, frame rate, stepped time, the wanted length with a Fit button (sets the
 * shots' speeds with `fitMotionScene`, as `fit_animation` does), a beat grid and narration words
 * to cue shots to. Every change is one undo step; refusals show their reason.
 */
export function SceneSettings({ controller, className = '' }: SceneSettingsProps) {
  const state = useAnimationEditorState(controller);
  const { scene, readOnly, error, duration } = state;
  const [local, setLocalState] = useState<{ text: string; revision: number } | null>(null);
  const setLocal = (text: string | null) => setLocalState(text ? { text, revision: state.revision } : null);
  const [fitTo, setFitTo] = useState<string>('');
  const apply = (edit: MotionEdit | MotionEdit[], label: string) => {
    setLocal(null);
    return controller.apply(edit, label);
  };
  const settings = (set: Omit<Extract<MotionEdit, { op: 'set_settings' }>, 'op'>, label: string) => apply({ op: 'set_settings', ...set }, label);
  const num = (raw: string, what: string, ok: (n: number) => boolean, then: (n: number | null) => void) => {
    if (raw.trim() === '') return then(null);
    const n = Number(raw);
    if (!Number.isFinite(n) || !ok(n)) return setLocal(what);
    then(n);
  };
  const target = scene.target;
  const fitSeconds = fitTo || String(target ? (target[0] + target[1]) / 2 : Math.round(duration / 100) / 10);
  const fit = () => {
    const s = Number(fitSeconds);
    if (!(Number.isFinite(s) && s > 0)) return setLocal('Give the length to fit in seconds, above 0.');
    try {
      const edits = fitMotionSceneEdits(scene, s * 1000);
      if (edits.length) apply(edits, `Fit to ${s} s`);
      else setLocal(null);
    } catch (e) {
      setLocal((e as Error).message);
    }
  };
  const beat = scene.beat;
  // A local error shows until the editor changes; then the editor's own error (if any) shows.
  const message = (local && local.revision === state.revision ? local.text : null) ?? error;

  return (
    <div className={`flex flex-col gap-1.5 text-xs ${className}`} data-scene-settings="">
      <div className="grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1">
        <label className="text-muted-foreground">Loop</label>
        <select className={input} aria-label="Scene loop" disabled={readOnly} value={scene.loop ?? 'none'} onChange={(e) => settings({ loop: e.target.value as 'none' }, 'Change loop')}>
          <option value="none">Off</option>
          <option value="loop">Loop</option>
          <option value="ping-pong">Ping-pong</option>
        </select>
        <label className="text-muted-foreground">Plays on</label>
        <select className={input} aria-label="Scene trigger" title="How a viewer plays it when exported to Flair" disabled={readOnly} value={scene.trigger ?? ''} onChange={(e) => settings({ trigger: (e.target.value || null) as MotionTrigger | null }, 'Change trigger')}>
          <option value="">Its own (autoplay)</option>
          <option value="click">Click (a shot per click)</option>
          <option value="hover">Hover</option>
          <option value="press">Press</option>
          <option value="scroll">Scroll</option>
        </select>
        <label className="text-muted-foreground">Frame rate</label>
        <div className="flex items-center gap-1">
          <CommitInput className={input} type="number" min={1} max={120} aria-label="Frame rate" placeholder="30" disabled={readOnly} value={scene.fps !== undefined ? String(scene.fps) : ''}
            onCommit={(raw) => num(raw, 'Frame rate must be 1 to 120 fps.', (n) => n >= 1 && n <= 120, (n) => n !== null && settings({ fps: n }, 'Change frame rate'))} />
          {unit('fps')}
        </div>
        <label className="text-muted-foreground" title="Hold changes on a grid of this many frames a second (12 = on twos); empty is smooth">
          Steps
        </label>
        <div className="flex items-center gap-1">
          <CommitInput className={input} type="number" min={1} max={120} aria-label="Steps" placeholder="smooth" disabled={readOnly} value={scene.steps !== undefined ? String(scene.steps) : ''}
            onCommit={(raw) => num(raw, 'Steps must be above 0 and at most 120 fps, or empty for smooth.', (n) => n > 0 && n <= 120, (n) => settings({ steps: n }, 'Change steps'))} />
          {unit('fps')}
        </div>
        <label className="text-muted-foreground">Target length</label>
        <div className="flex items-center gap-1">
          {[0, 1].map((i) => (
            <CommitInput key={i} className={input} type="number" min={0} step={0.5} aria-label={i ? 'Target max' : 'Target min'} placeholder={i ? 'max' : 'min'} disabled={readOnly} value={target ? String(target[i]) : ''}
              onCommit={(raw) =>
                num(raw, 'Target lengths are seconds, 0 or more.', (n) => n >= 0, (n) => {
                  if (n === null) return settings({ target: null }, 'Clear target length');
                  const next: [number, number] = target ? [...target] : [n, n];
                  next[i] = n;
                  if (next[0] > next[1]) return setLocal('The shortest target length must not be longer than the longest.');
                  settings({ target: next }, 'Change target length');
                })
              } />
          ))}
          {unit('s')}
        </div>
        <label className="text-muted-foreground">Fit to</label>
        <div className="flex items-center gap-1">
          <input className={input} type="number" min={0.1} step={0.5} aria-label="Fit to" value={fitSeconds} onChange={(e) => setFitTo(e.target.value)} />
          {unit('s')}
          <button type="button" className={btn} disabled={readOnly || !scene.shots.length} onClick={fit} data-fit="" title="Change the shots' speeds so the scene lasts this long">
            Fit
          </button>
        </div>
        <label className="text-muted-foreground">Beat grid</label>
        <div className="flex items-center gap-1" data-beat-grid="">
          <CommitInput className={input} type="number" min={1} aria-label="BPM" placeholder="bpm" disabled={readOnly} value={beat ? String(beat.bpm) : ''}
            onCommit={(raw) => num(raw, 'BPM must be above 0.', (n) => n > 0, (n) => settings({ beat: n === null ? null : { ...(beat ?? {}), bpm: n } }, n === null ? 'Clear beat grid' : 'Change tempo'))} />
          <CommitInput className={input} type="number" aria-label="Beat offset" placeholder="offset ms" disabled={readOnly || !beat} value={beat?.offset !== undefined ? String(beat.offset) : ''}
            onCommit={(raw) => beat && num(raw, 'The offset is a number of ms.', () => true, (n) => settings({ beat: { ...beat, offset: n ?? 0 } }, 'Change beat offset'))} />
          <CommitInput className={input} type="number" min={1} step={1} aria-label="Meter" placeholder="4/bar" disabled={readOnly || !beat} value={beat?.meter !== undefined ? String(beat.meter) : ''}
            onCommit={(raw) => beat && num(raw, 'The meter is a whole number of beats a bar.', (n) => Number.isInteger(n) && n >= 1, (n) => settings({ beat: { ...beat, meter: n ?? 4 } }, 'Change meter'))} />
        </div>
      </div>
      <label className="flex flex-col gap-0.5">
        <span className="text-muted-foreground">Narration (a word a line: start ms, then the word)</span>
        <textarea
          key={formatMotionNarration(scene.narration)}
          className={`${input} h-20 font-mono`}
          aria-label="Narration"
          placeholder={'0 Meet\n320 the\n480 badge'}
          disabled={readOnly}
          defaultValue={formatMotionNarration(scene.narration)}
          onBlur={(e) => {
            if (e.currentTarget.value === formatMotionNarration(scene.narration)) return;
            const parsed = parseMotionNarration(e.currentTarget.value);
            if ('error' in parsed) return setLocal(parsed.error);
            settings({ narration: parsed.narration }, parsed.narration ? 'Change narration' : 'Clear narration');
          }}
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-muted-foreground">Drivers (one a line: target.property &lt;- source.property * factor)</span>
        <textarea
          key={formatMotionDrivers(scene.drivers)}
          className={`${input} h-14 font-mono`}
          aria-label="Drivers"
          placeholder={'back.x <- front.x * 0.5\nwheel.rotation <- wheel.x * 2.86'}
          disabled={readOnly}
          defaultValue={formatMotionDrivers(scene.drivers)}
          onBlur={(e) => {
            if (e.currentTarget.value === formatMotionDrivers(scene.drivers)) return;
            const parsed = parseMotionDrivers(e.currentTarget.value);
            if ('error' in parsed) return setLocal(parsed.error);
            apply({ op: 'set_drivers', drivers: parsed.drivers }, parsed.drivers.length ? 'Set drivers' : 'Clear drivers');
          }}
        />
      </label>
      {message && (
        <p className="text-red-500" role="alert" data-edit-error="">
          {message}
        </p>
      )}
    </div>
  );
}
