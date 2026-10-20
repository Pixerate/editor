/**
 * The colour-management panel's view model, shared by the React and Svelte editors: the profile
 * choices for the working space and for Proof Setup, the rendering intents, and a snapshot of
 * the document's profile and proof for the panel to show.
 */

import { BUILTIN_PROFILES, type BuiltinProfileId, type Intent } from '../../cms';
import type { ImageEditorController } from '../controller';

/** Profiles a document can work in (RGB). */
export const WORKING_SPACE_OPTIONS: readonly { id: BuiltinProfileId; label: string }[] = BUILTIN_PROFILES.filter((b) => b.colorSpace === 'rgb').map((b) => ({ id: b.id, label: b.description }));

/** Profiles to soft-proof with (any colour space). */
export const PROOF_PROFILE_OPTIONS: readonly { id: BuiltinProfileId; label: string }[] = BUILTIN_PROFILES.map((b) => ({ id: b.id, label: b.description }));

export const INTENT_OPTIONS: readonly { id: Intent; label: string; title: string }[] = [
  { id: 'relative', label: 'Relative Colorimetric', title: 'Keep in-gamut colours exact, clip the rest (photos)' },
  { id: 'perceptual', label: 'Perceptual', title: 'Compress the whole gamut smoothly' },
  { id: 'saturation', label: 'Saturation', title: 'Keep colours vivid (graphics)' },
  { id: 'absolute', label: 'Absolute Colorimetric', title: 'Keep the source white too (paper proofs)' },
];

/** Image › Mode choices. */
export const COLOR_MODE_OPTIONS: readonly { id: 'rgb' | 'cmyk' | 'lab'; label: string; title: string }[] = [
  { id: 'rgb', label: 'RGB', title: 'Edit and export RGB in the working space' },
  { id: 'cmyk', label: 'CMYK', title: 'For print: proof through the CMYK profile and export CMYK' },
  { id: 'lab', label: 'Lab', title: 'Export Lab channels' },
];

/** What the colour panel shows. */
export function colorPanelView(controller: ImageEditorController) {
  const profile = controller.getColorProfile();
  const proof = controller.getState().proofSetup ?? null;
  return {
    profileName: profile.name,
    workingSpace: profile.builtin,
    mode: profile.mode,
    cmykProfileName: profile.cmykProfile?.name ?? null,
    proof: proof ? { id: proof.profile.builtin ?? null, name: proof.profile.name, intent: proof.intent, simulatePaper: proof.simulatePaper, gamutWarning: proof.gamutWarning, bpc: proof.bpc } : null,
  };
}
