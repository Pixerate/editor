import type { AgentTool } from '../tools/registry.js';
import type { ImageEditorController } from './controller';
import { BUILTIN_PROFILES, INTENTS, type Intent } from '../cms';
import { base64ToBytes } from '../raster/png';
import { LayerOperationError } from './layers/ops';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const PROFILE = {
  type: 'string',
  description: `A built-in profile id (${BUILTIN_PROFILES.map((b) => b.id).join(', ')}; names like "Adobe RGB (1998)" work too), or "icc:<base64>" for ICC profile bytes.`,
} as const;

const INTENT = {
  type: 'string',
  enum: [...INTENTS],
  description:
    'Rendering intent (default relative): relative (colorimetric, white to white, clips out-of-gamut colours: best for most photos), perceptual (compresses the whole gamut smoothly), saturation (keeps colours vivid, for graphics), absolute (keeps the source white too: for proofing a paper colour).',
} as const;

function profileArg(v: unknown): string | Uint8Array {
  const s = String(v);
  if (s.startsWith('icc:')) {
    try {
      return base64ToBytes(s.slice(4));
    } catch {
      throw new LayerOperationError('The icc: value is not valid base64.');
    }
  }
  return s;
}

/**
 * Agent tools for colour management: `get_color_profile` (the document's profile, mode, Proof
 * Setup and the built-in profiles), `assign_profile`, `convert_to_profile`, `set_color_mode`
 * (each one undo step), `set_proof_setup` (view state) and `convert_colors` (read-only).
 */
export function createImageColorTools(controller: ImageEditorController): AgentTool[] {
  const getProfile: AgentTool = {
    name: 'get_color_profile',
    title: 'Get the colour profile',
    description:
      "Reads the document's colour profile (its working space: name, builtin id or null for an embedded profile, colorSpace, srgb true when it means sRGB, mode rgb / cmyk / lab and, for cmyk, cmykProfile), the Proof Setup (profile, intent, bpc, simulatePaper, gamutWarning, or null) and the built-in profiles you can assign, convert to or proof with ({id, description, colorSpace}).",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Get the colour profile', ...READ },
    handler: () => {
      const proof = controller.getState().proofSetup;
      return {
        profile: controller.getColorProfile(),
        proof: proof ? { profile: proof.profile.name, builtin: proof.profile.builtin ?? null, intent: proof.intent, bpc: proof.bpc, simulatePaper: proof.simulatePaper, gamutWarning: proof.gamutWarning } : null,
        builtins: BUILTIN_PROFILES.map((b) => ({ ...b })),
      };
    },
  };

  const assign: AgentTool = {
    name: 'assign_profile',
    title: 'Assign a colour profile',
    description:
      "Edit › Assign Profile: the document's RGB numbers now mean colours in `profile`; no pixel changes, so the image looks different unless the profiles match. Use it when a file was saved without its profile, or with the wrong one. To keep the look and change the numbers, use convert_to_profile. RGB profiles only. One undo step. Returns the new profile.",
    inputSchema: { type: 'object', properties: { profile: PROFILE }, required: ['profile'], additionalProperties: false },
    annotations: { title: 'Assign a colour profile', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (args) => controller.assignProfile(profileArg(args.profile)),
  };

  const convert: AgentTool = {
    name: 'convert_to_profile',
    title: 'Convert to a colour profile',
    description:
      "Edit › Convert to Profile: converts every pixel layer's numbers so its colours stay the same in `profile`, then makes `profile` the document's. Colours outside the new space are mapped by `intent`. Shape fills and strokes, text colours, layer-effect colours and annotation colours convert too (and re-render); smart objects keep their contents' numbers and are listed in unconvertedLayerIds. RGB profiles only (proof CMYK with set_proof_setup). One undo step. Returns the profile, convertedLayerIds and unconvertedLayerIds.",
    inputSchema: {
      type: 'object',
      properties: {
        profile: PROFILE,
        intent: INTENT,
        bpc: { type: 'boolean', description: 'Black point compensation: map black to black (default true).' },
      },
      required: ['profile'],
      additionalProperties: false,
    },
    annotations: { title: 'Convert to a colour profile', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: (args) => controller.convertToProfile(profileArg(args.profile), { intent: args.intent as Intent | undefined, bpc: args.bpc as boolean | undefined }),
  };

  const proof: AgentTool = {
    name: 'set_proof_setup',
    title: 'Set up soft proofing',
    description:
      "View › Proof Setup: shows the document in the viewport as `profile` would reproduce it (for example coated-cmyk for a press), with `intent`; `simulatePaper` shows the paper white and ink black; `gamutWarning` greys out colours the profile cannot reproduce. Pass off true to stop proofing. View state, not an undo step; pixels never change. Check the result with capture_view. Returns the setup (or null).",
    inputSchema: {
      type: 'object',
      properties: {
        profile: PROFILE,
        intent: INTENT,
        bpc: { type: 'boolean', description: 'Black point compensation (default true).' },
        simulatePaper: { type: 'boolean', description: 'Simulate paper colour and black ink (default false).' },
        gamutWarning: { type: 'boolean', description: 'Grey out out-of-gamut colours (default false).' },
        off: { type: 'boolean', description: 'Turn proofing off instead (default false).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Set up soft proofing', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (args) => {
      if (args.off === true) {
        if (args.profile !== undefined) throw new LayerOperationError('Give either off true or a profile, not both.');
        return controller.setProofSetup(null);
      }
      if (args.profile === undefined) throw new LayerOperationError('Pass the profile to proof with (e.g. coated-cmyk), or off true.');
      const s = controller.setProofSetup({
        profile: profileArg(args.profile),
        ...(args.intent !== undefined ? { intent: args.intent as Intent } : {}),
        ...(args.bpc !== undefined ? { bpc: args.bpc as boolean } : {}),
        ...(args.simulatePaper !== undefined ? { simulatePaper: args.simulatePaper as boolean } : {}),
        ...(args.gamutWarning !== undefined ? { gamutWarning: args.gamutWarning as boolean } : {}),
      })!;
      return { profile: s.profile.name, builtin: s.profile.builtin ?? null, intent: s.intent, bpc: s.bpc, simulatePaper: s.simulatePaper, gamutWarning: s.gamutWarning };
    },
  };

  const convertColors: AgentTool = {
    name: 'convert_colors',
    title: 'Convert colours between profiles',
    description:
      "Converts 1 to 64 #rrggbb colours from the document's profile (or `from`) into `to` with `intent`: returns per colour the channel values 0..1 (RGB, CMYK, grey; Lab as L/100, (a+128)/255, (b+128)/255), a hex for RGB targets, and L*a*b* (D50). Use it to answer \"what are these CMYK values\" or to pick colours that survive printing. Changes nothing.",
    inputSchema: {
      type: 'object',
      properties: {
        colors: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', description: 'A colour #rrggbb.' }, description: 'Colours in the source profile.' },
        to: PROFILE,
        from: { ...PROFILE, description: `Source profile (default the document's). ${PROFILE.description}` },
        intent: INTENT,
        bpc: { type: 'boolean', description: 'Black point compensation (default true).' },
      },
      required: ['colors', 'to'],
      additionalProperties: false,
    },
    annotations: { title: 'Convert colours between profiles', ...READ },
    handler: (args) => ({
      colors: controller.convertColors(args.colors as string[], profileArg(args.to), {
        ...(args.from !== undefined ? { from: profileArg(args.from) } : {}),
        intent: args.intent as Intent | undefined,
        bpc: args.bpc as boolean | undefined,
      }),
    }),
  };

  const setMode: AgentTool = {
    name: 'set_color_mode',
    title: 'Set the colour mode',
    description:
      "Image › Mode: rgb, cmyk (for print: give the press `profile`, default coated-cmyk, and the `intent` RGB is separated with) or lab. The document is still edited as RGB in its working space; a CMYK document is soft-proofed through its profile in the viewport (unless set_proof_setup says otherwise), and export_psd writes CMYK or Lab channels with the profile, at 8 or 16 bits (a 32-bit document is written at 16). Changes no pixels. One undo step. Returns the profile summary with mode and cmykProfile.",
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['rgb', 'cmyk', 'lab'], description: 'The colour mode.' },
        profile: { ...PROFILE, description: `CMYK mode only: the CMYK profile (default coated-cmyk). ${PROFILE.description}` },
        intent: INTENT,
      },
      required: ['mode'],
      additionalProperties: false,
    },
    annotations: { title: 'Set the colour mode', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (args) => {
      if (args.mode !== 'cmyk' && (args.profile !== undefined || args.intent !== undefined)) throw new LayerOperationError('profile and intent apply to CMYK mode only.');
      return controller.setColorMode(args.mode as 'rgb' | 'cmyk' | 'lab', {
        ...(args.profile !== undefined ? { profile: profileArg(args.profile) } : {}),
        ...(args.intent !== undefined ? { intent: args.intent as Intent } : {}),
      });
    },
  };

  return [getProfile, assign, convert, proof, convertColors, setMode];
}
