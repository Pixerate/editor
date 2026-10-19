import React, { useMemo, useRef, useState } from 'react';
import {
  HARMONY_KINDS,
  MIXING_PAD_HEIGHT,
  MIXING_PAD_WIDTH,
  PAD_SAMPLE_SIZES,
  hsvToRgb,
  padSampleRadius,
  hueToWheel,
  parseHexColor,
  renderColorWheel,
  rgbToHexColor,
  rgbToHsv,
  wheelPick,
  wheelPoint,
  type ColorWheel,
  type HarmonyKind,
  type PaintEditorController,
} from '@pixerate/editor/paint-editor';
import { usePaintEditorState } from './usePaintEditor';
import { ErrorLine, PixelCanvas, button, chip, panel, useAttempt } from './shared';

export interface ColorPanelProps {
  controller: PaintEditorController;
  /** Wheel diameter in px (default 168). */
  wheelSize?: number;
  /** Show the mixing pad (default true). */
  mixingPad?: boolean;
  className?: string;
}

type PadTool = 'paint' | 'knife' | 'pick';

/**
 * Colour: a hue wheel (painter's RYB or RGB) with the chosen harmony marked on it, saturation and
 * value, the paint and second colours, harmony chips, swatches, and a mixing pad to paint on,
 * smear with a palette knife (pigment mixing) and pick from (with a sample size), mix the paint
 * and second colours in measured parts on, and keep by name.
 */
export const ColorPanel: React.FC<ColorPanelProps> = ({ controller, wheelSize = 168, mixingPad = true, className }) => {
  const state = usePaintEditorState(controller);
  const [error, attempt] = useAttempt();
  const [wheel, setWheel] = useState<ColorWheel>('ryb');
  const [kind, setKind] = useState<HarmonyKind>('complementary');
  const [padTool, setPadTool] = useState<PadTool>('paint');
  const [sample, setSample] = useState(3);
  const [parts, setParts] = useState<[number, number]>([1, 1]);
  const [padName, setPadName] = useState('');
  const padPoints = useRef<Array<{ x: number; y: number; pressure?: number }> | null>(null);
  const ring = useMemo(() => renderColorWheel(wheelSize, wheel), [wheelSize, wheel]);
  const color = state.color;
  const harmony = useMemo(() => controller.harmony(kind, { color, wheel }), [controller, kind, color, wheel]);
  const [r, g, b] = parseHexColor(color);
  const hsv = rgbToHsv(r, g, b);
  const pad = useMemo(() => ({ width: MIXING_PAD_WIDTH, height: MIXING_PAD_HEIGHT, data: controller.mixingPad.pixels() }), [controller, state.mixingPadVersion]);
  const R = wheelSize / 2;
  const mid = R * 0.82;
  const setHsv = (s: number, v: number) => controller.setColor(rgbToHexColor(...hsvToRgb(hsv.h, s, v)));

  const padPoint = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const kx = MIXING_PAD_WIDTH / (rect.width || MIXING_PAD_WIDTH);
    const ky = MIXING_PAD_HEIGHT / (rect.height || MIXING_PAD_HEIGHT);
    const x = Math.min(MIXING_PAD_WIDTH, Math.max(0, (e.clientX - rect.left) * kx));
    const y = Math.min(MIXING_PAD_HEIGHT, Math.max(0, (e.clientY - rect.top) * ky));
    return e.pointerType === 'pen' && e.pressure > 0 ? { x, y, pressure: e.pressure } : { x, y };
  };

  return (
    <div className={`${panel} ${className ?? ''}`} data-testid="color-panel">
      <div className="relative self-center" style={{ width: wheelSize, height: wheelSize }}>
        <div
          role="slider"
          aria-label="Hue wheel"
          aria-valuemin={0}
          aria-valuemax={360}
          aria-valuenow={Math.round(hueToWheel(hsv.h, wheel))}
          tabIndex={0}
          className="absolute inset-0 cursor-crosshair"
          onPointerDown={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            controller.setColor(wheelPick(e.clientX - rect.left - R, e.clientY - rect.top - R, wheel, color));
          }}
        >
          <PixelCanvas pixels={ring} label="Colour wheel" style={{ width: wheelSize, height: wheelSize }} />
        </div>
        <svg className="pointer-events-none absolute inset-0" width={wheelSize} height={wheelSize} aria-hidden="true">
          {harmony.map((h, i) => {
            const p = wheelPoint(h.angle, mid);
            return <circle key={i} cx={R + p.x} cy={R + p.y} r={i === 0 ? 7 : 5} fill={h.color} stroke="#fff" strokeWidth={i === 0 ? 2 : 1} />;
          })}
        </svg>
        <div className="absolute rounded-full border border-slate-700" style={{ left: R - R * 0.45, top: R - R * 0.45, width: R * 0.9, height: R * 0.9, background: color }} />
      </div>
      <div className="flex items-center gap-2">
        <input type="color" aria-label="Paint colour" value={color} onChange={(e) => controller.setColor(e.target.value)} className="h-7 w-9 rounded bg-transparent" />
        <input type="color" aria-label="Second colour" value={state.secondaryColor} onChange={(e) => controller.setSecondaryColor(e.target.value)} className="h-5 w-7 rounded bg-transparent" />
        <button type="button" className={button} title="Swap colours (X)" onClick={() => controller.swapColors()}>
          Swap
        </button>
        <input
          aria-label="Hex colour"
          defaultValue={color}
          key={color}
          onBlur={(e) => attempt(() => controller.setColor(e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`))}
          className="w-20 rounded bg-slate-800 px-1.5 py-0.5 font-mono"
        />
      </div>
      <label className="flex items-center gap-2">
        <span className="w-16 text-slate-400">Saturation</span>
        <input type="range" aria-label="Saturation" min={0} max={1} step={0.01} value={hsv.s} onChange={(e) => setHsv(Number(e.target.value), hsv.v)} className="flex-1 accent-indigo-500" />
      </label>
      <label className="flex items-center gap-2">
        <span className="w-16 text-slate-400">Value</span>
        <input type="range" aria-label="Value" min={0} max={1} step={0.01} value={hsv.v} onChange={(e) => setHsv(hsv.s, Number(e.target.value))} className="flex-1 accent-indigo-500" />
      </label>
      <div className="flex items-center gap-1">
        <select aria-label="Harmony" value={kind} onChange={(e) => setKind(e.target.value as HarmonyKind)} className="rounded bg-slate-800 px-1 py-0.5">
          {HARMONY_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <button type="button" className={chip(wheel === 'ryb')} aria-pressed={wheel === 'ryb'} onClick={() => setWheel('ryb')}>
          RYB
        </button>
        <button type="button" className={chip(wheel === 'rgb')} aria-pressed={wheel === 'rgb'} onClick={() => setWheel('rgb')}>
          RGB
        </button>
      </div>
      <div className="flex flex-wrap gap-1" aria-label="Harmony colours">
        {harmony.map((h, i) => (
          <button key={i} type="button" aria-label={`Use ${h.color}`} title={h.color} className="h-6 w-6 rounded ring-1 ring-slate-700" style={{ background: h.color }} onClick={() => controller.setColor(h.color)} />
        ))}
        <button type="button" className={button} onClick={() => harmony.forEach((h) => controller.addSwatch(h.color))}>
          + swatches
        </button>
      </div>
      <div className="flex flex-wrap gap-1" role="listbox" aria-label="Swatches">
        {state.swatches.map((s, i) => (
          <button
            key={i}
            type="button"
            role="option"
            aria-selected={s.color === color}
            aria-label={s.name ?? s.color}
            title={`${s.name ?? s.color} (right-click to remove)`}
            className="h-5 w-5 rounded ring-1 ring-slate-700"
            style={{ background: s.color }}
            onClick={() => controller.setColor(s.color)}
            onContextMenu={(e) => {
              e.preventDefault();
              controller.removeSwatch(i);
            }}
          />
        ))}
        <button type="button" className={button} aria-label="Add swatch" onClick={() => controller.addSwatch(color)}>
          +
        </button>
      </div>
      {mixingPad && (
        <div className="flex flex-col gap-1" data-testid="mixing-pad">
          <div className="flex items-center gap-1">
            <span className="text-slate-400">Mixing pad</span>
            {(['paint', 'knife', 'pick'] as const).map((t) => (
              <button key={t} type="button" aria-pressed={padTool === t} className={chip(padTool === t)} onClick={() => setPadTool(t)}>
                {t === 'paint' ? 'Paint' : t === 'knife' ? 'Knife' : 'Pick'}
              </button>
            ))}
            <button type="button" className={button} onClick={() => controller.clearMixingPad()}>
              Clear
            </button>
          </div>
          <div
            role="application"
            aria-label="Mixing pad"
            className="touch-none cursor-crosshair"
            onPointerDown={(e) => {
              const p = padPoint(e);
              if (padTool === 'pick') {
                attempt(() => controller.mixingPadPick(p.x, p.y, { setColor: true, radius: padSampleRadius(sample) }));
                return;
              }
              padPoints.current = [p];
              (e.target as Element).setPointerCapture?.(e.pointerId);
            }}
            onPointerMove={(e) => padPoints.current?.push(padPoint(e))}
            onPointerUp={() => {
              const pts = padPoints.current;
              padPoints.current = null;
              if (pts?.length) attempt(() => controller.mixingPadStroke(pts, { tool: padTool === 'knife' ? 'knife' : 'paint' }));
            }}
          >
            <PixelCanvas pixels={pad} label="Mixing pad pixels" className="w-full rounded" style={{ aspectRatio: `${MIXING_PAD_WIDTH} / ${MIXING_PAD_HEIGHT}` }} />
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <label className="flex items-center gap-1">
              <span className="text-slate-400">Sample</span>
              <select aria-label="Pick sample size" value={sample} onChange={(e) => setSample(Number(e.target.value))} className="rounded bg-slate-800 px-1 py-0.5">
                {PAD_SAMPLE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? '1 px' : `${n}×${n}`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="h-4 w-4 rounded ring-1 ring-slate-700" style={{ background: color }} />
            <input type="number" aria-label="Paint colour parts" min={0} max={20} value={parts[0]} onChange={(e) => setParts([Number(e.target.value), parts[1]])} className="w-10 rounded bg-slate-800 px-1 py-0.5" />
            <span className="text-slate-500">:</span>
            <input type="number" aria-label="Second colour parts" min={0} max={20} value={parts[1]} onChange={(e) => setParts([parts[0], Number(e.target.value)])} className="w-10 rounded bg-slate-800 px-1 py-0.5" />
            <span className="h-4 w-4 rounded ring-1 ring-slate-700" style={{ background: state.secondaryColor }} />
            <button
              type="button"
              className={button}
              title="Mix the paint and second colours in these parts on the pad, and use the mix"
              onClick={() =>
                attempt(() =>
                  controller.mixOnPad(
                    [
                      { color, parts: parts[0] },
                      { color: state.secondaryColor, parts: parts[1] },
                    ],
                    { setColor: true }
                  )
                )
              }
            >
              Mix
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <input value={padName} placeholder="Pad name" aria-label="Pad name" onChange={(e) => setPadName(e.target.value)} className="w-24 rounded bg-slate-800 px-1.5 py-0.5" />
            <button type="button" className={button} onClick={() => attempt(() => (controller.saveMixingPad(padName || undefined), setPadName('')))}>
              Keep pad
            </button>
          </div>
          {state.savedMixingPads.length > 0 && (
            <ul className="flex flex-col gap-0.5" aria-label="Kept pads">
              {state.savedMixingPads.map((p) => (
                <li key={p.id} className="flex items-center gap-1">
                  <button type="button" className={`${button} flex-1 text-left`} onClick={() => attempt(() => controller.loadMixingPad(p.id))}>
                    {p.name}
                  </button>
                  <button type="button" className={button} aria-label={`Remove ${p.name}`} onClick={() => attempt(() => controller.removeMixingPad(p.id))}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
};
