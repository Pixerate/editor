import React, { useEffect, useMemo, useState } from "react";
import { EffectsBrowser, EffectAuthoringEditor } from "@pixerate/editor-react/effects";
import type { EffectAuthoringSession } from "@pixerate/editor/effects";
import { createEffectAuthoringToolProvider } from "@pixerate/editor/effects";
import { useAgentToolProvider } from "@pixerate/editor-react";
import { useDemoEffects } from "../demoEffects";
import { demoToolRegistry } from "../agentTools";
import { EffectsProviderSwitch } from "./EffectsProviderSwitch";
import { EditorPage, EditorPanel } from "./EditorPage";
import { Wand2 } from "lucide-react";

function EffectAuthoringView() {
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

    if (!provider.capabilities.supportsAuthoring || !provider.openAuthoring) {
      setSession(null);
      return;
    }

    let live = true;
    let opened: EffectAuthoringSession | null = null;
    setSessionLoading(true);
    setSessionError(null);

    Promise.resolve(provider.openAuthoring({ effectId: selectedEffectId }))
      .then((s) => {
        if (!live) {
          s.dispose();
          return;
        }
        opened = s;
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
      opened?.dispose();
    };
  }, [provider, selectedEffectId]);

  // Expose agent authoring tools when session is active
  const authoringTools = useMemo(
    () => (session ? createEffectAuthoringToolProvider({ session: () => session }) : null),
    [session]
  );
  useAgentToolProvider(demoToolRegistry, authoringTools);

  return (
    <div className="space-y-4">
      {/* Picks the provider whose effects the catalog lists (shows in Options). */}
      <EffectsProviderSwitch />
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
              <EffectsBrowser provider={provider} onPick={(effect) => setSelectedEffectId(effect.id)} />
            </div>
          ) : (
            <div className="rounded-lg border border-slate-800 bg-slate-900/20 p-4 text-xs text-slate-500">
              No effect provider registered.
            </div>
          )}
        </div>

        {/* Right Column: Authoring Editor */}
        <div className="space-y-3 lg:col-span-3">
          {!provider ? (
            <div className="rounded-lg border border-slate-800 bg-slate-900/20 p-8 text-center text-xs text-slate-500">
              Select an effects provider to author effects.
            </div>
          ) : !provider.capabilities.supportsAuthoring || !provider.openAuthoring ? (
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
      <EditorPanel id="tips" label="Tips">
        <p className="text-xs leading-relaxed text-slate-400">
          Pick an effect in the catalog to open an authoring session for it: a visual editor, a keyframe timeline, parameter
          controls and source editing. Authoring needs a provider that supports it; switch providers under Options. While a
          session is open, agents get its authoring tools (see Tools).
        </p>
      </EditorPanel>
    </div>
  );
}

const EFFECTS_VIEWS = [{ id: "authoring", label: "Authoring", render: () => <EffectAuthoringView /> }];

export function EffectAuthoringTab() {
  return (
    <EditorPage
      tab="effects"
      title="Effect Authoring"
      icon={Wand2}
      description="Build and tune effects from a provider's catalog: visual editing, keyframes, parameters and source."
      views={EFFECTS_VIEWS}
    />
  );
}
