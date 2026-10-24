import React, { useMemo, useState } from "react";
import { useAgentToolProvider, ColorPicker } from "@pixerate/editor-react";
import {
  createColorToolProvider,
  parseColor,
  formatHex,
  rgbToHsl,
  oklabToOklch,
  rgbToOklab,
  relativeLuminance,
  contrastRatio,
  contrastLevel,
  simulateColorVision,
  colorHarmony,
  mixColors,
  type ColorVision,
  type HarmonyKind,
} from "@pixerate/editor/color";
import { demoToolRegistry } from "../agentTools";
import { Palette, CheckCircle2, XCircle, Sliders, Eye } from "lucide-react";

export function ColorTab() {
  // Register the agent colour toolset while mounted
  const provider = useMemo(() => createColorToolProvider({ id: "color", namespace: "color" }), []);
  useAgentToolProvider(demoToolRegistry, provider);

  const [hexColor, setHexColor] = useState("#3b82f6");
  const [surfaceColor, setSurfaceColor] = useState("#ffffff");
  const [harmonyKind, setHarmonyKind] = useState<HarmonyKind>("complementary");
  const [blendTarget, setBlendTarget] = useState("#f43f5e");
  const [blendFactor, setBlendFactor] = useState(0.5);

  const parsed = useMemo(() => parseColor(hexColor), [hexColor]);
  const surfaceParsed = useMemo(() => parseColor(surfaceColor), [surfaceColor]);

  const oklch = useMemo(() => {
    if (!parsed) return null;
    return oklabToOklch(rgbToOklab(parsed));
  }, [parsed]);

  const hsl = useMemo(() => {
    if (!parsed) return null;
    return rgbToHsl(parsed);
  }, [parsed]);

  const contrast = useMemo(() => {
    if (!parsed || !surfaceParsed) return null;
    const ratio = contrastRatio(parsed, surfaceParsed);
    const level = contrastLevel(ratio);
    return {
      ratio: Math.round(ratio * 100) / 100,
      level,
      passesAA: level === "AA" || level === "AAA",
      passesAAA: level === "AAA",
    };
  }, [parsed, surfaceParsed]);

  const simulated = useMemo(() => {
    if (!parsed) return null;
    const visions: Array<{ id: ColorVision; label: string }> = [
      { id: "normal", label: "Normal" },
      { id: "protanopia", label: "Protanopia" },
      { id: "deuteranopia", label: "Deuteranopia" },
      { id: "tritanopia", label: "Tritanopia" },
    ];
    return visions.map((v) => {
      const sim = simulateColorVision(parsed, v.id);
      return { ...v, hex: formatHex(sim) };
    });
  }, [parsed]);

  const harmonies = useMemo(() => {
    if (!parsed) return [];
    const validHex = formatHex(parsed);
    return colorHarmony(validHex, harmonyKind);
  }, [parsed, harmonyKind]);

  const blended = useMemo(() => {
    if (!parsed) return null;
    return mixColors(hexColor, blendTarget, blendFactor, { space: "oklab" });
  }, [hexColor, blendTarget, blendFactor, parsed]);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
          <Palette className="w-5 h-5 text-indigo-400" />
          Colour &amp; Accessibility
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          Perceptual colour spaces (OKLab, OKLCH), WCAG 2.1 contrast checking, CVD deficiency simulation, and harmonies.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Color Inspector */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
            <Sliders className="w-4 h-4 text-indigo-400" />
            Interactive Colour Picker
          </h3>
          <div className="flex justify-center py-2">
            <ColorPicker
              value={hexColor}
              onChange={setHexColor}
              alpha={true}
              contrastAgainst={surfaceColor}
              swatches={["#ef4444", "#f97316", "#eab308", "#10b981", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899"]}
            />
          </div>

          {parsed && oklch && hsl && (
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="rounded-lg bg-slate-950 p-2.5 border border-slate-800/80">
                <span className="text-slate-500 block mb-1">OKLCH</span>
                <span className="font-mono text-slate-200">
                  L: {(oklch.l * 100).toFixed(1)}% C: {oklch.c.toFixed(3)} H: {oklch.h.toFixed(1)}°
                </span>
              </div>
              <div className="rounded-lg bg-slate-950 p-2.5 border border-slate-800/80">
                <span className="text-slate-500 block mb-1">HSL</span>
                <span className="font-mono text-slate-200">
                  {hsl.h.toFixed(0)}°, {(hsl.s * 100).toFixed(0)}%, {(hsl.l * 100).toFixed(0)}%
                </span>
              </div>
              <div className="rounded-lg bg-slate-950 p-2.5 border border-slate-800/80">
                <span className="text-slate-500 block mb-1">Relative Luminance</span>
                <span className="font-mono text-slate-200">{relativeLuminance(parsed).toFixed(4)}</span>
              </div>
              <div className="rounded-lg bg-slate-950 p-2.5 border border-slate-800/80">
                <span className="text-slate-500 block mb-1">RGB Channels</span>
                <span className="font-mono text-slate-200">
                  {Math.round(parsed.r * 255)}, {Math.round(parsed.g * 255)}, {Math.round(parsed.b * 255)}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Contrast Checker */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-200 flex items-center justify-between">
            <span>WCAG 2.1 Contrast</span>
            {contrast && (
              <span className={`text-xs px-2 py-0.5 rounded font-mono font-medium ${contrast.passesAA ? "bg-emerald-950 text-emerald-300 border border-emerald-800" : "bg-rose-950 text-rose-300 border border-rose-800"}`}>
                {contrast.ratio}:1 ({contrast.level})
              </span>
            )}
          </h3>

          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-400">Background Surface:</span>
            <input
              type="color"
              value={surfaceColor.startsWith("#") && surfaceColor.length === 7 ? surfaceColor : "#ffffff"}
              onChange={(e) => setSurfaceColor(e.target.value)}
              className="w-8 h-8 rounded cursor-pointer border border-slate-700 bg-transparent p-0"
            />
            <input
              type="text"
              value={surfaceColor}
              onChange={(e) => setSurfaceColor(e.target.value)}
              className="rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1 text-xs font-mono text-slate-100 w-28"
            />
          </div>

          <div
            className="rounded-lg p-4 border flex items-center justify-center font-medium text-sm transition-colors"
            style={{ backgroundColor: surfaceColor, color: hexColor, borderColor: "#334155" }}
          >
            The quick brown fox jumps over the lazy dog
          </div>

          {contrast && (
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="flex items-center justify-between p-2 rounded bg-slate-950 border border-slate-800/80">
                <span className="text-slate-400">AA (Normal 4.5:1)</span>
                {contrast.passesAA ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <XCircle className="w-4 h-4 text-rose-400" />}
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-slate-950 border border-slate-800/80">
                <span className="text-slate-400">AAA (Normal 7.0:1)</span>
                {contrast.passesAAA ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <XCircle className="w-4 h-4 text-rose-400" />}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Colour Vision Deficiency Simulation */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
          <Eye className="w-4 h-4 text-indigo-400" />
          Colour Vision Deficiency Simulation (Machado 2009)
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {simulated?.map((sim) => (
            <div key={sim.id} className="rounded-lg bg-slate-950 p-3 border border-slate-800/80 text-center space-y-2">
              <div className="w-full h-12 rounded-md border border-white/10" style={{ backgroundColor: sim.hex }} />
              <div>
                <span className="block text-xs font-medium text-slate-200">{sim.label}</span>
                <span className="font-mono text-[11px] text-slate-400">{sim.hex}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Harmonies & Blending */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-200">Harmonies</h3>
            <select
              value={harmonyKind}
              onChange={(e) => setHarmonyKind(e.target.value as HarmonyKind)}
              className="text-xs rounded border border-slate-700 bg-slate-950 text-slate-200 px-2 py-1"
            >
              <option value="complementary">Complementary</option>
              <option value="analogous">Analogous</option>
              <option value="triadic">Triadic</option>
              <option value="tetradic">Tetradic</option>
              <option value="split-complementary">Split-Complementary</option>
              <option value="square">Square</option>
              <option value="monochromatic">Monochromatic</option>
            </select>
          </div>
          <div className="flex gap-2">
            {harmonies.map((h, i) => (
              <div key={i} className="flex-1 text-center space-y-1">
                <div className="h-10 rounded border border-white/10" style={{ backgroundColor: h.color }} />
                <span className="font-mono text-[10px] text-slate-400 block">{h.color}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-200">Perceptual OKLab Blend</h3>
            <span className="font-mono text-xs text-slate-400">{Math.round(blendFactor * 100)}%</span>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={blendTarget.startsWith("#") && blendTarget.length === 7 ? blendTarget : "#f43f5e"}
              onChange={(e) => setBlendTarget(e.target.value)}
              className="w-8 h-8 rounded cursor-pointer border border-slate-700 bg-transparent p-0"
            />
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={blendFactor}
              onChange={(e) => setBlendFactor(parseFloat(e.target.value))}
              className="flex-1"
            />
          </div>
          {blended && (
            <div className="h-10 rounded border border-white/10 flex items-center justify-center font-mono text-xs text-white shadow-inner" style={{ backgroundColor: blended }}>
              {blended}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
