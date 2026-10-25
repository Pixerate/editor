import React from 'react';
import type { EffectProvider } from '@pixerate/editor/effects';
import { EffectParameters, useEffectDescription } from '../effects';

export interface ImageEffectControlsProps {
  provider: EffectProvider | null;
  effect: string;
  name?: string;
  values: Readonly<Record<string, unknown>>;
  onChange: (control: string, value: unknown, gesture: string | null) => void;
  onPreset: (values: Readonly<Record<string, unknown>>) => void;
}

/** One effect's controls, loaded from the provider; a note when it does not have the effect. Parity with Svelte's `<ImageEffectControls>`. */
export function ImageEffectControls({ provider, effect, name, values, onChange, onPreset }: ImageEffectControlsProps) {
  const { description, error } = useEffectDescription(provider, effect);
  if (!provider) return <p className="text-[11px] text-slate-400">No effects provider: "{name ?? effect}" is kept but not drawn.</p>;
  if (error) return <p className="text-[11px] text-amber-400">{error}</p>;
  if (!description) return <p className="text-[11px] text-slate-400">Loading…</p>;
  return <EffectParameters description={description} values={values} onChange={onChange} onReset={(k) => onChange(k, description.defaults[k], null)} onPreset={onPreset} />;
}
