/**
 * Agent tools for writing effects at run time in the paint editor and keeping them in the
 * painting: `open_effect_authoring` (a pixel expression template, an authored effect or a
 * provider effect), the shared `effect_authoring_*` tools on the open session (source, values,
 * keyframes, presets, timing, undo), `save_authored_effect` (a trial render, then an
 * `authored.<name>` id usable anywhere an effect id is: set_effect_paint, set_paper_effect,
 * add_effect_layer, fill_layer_with_effect), `list_authored_effects`, `remove_authored_effect`
 * and `close_effect_authoring`.
 */

import { createEffectAuthoringToolProvider } from "../effects/authoring-tools.js";
import { PIXEL_TEMPLATES } from "../effects/pixel-provider.js";
import { effectParameterFields } from "../effects/ui.js";
import type { AgentTool, AgentToolProvider } from "../tools/registry.js";
import type { PaintEditorController } from "./controller";
import { withPaintPlayback } from "./playback";

export interface PaintEffectAuthoringToolProviderOptions {
  /** Provider id (unique per registry). Default `paint-effect-authoring`. */
  id?: string;
  /** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
  namespace?: string;
  /** The painting cannot be edited: saving and removing are refused. A string is the reason. */
  readOnly?: boolean | string | (() => boolean | string);
  /** The agent playback surface (default `paint`). */
  playbackSurface?: string;
}

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const EMPTY = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const NO_SESSION =
  "No effect is open for authoring; open one with open_effect_authoring (start from pixel.blank to write a new effect), then use the effect_authoring_* tools.";

/** The authoring tools for a paint editor (see the module comment). */
export function createPaintEffectAuthoringToolProvider(
  controller: PaintEditorController,
  options: PaintEffectAuthoringToolProviderOptions = {},
): AgentToolProvider {
  const readOnly = (): string | null => {
    const ro =
      typeof options.readOnly === "function"
        ? options.readOnly()
        : options.readOnly;
    return ro
      ? typeof ro === "string"
        ? ro
        : "The painting is read-only."
      : null;
  };
  const writable = () => {
    const r = readOnly();
    if (r) throw new Error(`${r} Authored effects can't be saved or removed.`);
  };
  const shared = createEffectAuthoringToolProvider(
    {
      session: () => controller.authoringSession,
      subscribe: (notify) => controller.subscribeAuthoring(notify),
      noSession: NO_SESSION,
      alwaysListSetSource: true,
    },
    { id: "effect-authoring" },
  );
  const sharedTools = shared.tools as () => AgentTool[];

  const opened = () => {
    const s = controller.authoringSession!;
    const st = s.getState();
    return {
      from: controller.authoringFrom,
      name: st.name,
      sourceLanguage: st.sourceLanguage,
      ...(st.source !== null ? { source: st.source } : {}),
      controls: effectParameterFields(st.description),
      values: st.values,
      issues: st.issues,
      compiled: st.compiled,
      duration: st.duration,
      loop: st.loop,
    };
  };

  const own: AgentTool[] = [
    {
      name: "open_effect_authoring",
      title: "Open an effect for authoring",
      description: `Opens an effect to write or change: a pixel expression template to write a new effect (${PIXEL_TEMPLATES.map((t) => `${t.id}: ${t.description}`).join(" ")}), one of the painting's authored effects (list_authored_effects; saving makes a new id), or a provider effect when the provider supports authoring (values, keyframes and presets only). Returns the source (pixel expressions, see the skill), the controls, values and issues. One effect is open at a time: save_authored_effect or close_effect_authoring first. Refused when the editor doesn't allow authoring (authoredEffects not "author").`,
      inputSchema: {
        type: "object",
        properties: {
          effect: {
            type: "string",
            minLength: 1,
            description:
              "pixel.blank, pixel.rings or pixel.clouds; an authored.<name> id; or a provider effect id from search_effects.",
          },
        },
        required: ["effect"],
        additionalProperties: false,
      },
      annotations: { title: "Open an effect for authoring", ...WRITE },
      handler: async (args) => {
        await controller.openEffectAuthoring(args.effect as string);
        return opened();
      },
    },
    {
      name: "save_authored_effect",
      title: "Save the authored effect into the painting",
      description:
        "Saves the open effect into the painting as a new authored effect, after a trial render within budget (the source must compile). Returns its id (authored.<name>), name, controls (keyframed controls animate with the effect time and are listed as animated), duration and loop. Use the id with set_effect_paint, set_paper_effect, add_effect_layer or fill_layer_with_effect. One undo step. The session stays open: save again after changes to get another id (ids never change what they draw).",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            minLength: 1,
            maxLength: 80,
            description:
              "The effect's name (default: the session's name); the id is made from it.",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Save the authored effect into the painting",
        ...WRITE,
      },
      handler: async (args) => {
        writable();
        const e = await controller.saveAuthoredEffect({
          name: args.name as string | undefined,
        });
        const d = (await controller.listAuthoredEffects()).find(
          (x) => x.id === e.id,
        )!;
        return {
          id: e.id,
          name: e.name,
          controls: d.controls,
          animated: d.animated,
          duration: d.duration,
          loop: d.loop,
        };
      },
    },
    {
      name: "list_authored_effects",
      title: "List the authored effects",
      description:
        "Lists the painting's authored effects: id, name, language, controls, keyframed (animated) controls, duration, loop, where each is used (strokes, the effect paint, the paper, effect layers), and a problem when one can't draw here (the editor's policy, raw shader source, a stopped live playback). Also the editor's policy and the open authoring session.",
      inputSchema: EMPTY,
      annotations: { title: "List the authored effects", ...READ },
      handler: async () => ({
        policy: controller.authoredPolicy,
        open: controller.authoringSession
          ? {
              from: controller.authoringFrom,
              name: controller.authoringSession.getState().name,
            }
          : null,
        effects: await controller.listAuthoredEffects(),
      }),
    },
    {
      name: "remove_authored_effect",
      title: "Remove an authored effect",
      description:
        "Removes an authored effect the painting no longer uses. Refused, saying where, while strokes, the effect paint, the paper or an effect layer use it. Returns the removed id and name. One undo step.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            minLength: 1,
            description:
              "An authored effect id (authored.<name>) from list_authored_effects.",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: { title: "Remove an authored effect", ...DESTRUCTIVE },
      handler: (args) => {
        writable();
        return controller.removeAuthoredEffect(args.id as string);
      },
    },
    {
      name: "close_effect_authoring",
      title: "Close the authoring session",
      description:
        "Closes the open authoring session without saving (save_authored_effect first to keep it). Nothing in the painting changes. Returns the closed effect name, or null when nothing was open.",
      inputSchema: EMPTY,
      annotations: {
        title: "Close the authoring session",
        ...WRITE,
        idempotentHint: true,
      },
      handler: () => ({ closed: controller.closeEffectAuthoring() }),
    },
  ];

  return withPaintPlayback(
    {
      id: options.id ?? "paint-effect-authoring",
      ...(options.namespace !== undefined
        ? { namespace: options.namespace }
        : {}),
      title: "Paint effect authoring",
      description:
        "Write effects in pixel expressions, keep them in the painting and paint with them.",
      skill: "pixerate-effect-authoring",
      tools: () => [...own, ...sharedTools()],
      subscribe: (notify) => {
        const a = controller.subscribeAuthoring(notify);
        const b = controller.subscribe(() => notify());
        return () => {
          a();
          b();
        };
      },
    },
    { director: false, surface: options.playbackSurface },
  );
}
