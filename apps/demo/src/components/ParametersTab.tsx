import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  createParameterKeyframeStore,
  hexToRgba01,
  parameterSchemaFromShaderControls,
  rgba01ToHex,
  shaderControlValue,
  type ParameterSchema,
  type ParameterTrack,
  type ParameterValue,
  type ParameterValues,
  type ShaderControlLike,
} from "@pixerate/editor/parameters";
import { ParametersPanel, useParameterCommands, useParameters, useParametersController } from "@pixerate/editor-react/parameters";
import { Pause, Play, SlidersHorizontal } from "lucide-react";
import { demoCommandRegistry } from "../agentTools";

/** Small inline SVG backdrops, so the image picker works offline. */
const backdrop = (from: string, to: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="160" height="100" fill="url(#g)"/></svg>`,
  )}`;
const BACKDROPS = [
  { url: backdrop("#0f172a", "#7c3aed"), label: "Dusk" },
  { url: backdrop("#082f49", "#14b8a6"), label: "Lagoon" },
  { url: backdrop("#431407", "#f59e0b"), label: "Ember" },
];

const SCHEMA: ParameterSchema = {
  title: "Glow effect",
  fields: [
    { id: "shape", type: "choice", control: "segmented", options: ["orb", "rings", "bars"], default: "orb" },
    { id: "speed", type: "number", min: 0, max: 4, step: 0.05, default: 1, unit: "x", description: "Spin speed of the glow." },
    { id: "radius", type: "number", min: 10, max: 100, step: 1, default: 55, unit: "%" },
    { id: "softness", type: "number", min: 0, max: 1, default: 0.5 },
    { id: "tint", type: "color", default: "#f43f5e", swatches: ["#f43f5e", "#38bdf8", "#a3e635", "#facc15"] },
    { id: "center", type: "vector", size: 2, min: -1, max: 1, step: 0.05, default: [0, 0] },
    {
      type: "group",
      id: "pattern",
      label: "Pattern",
      showIf: { shape: { ne: "orb" } },
      fields: [
        { id: "count", type: "int", min: 2, max: 24, default: 8, label: "Rings / bars" },
        { id: "thickness", type: "number", min: 0.05, max: 0.9, default: 0.35 },
      ],
    },
    {
      type: "group",
      id: "backdrop",
      label: "Backdrop",
      fields: [
        { id: "background", type: "color", alpha: true, default: "#020617ff" },
        { id: "photo", type: "image", default: "", options: BACKDROPS, description: "Shown behind the glow." },
        { id: "grain", type: "boolean", default: false, label: "Film grain" },
      ],
    },
    {
      type: "group",
      id: "label",
      label: "Caption",
      collapsed: true,
      fields: [{ id: "caption", type: "text", default: "Pixerate", maxLength: 24, placeholder: "Caption" }],
    },
  ],
  presets: [
    { name: "Neon", values: { shape: "rings", tint: "#38bdf8", speed: 2.5, count: 12, thickness: 0.2, softness: 0.2 } },
    { name: "Ember", values: { tint: "#f59e0b", radius: 80, softness: 0.9, photo: BACKDROPS[2].url, grain: true } },
  ],
};

const DURATION = 3000;

// The demo owns interpolation (like any timeline would): numbers, vectors and colours are
// linear between keys, everything else holds.
function interpolate(a: ParameterValue, b: ParameterValue, t: number): ParameterValue {
  if (typeof a === "number" && typeof b === "number") return a + (b - a) * t;
  if (Array.isArray(a) && Array.isArray(b)) return a.map((v, i) => v + ((b[i] ?? v) - v) * t);
  if (typeof a === "string" && typeof b === "string" && a.startsWith("#") && b.startsWith("#")) {
    const ca = hexToRgba01(a, true);
    const cb = hexToRgba01(b, true);
    if (ca && cb) return rgba01ToHex(interpolate(ca, cb, t) as number[], a.length > 7);
  }
  return t < 1 ? a : b;
}

function evaluate(track: ParameterTrack, time: number): ParameterValue | undefined {
  const keys = track.keyframes;
  if (keys.length === 0) return undefined;
  if (time <= keys[0].time) return keys[0].value;
  for (let i = 0; i < keys.length - 1; i++) {
    const [k0, k1] = [keys[i], keys[i + 1]];
    if (time <= k1.time) return interpolate(k0.value, k1.value, (time - k0.time) / (k1.time - k0.time || 1));
  }
  return keys[keys.length - 1].value;
}

function GlowPreview({ values, time }: { values: Readonly<ParameterValues>; time: number }) {
  const [cx, cy] = values.center as number[];
  const tint = values.tint as string;
  const radius = values.radius as number;
  const soft = values.softness as number;
  const count = values.count as number;
  const thick = values.thickness as number;
  const angle = ((time / 1000) * 60 * (values.speed as number)) % 360;
  const at = `${50 + cx * 40}% ${50 - cy * 40}%`;
  const glow =
    values.shape === "orb"
      ? `radial-gradient(circle at ${at}, ${tint} 0%, ${tint}00 ${radius * (0.4 + soft * 0.6)}%)`
      : values.shape === "rings"
        ? `repeating-radial-gradient(circle at ${at}, ${tint} 0 ${thick * (radius / count)}%, transparent ${thick * (radius / count) + soft * 4}% ${radius / count}%)`
        : `repeating-conic-gradient(from ${angle}deg at ${at}, ${tint} 0 ${thick * (360 / count)}deg, transparent ${thick * (360 / count) + soft * 8}deg ${360 / count}deg)`;
  return (
    <div
      className="relative h-[280px] overflow-hidden rounded-xl border border-slate-800"
      style={{
        backgroundColor: values.background as string,
        backgroundImage: values.photo ? `url("${values.photo}")` : undefined,
        backgroundSize: "cover",
      }}
      data-testid="parameters-preview"
    >
      <div className="absolute inset-0" style={{ background: glow, transform: values.shape === "orb" ? `rotate(${angle}deg)` : undefined, mixBlendMode: "screen" }} />
      {values.grain && (
        <svg className="absolute inset-0 h-full w-full opacity-30 mix-blend-overlay" aria-hidden="true">
          <filter id="parameters-grain">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" />
          </filter>
          <rect width="100%" height="100%" filter="url(#parameters-grain)" />
        </svg>
      )}
      {values.caption && (
        <div className="absolute bottom-3 left-4 text-lg font-semibold tracking-tight text-white drop-shadow">{values.caption as string}</div>
      )}
    </div>
  );
}

/** Flair-style shader `@control` definitions, turned into a schema with one call. */
const SHADER_CONTROLS: ShaderControlLike[] = [
  { name: "uSpeed", type: "float", label: "Speed", min: 0, max: 4, step: 0.02, default: 1 },
  { name: "uSteps", type: "int", label: "Steps", min: 1, max: 64, step: 1, default: 16 },
  { name: "uGrain", type: "bool", label: "Film grain", default: true },
  { name: "uCenter", type: "vec2", label: "Center", min: -1, max: 1, step: 0.01, default: [0, 0] },
  { name: "uTint", type: "vec3", label: "Tint", color: true, default: [0.467, 0.757, 0.416] },
];
const SHADER_SCHEMA = parameterSchemaFromShaderControls(SHADER_CONTROLS, { title: "Shader controls" });

function ShaderControlsDemo() {
  const { controller, values } = useParameters({ schema: SHADER_SCHEMA });
  const uniforms = Object.fromEntries(SHADER_CONTROLS.map((c) => [c.name, shaderControlValue(c, values[c.name])]));
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <ParametersPanel controller={controller} showPresets={false} />
      </div>
      <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
        <p className="mb-2 text-xs text-slate-400">
          <code>parameterSchemaFromShaderControls</code> maps <code>float</code>, <code>int</code>, <code>bool</code>, <code>vecN</code> (colour
          vectors become hex pickers) and <code>sampler2D</code>; <code>shaderControlValue</code> turns values back into uniforms:
        </p>
        <pre className="overflow-x-auto text-[11px] leading-relaxed text-slate-300" data-testid="shader-uniforms">
          {JSON.stringify(uniforms, (_k, v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v), 2)}
        </pre>
      </div>
    </div>
  );
}

export function ParametersTab() {
  const keyframes = useMemo(
    () =>
      createParameterKeyframeStore({
        radius: { keyframes: [{ time: 0, value: 35 }, { time: 1500, value: 85 }, { time: 3000, value: 35 }] },
        tint: { keyframes: [{ time: 0, value: "#f43f5e" }, { time: 3000, value: "#a855f7" }] },
      }),
    [],
  );
  const controller = useParametersController({ schema: SCHEMA, keyframes });
  const { state } = useParameters(controller);
  useParameterCommands(demoCommandRegistry, controller, { group: "Parameters" });

  const [playing, setPlaying] = useState(false);
  const seek = (time: number) => {
    const values: ParameterValues = {};
    for (const [id, track] of Object.entries(keyframes.getTracks())) {
      const v = evaluate(track, time);
      if (v !== undefined) values[id] = v;
    }
    controller.setTime(time, values);
  };
  const seekRef = useRef(seek);
  seekRef.current = seek;
  useEffect(() => {
    seekRef.current(0);
  }, []);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const time = (controller.getState().time + (now - last)) % DURATION;
      last = now;
      seekRef.current(time);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, controller]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
          <SlidersHorizontal className="h-5 w-5 text-rose-400" /> Parameters editor
        </h2>
        <p className="max-w-3xl text-sm text-slate-400">
          One schema drives the whole panel: sliders, toggles, choices, colours, vectors, an image picker and text, with groups that
          collapse or appear only when relevant (the Pattern group needs a non-orb shape). Slider drags are one undo step, invalid
          values are refused with a sentence, presets save and apply, and the diamonds key values at the playhead. Agents get the same
          actions as <code>parameters.*</code> commands in the panel below.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-3">
          <GlowPreview values={state.values} time={state.time} />
          <div className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900 px-3 py-2" role="group" aria-label="Timeline">
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              className="rounded-md border border-slate-700 p-1.5 text-slate-200 hover:bg-slate-800"
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            </button>
            <input
              type="range"
              aria-label="Playhead"
              min={0}
              max={DURATION}
              step={10}
              value={state.time}
              onChange={(e) => seek(Number(e.target.value))}
              className="flex-1 accent-rose-500"
            />
            <span className="w-16 text-right font-mono text-xs text-slate-400">{(state.time / 1000).toFixed(2)}s</span>
          </div>
          <p className="text-xs text-slate-500">
            Radius and tint are keyed at 0s, 1.5s and 3s. Move the playhead onto a key (filled diamond) and change the value to update
            it, or click a hollow diamond to add one.
          </p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <ParametersPanel controller={controller} />
        </div>
      </div>

      <ShaderControlsDemo />
    </div>
  );
}
