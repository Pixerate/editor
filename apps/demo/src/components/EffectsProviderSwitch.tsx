import React from "react";
import { DEMO_EFFECTS_OPTIONS, setDemoEffectsSource, useDemoEffects } from "../demoEffects";

/** Picks the effects provider every effects-enabled tab uses. */
export function EffectsProviderSwitch() {
  const { source, loading, error } = useDemoEffects();
  const note = error ?? (loading ? "Loading Flair…" : DEMO_EFFECTS_OPTIONS.find((o) => o.id === source)?.note);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-effects-switch="">
      <span className="text-muted-foreground">Effects</span>
      <div role="radiogroup" aria-label="Effects provider" className="inline-flex rounded-md border border-border p-0.5">
        {DEMO_EFFECTS_OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={source === o.id}
            disabled={!!o.unavailable}
            title={o.unavailable}
            className={`rounded px-2 py-0.5 disabled:opacity-40 ${source === o.id ? "bg-muted font-medium" : ""}`}
            onClick={() => setDemoEffectsSource(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {note && <span className={error ? "text-destructive" : "text-muted-foreground"} role={error ? "alert" : undefined}>{note}</span>}
    </div>
  );
}
