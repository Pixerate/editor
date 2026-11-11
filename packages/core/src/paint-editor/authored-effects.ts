/**
 * Authored effects in a painting: effects written at run time (by a person or an agent) and kept
 * in the document with their source, values, keyframes and presets, so they can be used as paint,
 * paper, effect layers and fills like a provider's catalog effects, and replay on any machine
 * without the author's session or provider. Their ids are `authored.<name>`; an id never changes
 * what it draws (saving again makes a new id), so strokes painted with it keep their look.
 *
 * Pixel expression effects (`sourceLanguage: 'pixel'`) render with this package's own evaluator.
 * Other documents (a provider's raw shader source, such as Flair's GLSL) render through the
 * provider that wrote them, and only when the host allows raw shader source (`rawShaders`).
 */

import { authoringValuesAt } from "../effects/authoring-session.js";
import type {
  EffectAuthoringDocument,
  EffectAuthoringSession,
} from "../effects/authoring.js";
import {
  EffectUnsupportedError,
  UnknownEffectError,
} from "../effects/errors.js";
import {
  createEffectPixels,
  effectPaintHintProblems,
  searchEffectSummaries,
} from "../effects/helpers.js";
import {
  createPixelRenderer,
  describePixelSource,
  isPixelDocument,
  pixelIssueText,
} from "../effects/pixel-provider.js";
import {
  PIXEL_DEFAULT_LIMITS,
  type PixelLimits,
} from "../effects/pixel-language.js";
import type {
  EffectDescription,
  EffectProvider,
  EffectProviderCapabilities,
  EffectRenderer,
  EffectRendererOptions,
  EffectSearchOptions,
  EffectSummary,
  EffectValues,
} from "../effects/types.js";

/** Prefix of every authored effect id. */
export const AUTHORED_PREFIX = "authored.";
/** The provider id recorded with authored effects. */
export const AUTHORED_PROVIDER_ID = "authored";

/**
 * What a host lets authored effects do:
 * - `off`: authored effects in documents are kept but not drawn (they show as a placeholder), and
 *   nothing can be authored.
 * - `replay` (default): they are drawn, but nothing new can be authored, saved or removed.
 * - `author`: effects can be written, saved into the painting and removed.
 */
export type AuthoredEffectsPolicy = "off" | "replay" | "author";
export const AUTHORED_EFFECTS_POLICIES: readonly AuthoredEffectsPolicy[] = [
  "off",
  "replay",
  "author",
];

/** Budgets that keep authored effects from stalling the editor. */
export interface AuthoredEffectLimits extends PixelLimits {
  /** Side of the square trial render an effect must pass before it is saved (default 64). */
  trialSize?: number;
  /** Most ms the trial render may take (default 100). */
  trialRenderMs?: number;
  /** Most ms one live frame of an authored effect may take; two slow frames in a row freeze it (default 50). */
  liveFrameMs?: number;
}

export const AUTHORED_DEFAULT_LIMITS: Required<AuthoredEffectLimits> = {
  ...PIXEL_DEFAULT_LIMITS,
  trialSize: 64,
  trialRenderMs: 100,
  liveFrameMs: 50,
};

/** One authored effect in a painting. */
export interface PaintAuthoredEffect {
  id: string;
  name: string;
  /** The saved authoring document: source, language, values, keyframes, presets, timing. */
  document: EffectAuthoringDocument;
}

export const isAuthoredEffectId = (id: string): boolean =>
  id.startsWith(AUTHORED_PREFIX);

/** A new id for `name` that `taken` doesn't have (`authored.rings`, `authored.rings-2`, …). */
export function authoredEffectId(
  name: string,
  taken: (id: string) => boolean,
): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "effect";
  let id = AUTHORED_PREFIX + slug;
  for (let n = 2; taken(id); n++) id = `${AUTHORED_PREFIX}${slug}-${n}`;
  return id;
}

/** Authored effects as saved in the painting's JSON (plain JSON documents). */
export function authoredEffectsToJSON(
  map: Readonly<Record<string, PaintAuthoredEffect>>,
): Record<string, unknown> | undefined {
  const ids = Object.keys(map);
  if (!ids.length) return undefined;
  const out: Record<string, unknown> = {};
  for (const id of ids)
    out[id] = {
      name: map[id].name,
      document: JSON.parse(JSON.stringify(map[id].document)),
    };
  return out;
}

/** Authored effects read back from JSON, and what could not be read. */
export function readAuthoredEffects(raw: unknown): {
  effects: Record<string, PaintAuthoredEffect>;
  problems: string[];
} {
  const effects: Record<string, PaintAuthoredEffect> = {};
  const problems: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return {
      effects,
      problems:
        raw === undefined
          ? []
          : ["The authored effects could not be read; they were dropped."],
    };
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const e = v as { name?: unknown; document?: unknown } | null;
    const doc = e?.document as Partial<EffectAuthoringDocument> | undefined;
    if (
      !isAuthoredEffectId(id) ||
      !e ||
      typeof e.name !== "string" ||
      !doc ||
      doc.version !== 1 ||
      typeof doc.providerId !== "string"
    ) {
      problems.push(
        `The authored effect "${id}" could not be read; it was dropped (paint that uses it shows a placeholder).`,
      );
      continue;
    }
    effects[id] = {
      id,
      name: e.name,
      document: JSON.parse(JSON.stringify(doc)) as EffectAuthoringDocument,
    };
  }
  return { effects, problems };
}

/** Controls that are keyframed animate with the effect's time and can't be set where it is used. */
const animatedControls = (doc: EffectAuthoringDocument): Set<string> =>
  new Set(
    Object.entries(doc.tracks ?? {})
      .filter(([, k]) => k.length)
      .map(([n]) => n),
  );

/** A description without its keyframed controls; their saved values become defaults for the rest. */
function asUsed(
  d: EffectDescription,
  entry: PaintAuthoredEffect,
): EffectDescription {
  const doc = entry.document;
  const animated = animatedControls(doc);
  const properties: Record<string, unknown> = {};
  const defaults: Record<string, EffectValues[string]> = {};
  for (const [name, schema] of Object.entries(d.controls.properties)) {
    if (animated.has(name)) continue;
    properties[name] = schema;
    defaults[name] = doc.values?.[name] ?? d.defaults[name];
  }
  const presets = (doc.presets ?? []).map((p) => ({
    ...p,
    values: Object.fromEntries(
      Object.entries(p.values).filter(([k]) => k in properties),
    ),
  }));
  const { paint: _paint, ...rest } = d;
  // The document's paint hint, while the controls left here still fit it.
  const paint =
    doc.paint &&
    !effectPaintHintProblems({ controls: { ...d.controls, properties } as EffectDescription["controls"], paint: doc.paint }).length
      ? doc.paint
      : undefined;
  return {
    ...rest,
    ...(paint ? { paint } : {}),
    id: entry.id,
    name: entry.name,
    category: "authored",
    tags: ["authored", ...(isPixelDocument(doc) ? ["pixel"] : [])],
    description: d.description ?? "An effect authored in this painting.",
    loop: doc.loop,
    duration: doc.duration,
    controls: { ...d.controls, properties } as EffectDescription["controls"],
    defaults,
    presets,
  };
}

const CAPABILITIES: EffectProviderCapabilities = {
  supportsWorker: false,
  supportsFloat: false,
  supportsMask: false,
  supportsHostImages: false,
  supportsVector: false,
  supportsAuthoring: false,
  maxSize: 8192,
};

export interface AuthoredEffectsProviderOptions {
  policy: AuthoredEffectsPolicy;
  /** Draw documents in a provider's raw shader source (through that provider). Default false. */
  rawShaders: boolean;
  /** The editor's provider, for raw shader documents. */
  host: () => EffectProvider | null;
  limits: Required<AuthoredEffectLimits>;
}

/**
 * The painting's authored effects as an effects provider (id `authored`), so every place that
 * draws a provider effect can draw them. Made anew whenever the authored effects change.
 */
export function createAuthoredEffectsProvider(
  effects: Readonly<Record<string, PaintAuthoredEffect>>,
  options: AuthoredEffectsProviderOptions,
): EffectProvider & { dispose(): void } {
  const sessions = new Map<string, Promise<EffectAuthoringSession>>();
  const entryOf = (id: string): PaintAuthoredEffect => {
    const e = effects[id];
    if (!e) {
      const ids = Object.keys(effects);
      throw new UnknownEffectError(
        id,
        `this painting's authored effects (${ids.length ? ids.join(", ") : "none"}; list_authored_effects lists them)`,
      );
    }
    if (options.policy === "off")
      throw new EffectUnsupportedError(
        `Authored effects are turned off in this editor (authoredEffects: "off"), so "${id}" (${e.name}) is not drawn.`,
        id,
      );
    return e;
  };
  const rawSession = (
    e: PaintAuthoredEffect,
  ): Promise<EffectAuthoringSession> => {
    const lang = e.document.sourceLanguage ?? "no source";
    if (!options.rawShaders) {
      throw new EffectUnsupportedError(
        `"${e.id}" (${e.name}) is written in ${lang} for the provider "${e.document.providerId}"; this editor draws only pixel expression effects (raw shader source needs rawShaders: true).`,
        e.id,
      );
    }
    const host = options.host();
    if (!host || host.id !== e.document.providerId || !host.openAuthoring) {
      throw new EffectUnsupportedError(
        `"${e.id}" (${e.name}) needs the provider "${e.document.providerId}" with authoring; ${host ? `the registered provider is "${host.id}"` : "no provider is registered"}.`,
        e.id,
      );
    }
    let s = sessions.get(e.id);
    if (!s) {
      s = Promise.resolve(host.openAuthoring({ document: e.document }));
      s.catch(() => sessions.delete(e.id));
      sessions.set(e.id, s);
    }
    return s;
  };
  const describe = async (id: string): Promise<EffectDescription> => {
    const e = entryOf(id);
    if (isPixelDocument(e.document)) {
      const r = describePixelSource(
        e.document.source,
        { id, name: e.name },
        options.limits,
      );
      if (!r.description)
        throw new EffectUnsupportedError(
          `"${id}" (${e.name}) doesn't compile: ${pixelIssueText(r.issues)}.`,
          id,
        );
      return asUsed(r.description, e);
    }
    return asUsed((await rawSession(e)).getState().description, e);
  };
  const summaries = async (): Promise<EffectSummary[]> => {
    const out: EffectSummary[] = [];
    for (const id of Object.keys(effects)) {
      try {
        const {
          controls: _c,
          defaults: _d,
          presets: _p,
          inputs: _i,
          ...s
        } = await describe(id);
        out.push(s);
      } catch {
        // Not drawable here (policy, raw source, a broken document): list_authored_effects says why.
      }
    }
    return out;
  };
  const createRenderer = async (
    id: string,
    opts: EffectRendererOptions,
  ): Promise<EffectRenderer> => {
    const e = entryOf(id);
    const d = await describe(id);
    const doc = e.document;
    let inner: EffectRenderer;
    if (isPixelDocument(doc)) {
      const r = describePixelSource(
        doc.source,
        { id, name: e.name },
        options.limits,
      );
      inner = createPixelRenderer(r.program!, r.description!, opts);
    } else {
      inner = await (await rawSession(e)).createPreview(opts);
    }
    // Keyframed controls follow the document's tracks at the render's time.
    const valuesAt = (time: number, given: EffectValues | undefined) => ({
      ...authoringValuesAt(doc, time),
      ...d.defaults,
      ...(given ?? {}),
    });
    const animated = animatedControls(doc);
    const withTracks = (time: number, given: EffectValues | undefined) => {
      const v = valuesAt(time, given);
      const at = authoringValuesAt(doc, time);
      for (const name of animated) v[name] = at[name];
      return v;
    };
    return {
      effectId: id,
      width: inner.width,
      height: inner.height,
      depth: inner.depth,
      render: (req) =>
        inner.render({ ...req, values: withTracks(req.time ?? 0, req.values) }),
      ...(inner.renderSync
        ? {
            renderSync: (req) =>
              inner.renderSync!({
                ...req,
                values: withTracks(req.time ?? 0, req.values),
              }),
          }
        : {}),
      dispose: () => inner.dispose(),
    };
  };
  return {
    id: AUTHORED_PROVIDER_ID,
    name: "Authored effects",
    capabilities: CAPABILITIES,
    list: async (o?: EffectSearchOptions) =>
      searchEffectSummaries(await summaries(), "", o),
    search: async (q: string, o?: EffectSearchOptions) =>
      searchEffectSummaries(await summaries(), q, o),
    describe,
    createRenderer,
    dispose: () => {
      for (const s of sessions.values())
        s.then(
          (x) => x.dispose(),
          () => {},
        );
      sessions.clear();
    },
  };
}

/**
 * The provider the paint tools search and describe with: the editor's provider, with the
 * painting's authored effects added to its lists and routed by id. It keeps the editor
 * provider's id, name and capabilities.
 */
export function withAuthoredEffects(
  host: EffectProvider | null,
  authored: EffectProvider,
  hasAuthored: () => boolean,
): EffectProvider | null {
  if (!host && !hasAuthored()) return null;
  const merge = async (
    a: readonly EffectSummary[] | Promise<readonly EffectSummary[]>,
    b: Promise<readonly EffectSummary[]> | readonly EffectSummary[],
  ) => [...(await a), ...(await b)];
  const base: EffectProvider = host ?? {
    id: AUTHORED_PROVIDER_ID,
    name: "Authored effects",
    capabilities: CAPABILITIES,
    list: () => [],
    search: () => [],
    describe: (id) => authored.describe(id),
    createRenderer: (id, o) => authored.createRenderer(id, o),
  };
  return {
    ...base,
    id: base.id,
    name: base.name,
    capabilities: base.capabilities,
    list: (o?: EffectSearchOptions) =>
      merge(
        Promise.resolve(base.list(o)),
        hasAuthored() ? Promise.resolve(authored.list(o)) : [],
      ),
    search: (q: string, o?: EffectSearchOptions) =>
      merge(
        Promise.resolve(base.search(q, o)),
        hasAuthored() ? Promise.resolve(authored.search(q, o)) : [],
      ),
    describe: (id: string) =>
      isAuthoredEffectId(id) ? authored.describe(id) : base.describe(id),
    createRenderer: (id: string, o: EffectRendererOptions) =>
      isAuthoredEffectId(id)
        ? authored.createRenderer(id, o)
        : base.createRenderer(id, o),
  };
}

/** Renders `size`² once and times it: the check an effect passes before it is saved. */
export async function trialRender(
  provider: EffectProvider,
  id: string,
  limits: Required<AuthoredEffectLimits>,
  now: () => number,
): Promise<{ ms: number; problem: string | null }> {
  const r = await provider.createRenderer(id, {
    width: limits.trialSize,
    height: limits.trialSize,
  });
  try {
    const t0 = now();
    const out = r.renderSync
      ? r.renderSync({ time: 0 })
      : await r.render({ time: 0 });
    const ms = now() - t0;
    if (out.data.length !== limits.trialSize * limits.trialSize * 4)
      return {
        ms,
        problem: "the trial render returned the wrong number of pixels",
      };
    if (ms >= limits.trialRenderMs)
      return {
        ms,
        problem: `a ${limits.trialSize}×${limits.trialSize} trial render took ${Math.round(ms)} ms; the limit is ${limits.trialRenderMs} ms. Simplify the effect (fewer noise calls, more let sharing)`,
      };
    return { ms, problem: null };
  } finally {
    r.dispose();
  }
}

/** Transparent pixels of `size` (a placeholder). */
export const blankPixels = (w: number, h: number) => createEffectPixels(w, h);
