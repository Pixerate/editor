import React, { useEffect, useRef, useState } from 'react';
import type { SliderControl } from '@pixerate/editor/paint-editor';

export const chip = (on: boolean) => `px-2 py-1 rounded text-[11px] ${on ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:text-white'}`;
export const button = 'px-2 py-1 rounded text-[11px] bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-40';
export const panel = 'flex flex-col gap-2 text-xs text-slate-200';

/** Draws RGBA pixels into a canvas (nothing without a 2D context, as in jsdom). */
export const PixelCanvas: React.FC<{ pixels: { width: number; height: number; data: Uint8ClampedArray } | null; label: string; className?: string; style?: React.CSSProperties }> = ({ pixels, label, className, style }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !pixels || typeof ctx.createImageData !== 'function') return;
    canvas.width = pixels.width;
    canvas.height = pixels.height;
    const img = ctx.createImageData(pixels.width, pixels.height);
    img.data.set(pixels.data);
    ctx.putImageData(img, 0, 0);
  }, [pixels]);
  return <canvas ref={ref} role="img" aria-label={label} className={className} style={style} width={pixels?.width} height={pixels?.height} />;
};

const fmt = (c: SliderControl, v: number) => (c.step >= 1 ? String(Math.round(v)) : v.toFixed(2));

/**
 * A labelled range input. `onChange` runs while dragging; `onCommit` (if given) runs once on
 * release (the native `change` event), for settings that are undo steps.
 */
export const PaintSlider: React.FC<{ control: SliderControl; value: number; onChange?: (v: number) => void; onCommit?: (v: number) => void }> = ({ control, value, onChange, onCommit }) => {
  const [draft, setDraft] = useState<number | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const done = () => {
      commit.current?.(Number(el.value));
      setDraft(null);
    };
    el.addEventListener('change', done);
    return () => el.removeEventListener('change', done);
  }, []);
  const shown = draft ?? value;
  return (
    <label className="flex flex-col gap-0.5" data-path={control.path}>
      <span className="flex justify-between text-slate-400">
        <span>{control.label}</span>
        <span className="font-mono">{fmt(control, shown)}</span>
      </span>
      <input
        ref={ref}
        type="range"
        aria-label={control.label}
        min={control.min}
        max={control.max}
        step={control.step}
        value={shown}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (onCommit) setDraft(v);
          onChange?.(v);
        }}
        className="w-full accent-indigo-500"
      />
    </label>
  );
};

/** Runs `fn`, turning a thrown error into a message. */
export function useAttempt(): [string | null, (fn: () => unknown) => void, (msg: string | null) => void] {
  const [error, setError] = useState<string | null>(null);
  const attempt = (fn: () => unknown) => {
    try {
      setError(null);
      const r = fn();
      if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return [error, attempt, setError];
}

export const ErrorLine: React.FC<{ error: string | null }> = ({ error }) =>
  error ? (
    <p role="alert" className="text-[11px] text-rose-400">
      {error}
    </p>
  ) : null;

/** A colour input that commits once when the picker closes (the native `change` event). */
export const CommitColorInput: React.FC<{ value: string; label: string; onCommit: (v: string) => void; className?: string }> = ({ value, label, onCommit, className }) => {
  const ref = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const done = () => commit.current(el.value);
    el.addEventListener('change', done);
    return () => el.removeEventListener('change', done);
  }, []);
  return <input ref={ref} type="color" aria-label={label} defaultValue={value} key={value} className={className} />;
};
