import React from 'react';
import {
  findVideoClip,
  formatVideoSeconds,
  VIDEO_CLIP_ANIMATION_EFFECTS,
  VIDEO_CLIP_ANIMATION_LABELS,
  normalizeVideoGrade,
  VIDEO_GRADE_CONTROLS,
  VIDEO_GRADE_PRESET_NAMES,
  videoGradePreset,
  VIDEO_BLEND_MODE_LABELS,
  VIDEO_BLEND_MODES,
  VIDEO_FADE_CURVE_LABELS,
  VIDEO_FADE_CURVES,
  VIDEO_TRANSITION_LABELS,
  VIDEO_TRANSITION_TYPES,
  VIDEO_WIPE_DIRECTIONS,
  videoTransitionHasDirection,
  videoKeyframeRows,
  videoTransitionAudioCurve,
  videoKeyframeToggleEdit,
  videoKeyframeValueEdit,
  type VideoClip,
  type VideoClipAnimationEffect,
  type VideoEditorController,
  type VideoFadeCurve,
  type VideoGradePreset,
  type VideoTransitionType,
  type VideoWipeDirection,
} from '@pixerate/editor/video-editor';
import { useVideoEditorState } from './useVideoEditor';

export interface ClipInspectorProps {
  controller: VideoEditorController;
  className?: string;
}

const field = 'w-full rounded border border-border bg-transparent px-1 py-0.5 text-xs disabled:opacity-50';
const DEFAULT_TRANSITION = 500;

/** An input (or textarea) that commits on blur or Enter, and resets when its value changes from outside. */
function Commit({
  value,
  onCommit,
  multiline,
  ...rest
}: { value: string; onCommit: (raw: string) => void; multiline?: boolean } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue'>) {
  const commit = (raw: string) => {
    if (raw !== value) onCommit(raw);
  };
  if (multiline)
    return (
      <textarea
        key={value}
        className={field}
        rows={2}
        defaultValue={value}
        disabled={rest.disabled}
        aria-label={rest['aria-label']}
        onBlur={(e) => commit(e.currentTarget.value)}
      />
    );
  return <input key={value} className={field} {...rest} defaultValue={value} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} onBlur={(e) => commit(e.currentTarget.value)} />;
}

function Row({ label, name, children }: { label: string; name: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2 text-xs" data-field={name}>
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/**
 * Edits the one selected clip: its name, fades, opacity, volume and transform (each with a keyframe
 * toggle at the playhead: ◆ adds a key holding the value there or removes the one there; typing a
 * value on a keyed property sets the key at the playhead); volume, speed and mute for media;
 * text, colour, size and background for titles; colour for colour clips; and the transition into
 * it. Each change is one undo step (`update_clip` / `set_transition`), committed on blur or change.
 */
export function ClipInspector({ controller, className = '' }: ClipInspectorProps) {
  const state = useVideoEditorState(controller);
  const { project, selection, readOnly, time } = state;
  if (selection.length !== 1)
    return (
      <p className={`text-xs text-muted-foreground ${className}`} data-clip-inspector="">
        {selection.length ? `${selection.length} clips selected. Select one clip to edit it.` : 'Select a clip on the timeline to edit it.'}
      </p>
    );
  const at = findVideoClip(project, selection[0]);
  if (!at) return null;
  const clip: VideoClip = at.clip;
  const disabled = readOnly || !!at.track.locked;

  const set = (key: string, value: unknown, label = `Change ${key}`) => {
    if (value === undefined || value === '') controller.apply({ op: 'update_clip', clip: clip.id, remove: [key] }, label);
    else controller.apply({ op: 'update_clip', clip: clip.id, set: { [key]: value } }, label);
  };
  const num = (key: string, raw: string, label?: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return set(key, undefined, label);
    const n = Number(trimmed);
    if (Number.isFinite(n)) set(key, n, label);
  };
  const text = (key: string, label?: string) => {
    const value = (clip as unknown as Record<string, unknown>)[key];
    return (
      <Commit value={value === undefined ? '' : String(value)} aria-label={label ?? key} disabled={disabled} onCommit={(raw) => set(key, raw.trim() || undefined, `Change ${label ?? key}`)} />
    );
  };
  const number = (key: string, label: string, attrs: { min?: number; max?: number; step?: number } = {}) => {
    const value = (clip as unknown as Record<string, unknown>)[key];
    return <Commit type="number" value={value === undefined ? '' : String(value)} aria-label={label} disabled={disabled} onCommit={(raw) => num(key, raw, `Change ${label.toLowerCase()}`)} {...attrs} />;
  };

  const transition = clip.transition;
  return (
    <div className={`flex flex-col gap-1.5 ${className}`} data-clip-inspector="" data-clip-id={clip.id}>
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium">{clip.type === 'media' ? 'Media clip' : clip.type === 'text' ? 'Title' : 'Colour clip'}</span>
        <code className="text-muted-foreground">{clip.id}</code>
        {at.track.locked && <span className="text-amber-500">locked track</span>}
      </div>
      <Row label="Name" name="name">
        {text('name', 'Name')}
      </Row>
      <Row label="Start" name="start">
        <span className="tabular-nums text-xs">{formatVideoSeconds(clip.start)}</span>
      </Row>
      <Row label="Duration" name="duration">
        <span className="tabular-nums text-xs">{formatVideoSeconds(clip.duration)}</span>
      </Row>
      {videoKeyframeRows(project, clip.id, time).map((row) => (
        <Row key={row.property} label={row.label} name={row.property}>
          <span className="flex min-w-0 items-center gap-1" data-keyframe-row={row.property}>
            <Commit
              type="number"
              value={row.keyed || (row.property === 'opacity' ? clip.opacity : row.property === 'volume' ? (clip as { volume?: unknown }).volume : clip.transform?.[row.property]) !== undefined ? String(row.value) : ''}
              placeholder={String(row.value)}
              aria-label={row.label}
              disabled={disabled}
              min={row.min}
              max={row.max}
              step={row.step}
              onCommit={(raw) => {
                const n = Number(raw);
                if (raw.trim() && !Number.isFinite(n)) return;
                const edit = videoKeyframeValueEdit(project, clip.id, row.property, time, raw.trim() ? n : undefined);
                if (edit) controller.apply(edit, row.keyed ? `Keyframe ${row.label.toLowerCase()}` : `Change ${row.label.toLowerCase()}`);
              }}
            />
            <button
              type="button"
              className={`shrink-0 rounded px-1 text-xs disabled:opacity-50 ${row.onKey ? 'text-amber-500' : row.keyed ? 'text-foreground' : 'text-muted-foreground'}`}
              aria-label={`${row.onKey ? 'Remove' : 'Add'} ${row.label.toLowerCase()} keyframe at playhead`}
              aria-pressed={row.onKey}
              title={row.keyed ? `${row.keys} key${row.keys === 1 ? '' : 's'}; ${row.onKey ? 'remove the one' : 'add one'} at the playhead` : 'Animate: add a key at the playhead'}
              disabled={disabled}
              data-keyframe-toggle={row.property}
              onClick={() => {
                const edit = videoKeyframeToggleEdit(project, clip.id, row.property, time);
                if (edit) controller.apply(edit, `${row.onKey ? 'Remove' : 'Add'} ${row.label.toLowerCase()} keyframe`);
              }}
            >
              {row.onKey ? '◆' : '◇'}
            </button>
            {row.keyed && (
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground" data-keyframe-count={row.property}>
                {row.keys}
              </span>
            )}
          </span>
        </Row>
      ))}
      {at.track.kind === 'video' && (
        <Row label="Blend" name="blend">
          <select className={field} value={clip.blend ?? 'normal'} disabled={disabled} aria-label="Blend mode" onChange={(e) => set('blend', e.target.value === 'normal' ? undefined : e.target.value, 'Change blend mode')}>
            {VIDEO_BLEND_MODES.map((m) => (
              <option key={m} value={m}>
                {VIDEO_BLEND_MODE_LABELS[m]}
              </option>
            ))}
          </select>
        </Row>
      )}
      {at.track.kind === 'video' && (
        <>
          <Row label="Look" name="gradePreset">
            <select
              className={field}
              value=""
              disabled={disabled}
              aria-label="Apply a look"
              onChange={(e) => {
                const grade = videoGradePreset(e.target.value as VideoGradePreset);
                if (grade) controller.apply({ op: 'update_clip', clip: clip.id, set: { grade } }, `Apply ${e.target.value} look`);
              }}
            >
              <option value="">{clip.grade ? 'Graded' : 'None'}</option>
              {VIDEO_GRADE_PRESET_NAMES.map((name) => (
                <option key={name} value={name}>
                  {name.replace(/-/g, ' ')}
                </option>
              ))}
            </select>
          </Row>
          {VIDEO_GRADE_CONTROLS.map((c) => (
            <Row key={c.key} label={c.label} name={`grade.${c.key}`}>
              <Commit
                type="number"
                min={c.min}
                max={c.max}
                step={c.step}
                value={clip.grade?.[c.key] === undefined ? '' : String(clip.grade[c.key])}
                placeholder="0"
                aria-label={c.label}
                disabled={disabled}
                onCommit={(raw) => {
                  const n = raw.trim() ? Number(raw) : 0;
                  if (!Number.isFinite(n)) return;
                  // Out-of-range values are clamped to the control's range.
                  const grade = normalizeVideoGrade({ ...clip.grade, [c.key]: n });
                  set('grade', grade, `Change ${c.label.toLowerCase()}`);
                }}
              />
            </Row>
          ))}
        </>
      )}
      {at.track.kind === 'video' &&
        (['animateIn', 'animateOut'] as const).map((key) => (
          <Row key={key} label={key === 'animateIn' ? 'Animate in' : 'Animate out'} name={key}>
            <select
              className={field}
              value={clip[key]?.effect ?? ''}
              disabled={disabled}
              aria-label={key === 'animateIn' ? 'Animate in' : 'Animate out'}
              onChange={(e) => {
                const effect = e.target.value as VideoClipAnimationEffect | '';
                set(key, effect ? { ...clip[key], effect } : undefined, key === 'animateIn' ? 'Change entrance' : 'Change exit');
              }}
            >
              <option value="">None</option>
              {VIDEO_CLIP_ANIMATION_EFFECTS.map((effect) => (
                <option key={effect} value={effect}>
                  {VIDEO_CLIP_ANIMATION_LABELS[effect]}
                </option>
              ))}
            </select>
          </Row>
        ))}
      <Row label="Fade in (ms)" name="fadeIn">
        {number('fadeIn', 'Fade in', { min: 0, step: 100 })}
      </Row>
      <Row label="Fade out (ms)" name="fadeOut">
        {number('fadeOut', 'Fade out', { min: 0, step: 100 })}
      </Row>
      {clip.type === 'media' && (
        <>
          <Row label="Speed" name="speed">
            {number('speed', 'Speed', { min: 0.1, step: 0.25 })}
          </Row>
          <Row label="Muted" name="muted">
            <input type="checkbox" className="justify-self-start" checked={!!clip.muted} disabled={disabled} aria-label="Muted" onChange={(e) => set('muted', e.target.checked || undefined, e.target.checked ? 'Mute clip' : 'Unmute clip')} />
          </Row>
          {(['fadeInCurve', 'fadeOutCurve'] as const).map((key) =>
            (key === 'fadeInCurve' ? clip.fadeIn : clip.fadeOut) ? (
              <Row key={key} label={key === 'fadeInCurve' ? 'Fade in sound' : 'Fade out sound'} name={key}>
                <select
                  className={field}
                  value={clip[key] ?? 'linear'}
                  disabled={disabled}
                  aria-label={key === 'fadeInCurve' ? 'Fade in curve' : 'Fade out curve'}
                  onChange={(e) => {
                    const curve = e.target.value as VideoFadeCurve;
                    set(key, curve === 'linear' ? undefined : curve, key === 'fadeInCurve' ? 'Change fade in curve' : 'Change fade out curve');
                  }}
                >
                  {VIDEO_FADE_CURVES.map((c) => (
                    <option key={c} value={c}>
                      {VIDEO_FADE_CURVE_LABELS[c]}
                    </option>
                  ))}
                </select>
              </Row>
            ) : null,
          )}
        </>
      )}
      {clip.type === 'text' && (
        <>
          <Row label="Text" name="text">
            <Commit multiline value={clip.text} aria-label="Text" disabled={disabled} onCommit={(raw) => set('text', raw, 'Change text')} />
          </Row>
          <Row label="Colour" name="color">
            {text('color', 'Colour')}
          </Row>
          <Row label="Font size" name="fontSize">
            {number('fontSize', 'Font size', { min: 1, step: 2 })}
          </Row>
          <Row label="Background" name="background">
            {text('background', 'Background')}
          </Row>
        </>
      )}
      {clip.type === 'color' && (
        <Row label="Colour" name="color">
          <Commit value={clip.color} aria-label="Colour" disabled={disabled} onCommit={(raw) => raw.trim() && set('color', raw.trim(), 'Change colour')} />
        </Row>
      )}
      <Row label="Transition in" name="transition">
        <select
          className={field}
          value={transition?.type ?? ''}
          disabled={disabled}
          aria-label="Transition"
          onChange={(e) => {
            const type = e.target.value as VideoTransitionType | '';
            controller.apply(
              { op: 'set_transition', clip: clip.id, transition: type ? { ...transition, type, duration: transition?.duration ?? DEFAULT_TRANSITION } : null },
              type ? 'Set transition' : 'Remove transition',
            );
          }}
        >
          <option value="">None</option>
          {VIDEO_TRANSITION_TYPES.map((t) => (
            <option key={t} value={t}>
              {VIDEO_TRANSITION_LABELS[t]}
            </option>
          ))}
        </select>
      </Row>
      {transition && (
        <Row label="Length (ms)" name="transitionDuration">
          <Commit
            type="number"
            min={1}
            step={100}
            value={String(transition.duration)}
            aria-label="Transition length"
            disabled={disabled}
            onCommit={(raw) => {
              const n = Number(raw);
              if (raw.trim() && Number.isFinite(n) && n > 0) controller.apply({ op: 'set_transition', clip: clip.id, transition: { ...transition, duration: n } }, 'Change transition length');
            }}
          />
        </Row>
      )}
      {transition && videoTransitionHasDirection(transition.type) && (
        <Row label="Direction" name="transitionDirection">
          <select
            className={field}
            value={transition.direction ?? 'right'}
            disabled={disabled}
            aria-label="Transition direction"
            onChange={(e) => controller.apply({ op: 'set_transition', clip: clip.id, transition: { ...transition, direction: e.target.value as VideoWipeDirection } }, 'Change transition direction')}
          >
            {VIDEO_WIPE_DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </Row>
      )}
      {transition && (
        <Row label="Transition sound" name="transitionAudioCurve">
          <select
            className={field}
            value={videoTransitionAudioCurve(transition)}
            disabled={disabled}
            aria-label="Transition sound curve"
            onChange={(e) => {
              const { audioCurve: _, ...rest } = transition;
              const curve = e.target.value as VideoFadeCurve;
              // The type's own default is stored as no curve, so it follows the type if that changes.
              const next = curve === videoTransitionAudioCurve(rest) ? rest : { ...rest, audioCurve: curve };
              controller.apply({ op: 'set_transition', clip: clip.id, transition: next }, 'Change transition sound');
            }}
          >
            {VIDEO_FADE_CURVES.map((c) => (
              <option key={c} value={c}>
                {VIDEO_FADE_CURVE_LABELS[c]}
              </option>
            ))}
          </select>
        </Row>
      )}
    </div>
  );
}
