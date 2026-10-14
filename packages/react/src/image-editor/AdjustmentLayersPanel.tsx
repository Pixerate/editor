import React, { useEffect, useState } from 'react';
import type {
  AdjustmentKind,
  AdjustmentLayer,
  BlendMode,
  ControlSpec,
  CurvePoint,
  ImageEditorController,
  ImageHistogram,
} from '@pixerate/editor/image-editor';
import {
  ADJUSTMENT_KINDS,
  ADJUSTMENT_LAYER_CONTROLS,
  ADJUSTMENT_LAYER_OPACITY_CONTROL,
  BLEND_MODES,
  HUE_RANGE_LABELS,
  adjustmentKindLabel,
  getControlPath,
  hueRangeWeight,
  setControlPath,
} from '@pixerate/editor/image-editor';
import { ControlSlider } from './ControlSlider';
import { CurvesEditor } from './CurvesEditor';

export interface AdjustmentLayersPanelProps {
  controller: ImageEditorController;
  /** The current layers (`state.adjustments.layers`), bottom to top. Omit to follow the controller. */
  layers?: AdjustmentLayer[];
  histogram?: ImageHistogram | null;
}

type Channel = 'master' | 'red' | 'green' | 'blue';
const CHANNELS: { id: Channel; label: string }[] = [
  { id: 'master', label: 'RGB' },
  { id: 'red', label: 'Red' },
  { id: 'green', label: 'Green' },
  { id: 'blue', label: 'Blue' },
];
const TONES = [
  { id: 'shadows', label: 'Shadows' },
  { id: 'midtones', label: 'Midtones' },
  { id: 'highlights', label: 'Highlights' },
] as const;

const selectClass = 'bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-slate-200';
const chipClass = (on: boolean) =>
  `px-2 py-0.5 rounded text-[10px] ${on ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`;

/** Hue strip with the weight of one Hue/Saturation range drawn over it. */
const HueRangeStrip: React.FC<{ bounds: [number, number, number, number] }> = ({ bounds }) => {
  const pts = Array.from({ length: 73 }, (_, i) => `${(i / 72) * 360},${20 - hueRangeWeight({ bounds }, i * 5) * 18}`).join(' ');
  return (
    <svg viewBox="0 0 360 20" preserveAspectRatio="none" className="w-full h-4 rounded" data-testid="hue-range-strip">
      <defs>
        <linearGradient id="pixerate-hue-strip">
          {[0, 60, 120, 180, 240, 300, 360].map((h) => (
            <stop key={h} offset={`${(h / 360) * 100}%`} stopColor={`hsl(${h}, 90%, 50%)`} />
          ))}
        </linearGradient>
      </defs>
      <rect width={360} height={20} fill="url(#pixerate-hue-strip)" opacity={0.6} />
      <polyline points={pts} fill="none" stroke="#fff" strokeWidth={1.5} />
    </svg>
  );
};

/**
 * Adjustment-layer stack: add, reorder, show / hide and remove layers, and edit the selected
 * one (curves over the histogram, levels, hue/saturation ranges, colour balance, …).
 */
export const AdjustmentLayersPanel: React.FC<AdjustmentLayersPanelProps> = ({ controller, layers: layersProp, histogram }) => {
  // Follows the controller when no `layers` prop is given.
  const follow = layersProp === undefined;
  const [, setTick] = useState(0);
  useEffect(() => (follow ? controller.subscribe(() => setTick((n) => n + 1)) : undefined), [controller, follow]);
  const layers = layersProp ?? controller.getAdjustmentLayers();
  const [newKind, setNewKind] = useState<AdjustmentKind>('curves');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [channel, setChannel] = useState<Channel>('master');
  const [range, setRange] = useState<number>(-1);
  const [tone, setTone] = useState<(typeof TONES)[number]['id']>('midtones');

  const selected = layers.find((l) => l.id === selectedId) ?? null;
  const topFirst = [...layers].reverse();

  const setParam = (layer: AdjustmentLayer, path: string, value: unknown, commit = true) =>
    controller.updateAdjustmentLayer(layer.id, { params: setControlPath(layer.params, path, value) as never }, commit);

  const slider = (layer: AdjustmentLayer, spec: ControlSpec, label?: string) => (
    <ControlSlider
      key={spec.id}
      spec={spec}
      label={label}
      value={Number(getControlPath(layer.params, spec.id) ?? spec.default)}
      onChange={(v) => setParam(layer, spec.id, v)}
    />
  );
  const controlsOf = (layer: AdjustmentLayer, filter: (spec: ControlSpec) => boolean = () => true) =>
    ADJUSTMENT_LAYER_CONTROLS[layer.kind].filter(filter);
  const checkbox = (layer: AdjustmentLayer, path: string, label: string) => (
    <label className="flex items-center gap-2 text-slate-300">
      <input
        type="checkbox"
        checked={Boolean(getControlPath(layer.params, path))}
        onChange={(e) => setParam(layer, path, e.target.checked)}
        className="accent-indigo-500"
      />
      {label}
    </label>
  );

  const editor = (layer: AdjustmentLayer) => {
    switch (layer.kind) {
      case 'curves':
        return (
          <div className="flex flex-col gap-2">
            <div className="flex gap-1" role="group" aria-label="Curve channel">
              {CHANNELS.map((c) => (
                <button key={c.id} type="button" className={chipClass(channel === c.id)} onClick={() => setChannel(c.id)}>
                  {c.label}
                </button>
              ))}
            </div>
            <CurvesEditor
              points={layer.params[channel]}
              channel={channel}
              histogram={histogram}
              onChange={(points: CurvePoint[], commit) => setParam(layer, channel, points, commit)}
            />
          </div>
        );
      case 'levels':
        return (
          <div className="flex flex-col gap-2">
            <div className="flex gap-1" role="group" aria-label="Levels channel">
              {CHANNELS.map((c) => (
                <button key={c.id} type="button" className={chipClass(channel === c.id)} onClick={() => setChannel(c.id)}>
                  {c.label}
                </button>
              ))}
            </div>
            {controlsOf(layer, (s) => s.id.startsWith(`${channel}.`)).map((s) => slider(layer, s))}
          </div>
        );
      case 'hueSaturation':
        return (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1" role="group" aria-label="Hue range">
              <button type="button" className={chipClass(range === -1)} onClick={() => setRange(-1)}>
                Master
              </button>
              {HUE_RANGE_LABELS.map((name, i) => (
                <button key={name} type="button" className={chipClass(range === i)} onClick={() => setRange(i)} disabled={layer.params.colorize}>
                  {name}
                </button>
              ))}
            </div>
            {range >= 0 && !layer.params.colorize && <HueRangeStrip bounds={layer.params.ranges[range].bounds} />}
            {controlsOf(layer, (s) => (range === -1 || layer.params.colorize ? !s.id.startsWith('ranges.') : s.id.startsWith(`ranges.${range}.`))).map((s) =>
              slider(layer, s)
            )}
            {range === -1 && checkbox(layer, 'colorize', 'Colorize')}
          </div>
        );
      case 'colorBalance':
        return (
          <div className="flex flex-col gap-2">
            <div className="flex gap-1" role="group" aria-label="Tone">
              {TONES.map((t) => (
                <button key={t.id} type="button" className={chipClass(tone === t.id)} onClick={() => setTone(t.id)}>
                  {t.label}
                </button>
              ))}
            </div>
            {controlsOf(layer, (s) => s.id.startsWith(`${tone}.`)).map((s) => slider(layer, s))}
            {checkbox(layer, 'preserveLuminosity', 'Preserve luminosity')}
          </div>
        );
      case 'blackWhite':
        return (
          <div className="flex flex-col gap-2">
            {controlsOf(layer).map((s) => slider(layer, s))}
            <label className="flex items-center gap-2 text-slate-300">
              <input
                type="checkbox"
                checked={layer.params.tint !== null}
                onChange={(e) => setParam(layer, 'tint', e.target.checked ? '#e1d3b3' : null)}
                className="accent-indigo-500"
              />
              Tint
              {layer.params.tint && (
                <input
                  type="color"
                  aria-label="Tint colour"
                  value={layer.params.tint}
                  onChange={(e) => setParam(layer, 'tint', e.target.value)}
                  className="h-5 w-8 bg-transparent"
                />
              )}
            </label>
          </div>
        );
      case 'photoFilter':
        return (
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-slate-300">
              Filter colour
              <input
                type="color"
                aria-label="Filter colour"
                value={layer.params.color}
                onChange={(e) => setParam(layer, 'color', e.target.value)}
                className="h-5 w-8 bg-transparent"
              />
            </label>
            {controlsOf(layer).map((s) => slider(layer, s))}
            {checkbox(layer, 'preserveLuminosity', 'Preserve luminosity')}
          </div>
        );
      case 'invert':
        return <p className="text-slate-500 text-[11px]">Invert has no settings.</p>;
      default:
        return <div className="flex flex-col gap-2">{controlsOf(layer).map((s) => slider(layer, s))}</div>;
    }
  };

  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="adjustment-layers-panel">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">Adjustment Layers</span>
      </div>
      <div className="flex gap-1.5">
        <select
          aria-label="New adjustment layer kind"
          className={`${selectClass} flex-1`}
          value={newKind}
          onChange={(e) => setNewKind(e.target.value as AdjustmentKind)}
        >
          {ADJUSTMENT_KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-500"
          onClick={() => {
            setSelectedId(controller.addAdjustmentLayer(newKind));
            setChannel('master');
            setRange(-1);
          }}
        >
          Add Layer
        </button>
      </div>

      {topFirst.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Adjustment layers">
          {topFirst.map((layer) => {
            const index = layers.indexOf(layer);
            const label = layer.name || adjustmentKindLabel(layer.kind);
            return (
              <li
                key={layer.id}
                className={`flex items-center gap-1.5 rounded px-1.5 py-1 ${layer.id === selectedId ? 'bg-indigo-600/20 ring-1 ring-indigo-500/50' : 'bg-slate-800/60'}`}
              >
                <input
                  type="checkbox"
                  aria-label={`Show ${label}`}
                  checked={layer.enabled}
                  onChange={() => controller.toggleAdjustmentLayer(layer.id)}
                  className="accent-indigo-500"
                />
                <button
                  type="button"
                  className={`flex-1 text-left truncate ${layer.enabled ? 'text-slate-200' : 'text-slate-500 line-through'}`}
                  onClick={() => setSelectedId(layer.id === selectedId ? null : layer.id)}
                  aria-pressed={layer.id === selectedId}
                >
                  {label}
                </button>
                <button
                  type="button"
                  aria-label={`Move ${label} up`}
                  disabled={index === layers.length - 1}
                  onClick={() => controller.moveAdjustmentLayer(layer.id, index + 1)}
                  className="px-1 text-slate-400 hover:text-slate-200 disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move ${label} down`}
                  disabled={index === 0}
                  onClick={() => controller.moveAdjustmentLayer(layer.id, index - 1)}
                  className="px-1 text-slate-400 hover:text-slate-200 disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${label}`}
                  onClick={() => {
                    controller.removeAdjustmentLayer(layer.id);
                    if (selectedId === layer.id) setSelectedId(null);
                  }}
                  className="px-1 text-rose-400 hover:text-rose-300"
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selected && (
        <div className="flex flex-col gap-2 rounded border border-slate-700/60 p-2" data-testid="adjustment-layer-editor">
          <div className="flex items-center gap-2">
            <span className="text-slate-400">Blend</span>
            <select
              aria-label="Blend mode"
              className={`${selectClass} flex-1`}
              value={selected.blend}
              onChange={(e) => controller.updateAdjustmentLayer(selected.id, { blend: e.target.value as BlendMode })}
            >
              {BLEND_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <ControlSlider
            spec={ADJUSTMENT_LAYER_OPACITY_CONTROL}
            label="Layer opacity"
            value={selected.opacity}
            onChange={(v) => controller.updateAdjustmentLayer(selected.id, { opacity: v })}
          />
          {editor(selected)}
        </div>
      )}
    </div>
  );
};
