import React, { useEffect, useMemo, useState } from "react";
import { useAgentToolProvider } from "@pixerate/editor-react";
import { TypographyControl } from "@pixerate/editor-react/typography";
import {
  FontPickerModel,
  MODULAR_SCALE_RATIO_NAMES,
  MODULAR_SCALE_RATIOS,
  auditTextReadability,
  checkTypographyAccessibility,
  createFontPickerToolProvider,
  createSystemFontProvider,
  createTypographyToolProvider,
  generateTypeHierarchy,
  segmentText,
  type FontSpec,
  type ModularScaleRatio,
} from "@pixerate/editor/typography";
import { demoToolRegistry } from "../agentTools";
import { CheckCircle2, Type, XCircle } from "lucide-react";

const SAMPLE =
  "Good typography is invisible. The reader should notice the words, not the letters: a comfortable measure, generous line spacing and enough contrast let the eye run along each line and drop to the next without effort.";

export function TypographyTab() {
  const fontProvider = useMemo(() => createSystemFontProvider(), []);
  // One model drives the control and the agent's font picker tools, so either can change the font.
  const model = useMemo(
    () => new FontPickerModel({ provider: fontProvider, value: { family: "Georgia", size: 18, lineHeight: 1.5 } }),
    [fontProvider],
  );
  useEffect(() => {
    void model.refresh();
  }, [model]);

  const typographyTools = useMemo(() => createTypographyToolProvider({ provider: fontProvider }), [fontProvider]);
  const pickerTools = useMemo(() => createFontPickerToolProvider(model), [model]);
  useAgentToolProvider(demoToolRegistry, typographyTools);
  useAgentToolProvider(demoToolRegistry, pickerTools);

  const [spec, setSpec] = useState<FontSpec>(() => model.value);
  const [ratio, setRatio] = useState<ModularScaleRatio>("major-third");
  const [width, setWidth] = useState(560);
  const [foreground, setForeground] = useState("#475569");
  const [background, setBackground] = useState("#ffffff");
  const [granularity, setGranularity] = useState<"grapheme" | "word" | "line">("word");

  const hierarchy = useMemo(() => generateTypeHierarchy({ baseSize: spec.size, ratio }), [spec.size, ratio]);
  const audit = useMemo(
    () => auditTextReadability(SAMPLE, { size: spec.size, lineHeight: spec.lineHeight, letterSpacing: spec.letterSpacing, width, category: spec.category }),
    [spec, width],
  );
  const access = useMemo(() => {
    try {
      return checkTypographyAccessibility({ font: { size: spec.size, weight: spec.weight }, foreground, background });
    } catch {
      return null;
    }
  }, [spec.size, spec.weight, foreground, background]);
  const segments = useMemo(
    () => segmentText("Type in motion", granularity, granularity === "line" ? { maxCharacters: 8 } : granularity === "word" ? { wordsOnly: true } : {}),
    [granularity],
  );
  // `spec` mirrors the model (onChange), so this re-renders with every change.
  const css = model.css;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
          <Type className="w-5 h-5 text-indigo-400" />
          Typography
        </h2>
        <p className="text-sm text-slate-400 mt-1">
          Fonts and fallback stacks, modular type scales, readability and type-aware contrast audits, and text segmentation from{" "}
          <code className="text-xs">@pixerate/editor/typography</code>. Agents get the same through the typography and font picker tools.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        <TypographyControl model={model} onChange={setSpec} />

        <div className="space-y-6">
          <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
              <span className="font-medium text-slate-200">Readability</span>
              <label className="flex items-center gap-2">
                Column width
                <input type="range" min={240} max={1000} value={width} onChange={(e) => setWidth(Number(e.target.value))} aria-label="Column width" />
                <span className="font-mono">{width}px</span>
              </label>
            </div>
            <p
              style={{ ...css, fontSize: css.fontSize, maxWidth: width, color: foreground, background, padding: 12, borderRadius: 8 }}
              data-testid="typography-sample"
            >
              {SAMPLE}
            </p>
            <ul className="text-xs space-y-1 text-slate-300">
              <li>
                Measure: about <strong>{audit.lineLength.characters}</strong> characters per line ({audit.lineLength.status})
              </li>
              <li>
                Line spacing {audit.lineSpacing.ratio} {audit.lineSpacing.meetsRecommended ? "meets" : "is below"} 1.5
              </li>
              <li>Reading time ≈ {audit.estimatedReadingTimeSeconds}s</li>
              {audit.issues.map((issue) => (
                <li key={issue} className="text-amber-300">
                  {issue}
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
              <span className="font-medium text-slate-200">Contrast for this type</span>
              <label className="flex items-center gap-1">
                Text <input type="color" value={foreground} onChange={(e) => setForeground(e.target.value)} aria-label="Text colour" />
              </label>
              <label className="flex items-center gap-1">
                Background <input type="color" value={background} onChange={(e) => setBackground(e.target.value)} aria-label="Background colour" />
              </label>
            </div>
            {access && (
              <div className="text-xs text-slate-300 flex flex-wrap items-center gap-3">
                <span className="font-mono">{access.ratio}:1</span>
                <span>{access.large ? "Large text" : "Normal text"} (needs {access.required.AA}:1 for AA)</span>
                <span className="flex items-center gap-1">
                  {access.passesAA ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <XCircle className="w-4 h-4 text-rose-400" />}
                  {access.level}
                </span>
                {access.suggestion && (
                  <button type="button" className="underline" onClick={() => setForeground(access.suggestion!)}>
                    Use {access.suggestion}
                  </button>
                )}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-3">
            <div className="flex items-center gap-3 text-xs text-slate-400">
              <span className="font-medium text-slate-200">Type scale</span>
              <select value={ratio} onChange={(e) => setRatio(e.target.value as ModularScaleRatio)} aria-label="Scale ratio" className="bg-slate-900 border border-slate-700 rounded px-2 py-1">
                {MODULAR_SCALE_RATIO_NAMES.map((r) => (
                  <option key={r} value={r}>
                    {r} ({MODULAR_SCALE_RATIOS[r]})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1 overflow-hidden">
              {Object.values(hierarchy.steps)
                .slice()
                .reverse()
                .map((step) => (
                  <div key={step.name} className="flex items-baseline gap-3">
                    <span className="w-16 shrink-0 text-[10px] font-mono text-slate-500">
                      {step.name} {step.size}px
                    </span>
                    <span
                      className="text-slate-100 truncate"
                      style={{ fontFamily: css.fontFamily, fontSize: Math.min(step.size, 72), lineHeight: step.lineHeight, letterSpacing: `${step.letterSpacing}em` }}
                    >
                      Typography
                    </span>
                  </div>
                ))}
            </div>
          </section>

          <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-3">
            <div className="flex items-center gap-3 text-xs text-slate-400">
              <span className="font-medium text-slate-200">Segments for animation</span>
              {(["grapheme", "word", "line"] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setGranularity(g)}
                  className={`px-2 py-0.5 rounded border ${granularity === g ? "border-indigo-400 text-indigo-300" : "border-slate-700"}`}
                >
                  {g}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1" style={{ fontFamily: css.fontFamily }}>
              {segments.map((s) => (
                <span
                  key={`${s.start}-${s.end}`}
                  className="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-200 text-lg typography-segment"
                  style={{ animationDelay: `${s.index * 60}ms` }}
                >
                  {s.text.replace(/ /g, "\u00a0")}
                </span>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
