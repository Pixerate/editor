import React, { useEffect, useState } from "react";
import { EffectsBrowser, EffectAuthoringEditor } from "@pixerate/editor-react/effects";
import type { EffectAuthoringSession } from "@pixerate/editor/effects";
import { createEffectAuthoringToolProvider } from "@pixerate/editor/effects";
import { useAgentToolProvider } from "@pixerate/editor-react";
import { useDemoEffects } from "../demoEffects";
import { demoToolRegistry } from "../agentTools";
import { EffectsProviderSwitch } from "./EffectsProviderSwitch";

export function EffectAuthoringTab() {
  const { provider, error, loading } = useDemoEffects();
  const [selectedEffectId, setSelectedEffectId] = useState<string>("fake.invert");
  const [session, setSession] = useState<EffectAuthoringSession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  // Open authoring session when selectedEffectId or provider changes
  useEffect(() => {
    if (!provider) {
      setSession(null);
      return;
    }

    if (!provider.supportsAuthoring || !provider.openAuthoring) {
      setSession(null);
      return;
    }

    let live = true;
    setSessionLoading(true);
    setSessionError(null);

    Promise.resolve(provider.openAuthoring({ effectId: selectedEffectId }))
      .then((s) => {
        if (!live) return;
        setSession(s);
        setSessionLoading(false);
      })
      .catch((err) => {
        if (!live) return;
        setSessionError(err instanceof Error ? err.message : String(err));
        setSession(null);
        setSessionLoading(false);
      });

    return () => {
      live = false;
    };
  }, [provider, selectedEffectId]);

  // Expose agent authoring tools when session is active
  useAgentToolProvider(
    demoToolRegistry,
    () => (session ? createEffectAuthoringToolProvider(session) : null),
    [session]
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-lg font-bold text-slate-100">Effect Authoring</h2>
          <p className="text-xs text-slate-400">
            Interactive visual editor, keyframe timeline, parameter controls and source editing.
          </p>
        </div>
        <EffectsProviderSwitch />
      </div>

      {loading && <p className="text-xs text-slate-400">Loading effects provider…</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-4">
        {/* Left Column: Catalog Browser */}
        <div className="space-y-3 lg:col-span-1">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Effect Catalog
          </h3>
          {provider ? (
            <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
              <EffectsBrowser
                provider={provider}
                selected={selectedEffectId}
                onSelect={(effect) => setSelectedEffectId(effect.id)}
              />
            </div>
          ) : (
            <div className="rounded-lg border border-slate-800 bg-slate-900/20 p-4 text-xs text-slate-500">
              No effect provider registered.
            </div>
          )}
        </div>

        {/* Right Column: Authoring Editor */}
        <div className="space-y-3 lg:col-span-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Authoring Workspace
          </h3>

          {!provider ? (
            <div className="rounded-lg border border-slate-800 bg-slate-900/20 p-8 text-center text-xs text-slate-500">
              Select an effects provider to author effects.
            </div>
          ) : !provider.supportsAuthoring || !provider.openAuthoring ? (
            <div className="rounded-lg border border-slate-800 bg-slate-900/20 p-8 text-center text-xs text-slate-500">
              The current provider ({provider.id}) does not support authoring.
            </div>
          ) : sessionLoading ? (
            <div className="rounded-lg border border-slate-800 bg-slate-900/20 p-8 text-center text-xs text-slate-500">
              Opening authoring session for {selectedEffectId}…
            </div>
          ) : sessionError ? (
            <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-xs text-destructive">
              Failed to open authoring session: {sessionError}
            </div>
          ) : session ? (
            <EffectAuthoringEditor session={session} />
          ) : (
            <div className="rounded-lg border border-slate-800 bg-slate-900/20 p-8 text-center text-xs text-slate-500">
              Select an effect from the catalog to begin authoring.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
