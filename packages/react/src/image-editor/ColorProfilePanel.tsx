import React, { useEffect, useState } from 'react';
import type { ImageEditorController, Intent } from '@pixerate/editor/image-editor';
import { COLOR_MODE_OPTIONS, INTENT_OPTIONS, PROOF_PROFILE_OPTIONS, WORKING_SPACE_OPTIONS, colorPanelView } from '@pixerate/editor/image-editor';
import { imageChipClass } from './styles';

export interface ColorProfilePanelProps {
  controller: ImageEditorController;
  className?: string;
}
const chip = imageChipClass(false);
const select = 'rounded bg-muted px-1 py-0.5 text-[11px] text-foreground';

/**
 * Colour management: the document's profile (working space) with Assign Profile and Convert to
 * Profile (intent, black point compensation), Image › Mode (RGB, CMYK, Lab), and View › Proof
 * Setup (profile, intent, simulate paper, gamut warning).
 */
export const ColorProfilePanel: React.FC<ColorProfilePanelProps> = ({ controller, className }) => {
  const [, setTick] = useState(0);
  useEffect(() => controller.subscribe(() => setTick((n) => n + 1)), [controller]);
  const [target, setTarget] = useState<string>('display-p3');
  const [intent, setIntent] = useState<Intent>('relative');
  const [bpc, setBpc] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const view = colorPanelView(controller);
  const attempt = (fn: () => unknown) => {
    try {
      setError(null);
      fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const proofWith = (patch: Partial<{ id: string; intent: Intent; simulatePaper: boolean; gamutWarning: boolean }>) => {
    const cur = view.proof;
    const id = patch.id ?? cur?.id ?? 'coated-cmyk';
    attempt(() =>
      controller.setProofSetup({
        profile: id,
        intent: patch.intent ?? cur?.intent ?? 'relative',
        simulatePaper: patch.simulatePaper ?? cur?.simulatePaper ?? false,
        gamutWarning: patch.gamutWarning ?? cur?.gamutWarning ?? false,
      })
    );
  };

  return (
    <div className={`flex flex-col gap-2 text-xs text-foreground ${className ?? ''}`} data-testid="color-profile-panel">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">Profile</span>
        <span data-testid="color-profile-name">{view.profileName}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Colour mode">
        <span className="text-muted-foreground">Mode</span>
        <select aria-label="Colour mode" className={select} value={view.mode} onChange={(e) => attempt(() => controller.setColorMode(e.target.value as 'rgb' | 'cmyk' | 'lab'))}>
          {COLOR_MODE_OPTIONS.map((o) => (
            <option key={o.id} value={o.id} title={o.title}>
              {o.label}
            </option>
          ))}
        </select>
        {view.cmykProfileName && <span className="text-muted-foreground">{view.cmykProfileName}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Assign or convert">
        <select aria-label="Target profile" className={select} value={target} onChange={(e) => setTarget(e.target.value)}>
          {WORKING_SPACE_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <select aria-label="Rendering intent" className={select} value={intent} onChange={(e) => setIntent(e.target.value as Intent)}>
          {INTENT_OPTIONS.map((o) => (
            <option key={o.id} value={o.id} title={o.title}>
              {o.label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1">
          <input type="checkbox" aria-label="Black point compensation" checked={bpc} onChange={(e) => setBpc(e.target.checked)} className="accent-primary" />
          BPC
        </label>
        <button type="button" className={chip} title="Edit › Assign Profile: keep the numbers" onClick={() => attempt(() => controller.assignProfile(target))}>
          Assign
        </button>
        <button type="button" className={chip} title="Edit › Convert to Profile: keep the look" onClick={() => attempt(() => controller.convertToProfile(target, { intent, bpc }))}>
          Convert
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Proof setup">
        <span className="text-muted-foreground">Proof</span>
        <select
          aria-label="Proof profile"
          className={select}
          value={view.proof?.id ?? ''}
          onChange={(e) => (e.target.value ? proofWith({ id: e.target.value }) : attempt(() => controller.setProofSetup(null)))}
        >
          <option value="">Off</option>
          {PROOF_PROFILE_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        {view.proof && (
          <>
            <select aria-label="Proof intent" className={select} value={view.proof.intent} onChange={(e) => proofWith({ intent: e.target.value as Intent })}>
              {INTENT_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1">
              <input type="checkbox" aria-label="Simulate paper colour" checked={view.proof.simulatePaper} onChange={(e) => proofWith({ simulatePaper: e.target.checked })} className="accent-primary" />
              Paper
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" aria-label="Gamut warning" checked={view.proof.gamutWarning} onChange={(e) => proofWith({ gamutWarning: e.target.checked })} className="accent-primary" />
              Gamut warning
            </label>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
};
