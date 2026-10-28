import React from 'react';
import type { EffectProvider } from '@pixerate/editor/effects';
import { EffectParameters, useEffectDescription } from '../effects';
import { useImageEditorControls } from './controls/controls.js';
import { imageEditorParameterComponents } from './controls/parameterControls.js';
import { resolveParameterComponents, useParameterComponents, type ParameterComponents } from '../parameters/controls.js';

export interface ImageEffectControlsProps {
  provider: EffectProvider | null;
  effect: string;
  name?: string;
  values: Readonly<Record<string, unknown>>;
  onChange: (control: string, value: unknown, gesture: string | null) => void;
  onPreset: (values: Readonly<Record<string, unknown>>) => void;
  /** Extra classes on the root element. */
  className?: string;
  /** Host parameter controls; else those of a `ParameterComponentsProvider`, else the image editor's host `Range` / `Select`. */
  components?: ParameterComponents;
}

/** One effect's controls, loaded from the provider; a note when it does not have the effect. Parity with Svelte's `<ImageEffectControls>`. */
export function ImageEffectControls({ provider, effect, name, values, onChange, onPreset, className, components }: ImageEffectControlsProps) {
  const { description, error } = useEffectDescription(provider, effect);
  const fallback = resolveParameterComponents(useParameterComponents(), imageEditorParameterComponents(useImageEditorControls()));
  const effectiveComponents = resolveParameterComponents(components, fallback);

  let body: React.ReactNode;
  if (!provider) body = <p className="text-[11px] text-muted-foreground">No effects provider: "{name ?? effect}" is kept but not drawn.</p>;
  else if (error) body = <p className="text-[11px] text-amber-600">{error}</p>;
  else if (!description) body = <p className="text-[11px] text-muted-foreground">Loading…</p>;
  else body = <EffectParameters description={description} values={values} onChange={onChange} onReset={(k) => onChange(k, description.defaults[k], null)} onPreset={onPreset} components={effectiveComponents} />;
  return <div className={className} data-testid="image-effect-controls">{body}</div>;
}
