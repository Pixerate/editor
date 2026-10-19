import React, { useMemo } from 'react';
import { MOTION_EASE_CHOICES, motionEaseKey, motionEasingCurve, motionEasingGuides, motionEasingPath, type MotionCommandBase } from '@pixerate/editor/animation-editor';

/** An easing (a preset name or a curve), as commands take it. */
type AnimationEasing = NonNullable<MotionCommandBase['ease']>;

export interface EasePickerProps {
  /** The easing (undefined: the command type's default). */
  value: AnimationEasing | undefined;
  /** Called with the picked preset, or undefined for the default. */
  onChange: (ease: AnimationEasing | undefined) => void;
  disabled?: boolean;
  className?: string;
}

const W = 72;
const H = 44;

/**
 * Picks an easing preset (springs included) and previews its curve, drawn by sampling
 * `evaluateEasing`; a spring is drawn over the time it takes to settle, overshoot included.
 */
export function EasePicker({ value, onChange, disabled, className = '' }: EasePickerProps) {
  const key = motionEaseKey(value);
  const curve = useMemo(() => motionEasingCurve(value ?? 'ease-out'), [value]);
  const guides = motionEasingGuides(curve, H);
  const spring = typeof value === 'string' ? value.startsWith('spring') : value?.type === 'spring';
  return (
    <div className={`flex items-center gap-2 ${className}`} data-ease-picker="">
      <select
        className="min-w-0 flex-1 rounded border border-border bg-transparent px-1 py-0.5 text-xs"
        aria-label="Ease"
        value={key}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value === 'custom') return;
          onChange(e.target.value ? (e.target.value as AnimationEasing) : undefined);
        }}
      >
        {MOTION_EASE_CHOICES.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
        {key === 'custom' && <option value="custom">Custom</option>}
      </select>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0 rounded border border-border" data-ease-curve={key || 'default'} aria-hidden="true">
        <line x1={0} x2={W} y1={guides.zero} y2={guides.zero} stroke="currentColor" strokeOpacity={0.2} />
        <line x1={0} x2={W} y1={guides.one} y2={guides.one} stroke="currentColor" strokeOpacity={0.2} strokeDasharray="2 2" />
        <path d={motionEasingPath(curve, W, H)} fill="none" stroke="#f43f5e" strokeWidth={1.5} />
      </svg>
      {spring && <span className="text-[10px] tabular-nums text-muted-foreground">{Math.round(curve.durationMs)} ms</span>}
    </div>
  );
}
