import { Extension, type Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Slice } from "@tiptap/pm/model";
import type { Step } from "@tiptap/pm/transform";
import { plainTextToSlice } from "../serializers/plain-text";
import { TRACK_CHANGES_SKIP_META } from "./track-changes";
import { planAgentTyping, type AgentTypingOptions } from "../tools/agent-typing.js";
import type { EffectProvider, EffectValues } from "../effects/types.js";
import {
  builtInTextTreatmentPlan,
  planTextTreatment,
  supportsTextTreatments,
  type TextTreatmentLayer,
  type TextTreatmentPlan,
  type TextTreatmentRect,
  type TextTreatmentStage,
  type TextTreatmentTarget,
} from "../effects/text-treatment.js";
import { parseCssColor } from "../image-editor/layers/css-color.js";

export type { AgentTypingOptions } from "../tools/agent-typing.js";

/**
 * Inline agent carets: a coloured caret with a name tag at a document position, the agent's
 * selection highlighted, and the text it just changed tinted for a moment — as collaborators'
 * cursors look in Google Docs. Decorations, so they follow the text as anyone edits it.
 *
 * `typeAgentText` plays an edit out a few characters at a time and still lands it as one undo step.
 *
 * With an effects provider that has text treatments (`setAgentTextTreatments`), each stage of an
 * agent's edit (checking, selecting, typing, landed, and its caret) is drawn from the treatment
 * chosen for that agent, in an overlay behind and above the text, instead of as decorations.
 */

export const DEFAULT_AGENT_CARET_COLOR = "#8b5cf6";
export const DEFAULT_AGENT_CARET_NAME = "Agent";

export interface AgentCaretInput {
  /** Stable id of the agent (one caret per id). */
  id: string;
  /** Name on the caret's tag (default "Agent"). */
  name?: string;
  /** CSS colour of the caret, tag and highlights (default violet). */
  color?: string;
  /** Selection anchor (document position). */
  from: number;
  /** Selection head, where the caret is drawn (default `from`). */
  to?: number;
  /**
   * What the agent is doing, for a text treatment (default `selecting` when `from < to`, else
   * `caret`). `typeAgentText` sets it as it plays an edit.
   */
  stage?: AgentCaretStage;
  /** `checking`: the range being looked over. */
  check?: { from: number; to: number };
  /** The text treatment this agent's edits are drawn with (default the provider's default). */
  treatment?: string;
  /** Values for the treatment; `color` defaults to the caret's colour. */
  treatmentValues?: EffectValues;
}

/** What an agent is doing at its caret: the text treatment stage drawn there (`landed` is drawn on its changed ranges). */
export type AgentCaretStage = "caret" | "checking" | "selecting" | "typing";

export interface AgentCaret {
  id: string;
  name: string;
  color: string;
  anchor: number;
  head: number;
  /** Ranges the agent just changed, tinted until `clearAgentChanges`. */
  changed: Array<{ from: number; to: number }>;
  /** What it is doing, and since when (the treatment clock, ms). */
  stage: AgentCaretStage;
  stageSince: number;
  /** `checking`: the range being looked over. */
  check?: { from: number; to: number };
  /** When its changed ranges landed (the treatment clock, ms). */
  changedSince?: number;
  treatment?: string;
  treatmentValues?: EffectValues;
}

/** How an editor draws agents' edits with text treatments (`setAgentTextTreatments`). */
export interface AgentTextTreatmentOptions {
  /**
   * Where treatments come from. Without one, or with one that has no text treatments
   * (`capabilities.supportsTextTreatments`), carets are drawn as decorations, as before.
   */
  provider: EffectProvider | null;
  /** The treatment for agents that don't choose one (default the provider's `defaultTextTreatment`). */
  treatment?: string;
  /** Draw without motion (default: the system's Reduce Motion setting). */
  reduceMotion?: boolean;
  /** The clock in ms (default `performance.now`); injectable for tests. */
  now?: () => number;
}

/** A range an agent is typing into, mapped through everyone's edits (see `typeAgentText`). */
interface TypingSpan {
  from: number;
  to: number;
  /** Someone else changed the document while the agent typed. */
  foreign: boolean;
}

interface AgentCaretState {
  carets: AgentCaret[];
  spans: Record<string, TypingSpan>;
  decorations: DecorationSet;
  treatments: AgentTextTreatmentOptions | null;
}

type AgentCaretMeta =
  | { set: AgentCaretInput }
  | { treatments: AgentTextTreatmentOptions | null }
  | { clear: string | null }
  | { changed: { id: string; ranges: Array<{ from: number; to: number }> } }
  | { span: { id: string; from: number; to: number } | { id: string; end: true } };

export const agentCaretPluginKey = new PluginKey<AgentCaretState>("agentCaret");

const clamp = (pos: number, size: number) => Math.max(0, Math.min(size, Math.round(pos)));

function caretWidget(caret: AgentCaret) {
  return (view: EditorView) => {
    const doc = view.dom.ownerDocument;
    const el = doc.createElement("span");
    el.className = "pe-agent-caret";
    el.setAttribute("data-agent-id", caret.id);
    el.setAttribute("contenteditable", "false");
    el.setAttribute("aria-hidden", "true");
    el.style.cssText =
      `position:relative;margin-left:-1px;margin-right:-1px;border-left:2px solid ${caret.color};` +
      "word-break:normal;pointer-events:none;";
    const label = doc.createElement("span");
    label.className = "pe-agent-caret-label";
    label.textContent = caret.name;
    label.style.cssText =
      `position:absolute;left:-2px;bottom:100%;background:${caret.color};color:#fff;` +
      "font:600 11px/1.5 system-ui,sans-serif;padding:0 5px;border-radius:3px 3px 3px 0;" +
      "white-space:nowrap;user-select:none;pointer-events:none;";
    el.append("⁠", label, "⁠");
    return el;
  };
}

const tint = (color: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

/** Whether carets are drawn by a text treatment overlay rather than decorations. */
const treated = (t: AgentTextTreatmentOptions | null | undefined): t is AgentTextTreatmentOptions => !!t && supportsTextTreatments(t.provider);

const clockOf = (t: AgentTextTreatmentOptions | null | undefined) =>
  t?.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));

function buildDecorations(state: EditorState, carets: AgentCaret[], treatments: AgentTextTreatmentOptions | null): DecorationSet {
  if (treated(treatments)) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  for (const caret of carets) {
    for (const range of caret.changed) {
      decorations.push(
        Decoration.inline(range.from, range.to, {
          class: "pe-agent-changed",
          "data-agent-id": caret.id,
          style: `background-color:${tint(caret.color, 18)};`,
        })
      );
    }
    const from = Math.min(caret.anchor, caret.head);
    const to = Math.max(caret.anchor, caret.head);
    if (from < to) {
      decorations.push(
        Decoration.inline(from, to, {
          class: "pe-agent-selection",
          "data-agent-id": caret.id,
          style: `background-color:${tint(caret.color, 28)};`,
        })
      );
    }
    decorations.push(
      Decoration.widget(caret.head, caretWidget(caret), {
        key: `agent-caret:${caret.id}:${caret.name}:${caret.color}`,
        side: 10,
        ignoreSelection: true,
      })
    );
  }
  return DecorationSet.create(state.doc, decorations);
}

/** The ProseMirror plugin behind `AgentCaret` (one per editor). */
export function createAgentCaretPlugin(): Plugin<AgentCaretState> {
  return new Plugin<AgentCaretState>({
    key: agentCaretPluginKey,
    state: {
      init: (_, state) => ({ carets: [], spans: {}, decorations: DecorationSet.create(state.doc, []), treatments: null }),
      apply(tr, value, _old, state) {
        const meta = tr.getMeta(agentCaretPluginKey) as AgentCaretMeta | undefined;
        if (!tr.docChanged && !meta) return value;
        const size = state.doc.content.size;
        let carets = value.carets;
        let spans = value.spans;
        let treatments = value.treatments;
        const now = clockOf(treatments);
        const mapRange = (r: { from: number; to: number }) => ({ from: tr.mapping.map(r.from, 1), to: tr.mapping.map(r.to, -1) });
        if (tr.docChanged) {
          const anchorBias = (c: AgentCaret) => (c.anchor <= c.head ? 1 : -1);
          carets = carets.map((c) => ({
            ...c,
            anchor: tr.mapping.map(c.anchor, anchorBias(c)),
            head: tr.mapping.map(c.head, -anchorBias(c)),
            changed: c.changed.map(mapRange).filter((r) => r.from < r.to),
            ...(c.check && { check: mapRange(c.check) }),
          }));
          const own = !!meta && "span" in meta;
          spans = Object.fromEntries(
            Object.entries(spans).map(([id, s]) => {
              const from = tr.mapping.map(s.from, 1);
              return [id, { from, to: Math.max(from, tr.mapping.map(s.to, -1)), foreign: s.foreign || !own }];
            })
          );
        }
        if (meta && "set" in meta) {
          const input = meta.set;
          const prev = carets.find((c) => c.id === input.id);
          const anchor = clamp(input.from, size);
          const head = input.to === undefined ? anchor : clamp(input.to, size);
          const stage = input.stage ?? (anchor === head ? "caret" : "selecting");
          const check = stage === "checking" && input.check ? { from: clamp(input.check.from, size), to: clamp(input.check.to, size) } : undefined;
          const treatment = input.treatment ?? prev?.treatment;
          const treatmentValues = input.treatmentValues ?? prev?.treatmentValues;
          const caret: AgentCaret = {
            id: input.id,
            name: input.name ?? prev?.name ?? DEFAULT_AGENT_CARET_NAME,
            color: input.color ?? prev?.color ?? DEFAULT_AGENT_CARET_COLOR,
            anchor,
            head,
            changed: prev?.changed ?? [],
            stage,
            stageSince: prev && prev.stage === stage ? prev.stageSince : now(),
            ...(check && { check }),
            ...(prev?.changedSince !== undefined && { changedSince: prev.changedSince }),
            ...(treatment !== undefined && { treatment }),
            ...(treatmentValues !== undefined && { treatmentValues }),
          };
          carets = prev ? carets.map((c) => (c.id === input.id ? caret : c)) : [...carets, caret];
        } else if (meta && "clear" in meta) {
          carets = meta.clear === null ? [] : carets.filter((c) => c.id !== meta.clear);
        } else if (meta && "changed" in meta) {
          const { id, ranges } = meta.changed;
          carets = carets.map((c) =>
            c.id === id
              ? {
                  ...c,
                  changed: ranges.map((r) => ({ from: clamp(r.from, size), to: clamp(r.to, size) })).filter((r) => r.from < r.to),
                  changedSince: now(),
                }
              : c
          );
        } else if (meta && "span" in meta) {
          const span = meta.span;
          spans = { ...spans };
          if ("end" in span) delete spans[span.id];
          else spans[span.id] = { from: span.from, to: span.to, foreign: spans[span.id]?.foreign ?? false };
        } else if (meta && "treatments" in meta) {
          treatments = meta.treatments;
        }
        return { carets, spans, treatments, decorations: buildDecorations(state, carets, treatments) };
      },
    },
    props: {
      decorations: (state) => agentCaretPluginKey.getState(state)?.decorations,
    },
    view: (view) => new AgentTreatmentOverlay(view),
  });
}

/** TipTap extension drawing agent carets. Optional: the helpers below add the plugin when it's missing. */
export const AgentCaret = Extension.create({
  name: "agentCaret",
  addProseMirrorPlugins() {
    return [createAgentCaretPlugin()];
  },
});

/** Adds the agent caret plugin to a mounted editor that wasn't created with `AgentCaret`. */
export function ensureAgentCaret(editor: Editor): void {
  if (editor.isDestroyed || agentCaretPluginKey.getState(editor.state)) return;
  editor.registerPlugin(createAgentCaretPlugin());
}

function dispatchMeta(editor: Editor, meta: AgentCaretMeta) {
  if (editor.isDestroyed) return;
  ensureAgentCaret(editor);
  editor.view.dispatch(editor.state.tr.setMeta(agentCaretPluginKey, meta).setMeta("addToHistory", false));
}

/** Shows (or moves) an agent's caret; `from < to` also highlights its selection. */
export function setAgentCaret(editor: Editor, caret: AgentCaretInput): void {
  dispatchMeta(editor, { set: caret });
}

/** Removes one agent's caret, or every agent caret when `id` is omitted. */
export function clearAgentCaret(editor: Editor, id?: string): void {
  if (editor.isDestroyed || !agentCaretPluginKey.getState(editor.state)) return;
  dispatchMeta(editor, { clear: id ?? null });
}

/** Tints ranges an agent just changed (replacing its previous ones); `[]` clears them. */
export function markAgentChanges(editor: Editor, id: string, ranges: Array<{ from: number; to: number }>): void {
  if (!ranges.length && !agentCaretPluginKey.getState(editor.state)) return;
  dispatchMeta(editor, { changed: { id, ranges } });
}

/** The agent carets in an editor state (empty when the plugin isn't installed). */
export function getAgentCarets(state: EditorState): AgentCaret[] {
  return agentCaretPluginKey.getState(state)?.carets ?? [];
}

/**
 * Draws agents' edits with text treatments from `options.provider` (each agent's
 * `AgentCaretInput.treatment`, else `options.treatment`, else the provider's default), in an
 * overlay behind and above the text. `null`, or a provider without text treatments, goes back to
 * the decorations. The agent's colour is the treatment's `color` value, so several agents with
 * the same treatment are told apart.
 */
export function setAgentTextTreatments(editor: Editor, options: AgentTextTreatmentOptions | null): void {
  dispatchMeta(editor, { treatments: options });
}

// ---------------------------------------------------------------------------
// Drawing with text treatments
// ---------------------------------------------------------------------------

/** A plan for one stage of one caret, at a moment. */
interface TreatmentFrame {
  stage: TextTreatmentStage;
  time: number;
  target: TextTreatmentTarget;
}

/**
 * The plan to draw for `stage` at `time`, or null when there is nothing to draw: a finished
 * `checking` or `landed` stage is removed, and a finished `selecting` stage holds its last frame
 * until typing starts.
 */
export function textTreatmentFrame(planAt: (time: number) => TextTreatmentPlan, stage: TextTreatmentStage, time: number): TextTreatmentPlan | null {
  const plan = planAt(time);
  if (!plan.done) return plan;
  if (stage === "selecting") return plan.time === plan.duration ? plan : planAt(plan.duration);
  return null;
}

/** A CSS colour as `#rrggbb` for a treatment's `color` value (the default caret colour when it isn't one). */
function hexOf(color: string): string {
  const parsed = parseCssColor(color);
  return parsed ? parsed.hex : DEFAULT_AGENT_CARET_COLOR;
}

const css = (c: readonly number[], alpha = 1) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${+(c[3] * alpha).toFixed(4)})`;
const num = (v: number) => +v.toFixed(2);
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * One side (`behind` or `above`) of the plans as markup: an SVG of rectangles, text and ribbons,
 * and HTML pills for name tags (which need the browser to measure their text).
 */
export function textTreatmentMarkup(layers: readonly TextTreatmentLayer[], z: "behind" | "above"): string {
  let defs = "";
  let svg = "";
  let html = "";
  let gradients = 0;
  for (const l of layers) {
    if (l.z !== z) continue;
    const blend = l.blend !== "normal" ? `mix-blend-mode:${l.blend};` : "";
    const glow = l.glow ? `filter:drop-shadow(0 0 ${num(l.glow)}px ${css(l.color)});` : "";
    const style = blend || glow ? ` style="${blend}${glow}"` : "";
    if (l.kind === "rect") {
      let fill = css(l.color);
      if (l.gradient) {
        const id = `pe-tt-g${gradients++}`;
        const g = l.gradient;
        defs +=
          `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(g.x0)}" y1="${num(g.y0)}" x2="${num(g.x1)}" y2="${num(g.y1)}">` +
          g.stops.map((s) => `<stop offset="${num(s.offset)}" stop-color="${css(s.color)}"/>`).join("") +
          "</linearGradient>";
        fill = `url(#${id})`;
      }
      const paint = l.stroke ? `fill="none" stroke="${fill}" stroke-width="${num(l.stroke)}"` : `fill="${fill}"`;
      svg += `<rect x="${num(l.x)}" y="${num(l.y)}" width="${num(l.width)}" height="${num(l.height)}" rx="${num(l.radius)}" ${paint} opacity="${num(l.opacity)}"${style}/>`;
    } else if (l.kind === "text") {
      const font = l.font ? ` style="font:${esc(l.font)};${blend}${glow}"` : style;
      svg += `<text x="${num(l.x)}" y="${num(l.y + l.height / 2)}" dominant-baseline="central" fill="${css(l.color)}" opacity="${num(l.opacity)}"${font}>${esc(l.text ?? "")}</text>`;
    } else if (l.kind === "path") {
      svg += `<g opacity="${num(l.opacity)}"${style}>${(l.segments ?? [])
        .map((seg) => `<polygon points="${seg.points.map(([x, y]) => `${num(x)},${num(y)}`).join(" ")}" fill="${css(seg.color)}"/>`)
        .join("")}</g>`;
    } else if (l.kind === "tag") {
      const size = l.size ?? 11;
      html +=
        `<span class="pe-agent-treatment-tag" style="position:absolute;left:${num(l.x)}px;top:${num(l.y)}px;height:${num(l.height)}px;` +
        `padding:0 ${num(l.padX ?? 5)}px;border-radius:${num(l.radius)}px;background:${css(l.color)};color:${css(l.textColor ?? [1, 1, 1, 1])};` +
        `font:600 ${num(size)}px/${num(l.height)}px system-ui,sans-serif;white-space:nowrap;opacity:${num(l.opacity)};${blend}${glow}">${esc(l.text ?? "")}</span>`;
    }
  }
  if (!svg && !html) return "";
  const svgMarkup = svg ? `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" style="position:absolute;left:0;top:0;overflow:visible">${defs ? `<defs>${defs}</defs>` : ""}${svg}</svg>` : "";
  return svgMarkup + html;
}

/** Whether the system asks for less motion. */
const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Draws the agents' carets from text treatments in two layers, behind and above the editor's text. */
class AgentTreatmentOverlay {
  private behind: HTMLElement | null = null;
  private above: HTMLElement | null = null;
  private frame: number | null = null;
  private warned = new Set<string>();

  constructor(private view: EditorView) {
    this.update();
  }

  update() {
    const state = agentCaretPluginKey.getState(this.view.state);
    if (state && treated(state.treatments) && (state.carets.length || this.behind)) this.schedule();
    else if (this.behind) this.draw();
  }

  destroy() {
    this.cancel();
    this.behind?.remove();
    this.above?.remove();
    this.behind = this.above = null;
  }

  private schedule() {
    if (this.frame !== null) return;
    const run = () => {
      this.frame = null;
      if (this.draw()) this.schedule();
    };
    this.frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : (setTimeout(run, 16) as unknown as number);
  }

  private cancel() {
    if (this.frame === null) return;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.frame);
    clearTimeout(this.frame);
    this.frame = null;
  }

  /** The element the overlay sits in: the editor's parent, made a positioned stacking context. */
  private host(): HTMLElement | null {
    const parent = this.view.dom.parentElement;
    if (!parent) return null;
    if (!this.behind) {
      const doc = parent.ownerDocument;
      const win = doc.defaultView;
      if (win && win.getComputedStyle(parent).position === "static") parent.style.position = "relative";
      parent.style.isolation = "isolate";
      const layer = (z: number, name: string) => {
        const el = doc.createElement("div");
        el.className = `pe-agent-treatment pe-agent-treatment-${name}`;
        el.setAttribute("aria-hidden", "true");
        el.style.cssText = `position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:${z};`;
        return el;
      };
      this.behind = layer(-1, "behind");
      this.above = layer(1, "above");
      parent.prepend(this.behind);
      parent.append(this.above);
    }
    return parent;
  }

  /** Draws every caret's stages now. Returns whether to keep drawing. */
  draw(): boolean {
    const state = agentCaretPluginKey.getState(this.view.state);
    const options = state?.treatments;
    if (!state || !treated(options) || !state.carets.length || this.view.isDestroyed) {
      if (this.behind) this.behind.innerHTML = this.above!.innerHTML = "";
      return false;
    }
    const host = this.host();
    if (!host) return false;
    const now = clockOf(options)();
    const reduceMotion = options.reduceMotion ?? prefersReducedMotion();
    const origin = host.getBoundingClientRect();
    const dx = host.scrollLeft - origin.left - host.clientLeft;
    const dy = host.scrollTop - origin.top - host.clientTop;
    const layers: TextTreatmentLayer[] = [];
    for (const caret of state.carets) {
      const values = { ...caret.treatmentValues, color: caret.treatmentValues?.color ?? hexOf(caret.color) };
      const choice = { id: caret.treatment ?? options.treatment, values };
      const planner = (stage: TextTreatmentStage, target: TextTreatmentTarget) => (time: number) => {
        const request = { stage, time: Math.max(0, time), target, reduceMotion };
        try {
          return planTextTreatment(options.provider, request, choice);
        } catch (error) {
          const key = `${caret.id}:${choice.id ?? ""}`;
          if (!this.warned.has(key)) {
            this.warned.add(key);
            console.warn(`Agent "${caret.name}" is drawn with the built-in text treatment: ${(error as Error).message}`);
          }
          return builtInTextTreatmentPlan(request, { color: values.color });
        }
      };
      for (const f of this.frames(caret, state.spans[caret.id], now, dx, dy)) {
        const plan = textTreatmentFrame(planner(f.stage, f.target), f.stage, f.time);
        if (plan) layers.push(...plan.layers);
      }
    }
    this.behind!.innerHTML = textTreatmentMarkup(layers, "behind");
    this.above!.innerHTML = textTreatmentMarkup(layers, "above");
    return true;
  }

  /** The stages to draw for a caret, with their targets in the overlay's coordinates. */
  private frames(caret: AgentCaret, span: TypingSpan | undefined, now: number, dx: number, dy: number): TreatmentFrame[] {
    const label = caret.name;
    const lines = (from: number, to: number) => rangeLines(this.view, from, to).map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }));
    const caretAt = (pos: number) => {
      const c = caretCoords(this.view, pos);
      return c && { x: c.x + dx, y: c.y + dy, height: c.height };
    };
    const at = (target: TextTreatmentTarget) => Object.fromEntries(Object.entries(target).filter(([, v]) => v !== undefined)) as TextTreatmentTarget;
    const out: TreatmentFrame[] = [];
    if (caret.changed.length && caret.changedSince !== undefined) {
      out.push({ stage: "landed", time: now - caret.changedSince, target: at({ lines: caret.changed.flatMap((r) => lines(r.from, r.to)) }) });
    }
    const time = now - caret.stageSince;
    const head = caretAt(caret.head) ?? undefined;
    if (caret.stage === "selecting") {
      out.push({ stage: "selecting", time, target: at({ lines: lines(Math.min(caret.anchor, caret.head), Math.max(caret.anchor, caret.head)), caret: head, label }) });
    } else if (caret.stage === "typing") {
      out.push({ stage: "typing", time, target: at({ lines: span ? lines(span.from, span.to) : [], caret: head, label }) });
    } else {
      if (caret.stage === "checking" && caret.check) out.push({ stage: "checking", time, target: at({ lines: lines(caret.check.from, caret.check.to) }) });
      out.push({ stage: "caret", time, target: at({ caret: head, label }) });
    }
    return out;
  }
}

/** The client rectangles of `from..to`, one per line (text only), in reading order. */
function rangeLines(view: EditorView, from: number, to: number): TextTreatmentRect[] {
  if (from >= to) return [];
  const doc = view.dom.ownerDocument;
  let range: Range;
  try {
    const start = view.domAtPos(from);
    const end = view.domAtPos(to);
    range = doc.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return [];
  }
  const rects: DOMRect[] = [];
  const root = range.commonAncestorContainer;
  const walker = doc.createTreeWalker(root.nodeType === 3 ? root.parentNode! : root, 4 /* SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    const part = doc.createRange();
    part.selectNodeContents(node);
    if (node === range.startContainer) part.setStart(node, range.startOffset);
    if (node === range.endContainer) part.setEnd(node, range.endOffset);
    for (const r of Array.from(part.getClientRects?.() ?? [])) if (r.width > 0 && r.height > 0) rects.push(r);
  }
  // Rectangles on the same line (their middles within each other's height) make one.
  const out: TextTreatmentRect[] = [];
  for (const r of rects) {
    const mid = r.top + r.height / 2;
    const line = out.find((l) => mid > l.y && mid < l.y + l.height);
    if (!line) {
      out.push({ x: r.left, y: r.top, width: r.width, height: r.height });
      continue;
    }
    const right = Math.max(line.x + line.width, r.right);
    const bottom = Math.max(line.y + line.height, r.bottom);
    line.x = Math.min(line.x, r.left);
    line.y = Math.min(line.y, r.top);
    line.width = right - line.x;
    line.height = bottom - line.y;
  }
  return out;
}

/** Where a caret at `pos` is drawn, in client coordinates, or null. */
function caretCoords(view: EditorView, pos: number): { x: number; y: number; height: number } | null {
  try {
    const c = view.coordsAtPos(Math.max(0, Math.min(pos, view.state.doc.content.size)));
    return c.bottom > c.top ? { x: c.left, y: c.top, height: c.bottom - c.top } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Typing playback
// ---------------------------------------------------------------------------

/**
 * A transaction replacing `from..to` with literal text (HTML is not parsed; newlines split
 * paragraphs), as the rich-text agent tools write it.
 */
export function replaceWithTextTransaction(state: EditorState, from: number, to: number, text: string): Transaction {
  return /[\r\n]/.test(text)
    ? state.tr.replace(from, to, plainTextToSlice(text, state.schema))
    : text
      ? state.tr.insertText(text, from, to)
      : state.tr.delete(from, to);
}

export interface TypeAgentTextOptions extends AgentTypingOptions {
  from: number;
  to: number;
  text: string;
  /** A range the agent looks over first (its text treatment's `checking` sweep), for `checkMs`. */
  check?: { from: number; to: number };
  /** The agent's caret, drawn where it types. */
  caret: Omit<AgentCaretInput, "from" | "to">;
  /** Stops typing and leaves the document as it was. */
  signal?: AbortSignal;
  /** Waits between frames (default `setTimeout`; injectable for tests). */
  wait?: (ms: number) => Promise<void>;
}

const NO_HISTORY = (tr: Transaction) => tr.setMeta("addToHistory", false).setMeta(TRACK_CHANGES_SKIP_META, true);

/** True when animation is pointless: no window, or a hidden tab (timers there are throttled). */
const cannotAnimate = () => typeof document === "undefined" || document.hidden === true;

/**
 * Replaces `from..to` with `text` while the agent's caret types it out, then commits the edit as
 * ONE undo step (the frames are kept out of history, rolled back and replaced by a single
 * transaction in the same tick, so the screen never shows the rollback). Without a visible window,
 * or with `charsPerSecond: Infinity`, the edit applies at once. Returns the inserted range.
 *
 * If the signal aborts or the editor is destroyed mid-way, the typed frames are rolled back and
 * the promise rejects; nothing partial stays in the document.
 */
export async function typeAgentText(editor: Editor, options: TypeAgentTextOptions): Promise<{ from: number; to: number }> {
  const { from, to, text, caret, signal } = options;
  ensureAgentCaret(editor);
  const show = (tr: Transaction, anchor: number, head = anchor, stage?: AgentCaretStage, check?: { from: number; to: number }) =>
    tr.setMeta(agentCaretPluginKey, { set: { ...caret, from: anchor, to: head, ...(stage && { stage }), ...(check && { check }) } } satisfies AgentCaretMeta);

  const commit = (start: number, end: number) => {
    // The agent's edit is its own undo step, however soon after another one it lands.
    const tr = closeHistory(replaceWithTextTransaction(editor.state, start, end, text));
    const insertedTo = tr.mapping.map(end, 1);
    const insertedFrom = Math.min(tr.mapping.map(start, -1), insertedTo);
    editor.view.dispatch(show(tr, insertedTo).scrollIntoView());
    if (insertedFrom < insertedTo) markAgentChanges(editor, caret.id, [{ from: insertedFrom, to: insertedTo }]);
    return { from: insertedFrom, to: insertedTo };
  };

  // The timing comes from the shared planner, so the Swift port plays an edit the same way (#878).
  const plan = planAgentTyping({ from, to, text, ...(options.check && { check: options.check }) }, { ...options, animate: Boolean(options.wait) || !cannotAnimate() });
  if (plan.length === 1) return commit(from, to);

  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const original: Slice = editor.state.doc.slice(from, to);
  // Inverses of the frames' steps, newest last, to roll them back exactly.
  const inverses: Step[] = [];
  const span = (): TypingSpan => agentCaretPluginKey.getState(editor.state)!.spans[caret.id];

  // The span and the caret share a meta key, so each frame sets them in two transactions.
  editor.view.dispatch(NO_HISTORY(editor.state.tr.setMeta(agentCaretPluginKey, { span: { id: caret.id, from, to } } satisfies AgentCaretMeta)));
  if (plan[0].type !== "check") editor.view.dispatch(NO_HISTORY(show(editor.state.tr, from, to)));

  const rollback = () => {
    const s = span();
    const tr = editor.state.tr;
    if (!s.foreign) inverses.slice().reverse().forEach((step) => tr.step(step));
    else tr.replace(s.from, s.to, original);
    tr.setMeta(agentCaretPluginKey, { span: { id: caret.id, end: true } } satisfies AgentCaretMeta);
    editor.view.dispatch(NO_HISTORY(tr));
    return { from: s.from, to: s.from + original.size };
  };

  try {
    for (const step of plan) {
      if (step.type === "check") {
        // The caret waits at the edit while the treatment sweeps the range it checks.
        const s = span();
        editor.view.dispatch(NO_HISTORY(show(editor.state.tr, s.from, s.from, "checking", { from: step.from, to: step.to })));
        await wait(step.ms);
        continue;
      }
      if (step.type === "select") {
        const s = span();
        editor.view.dispatch(NO_HISTORY(show(editor.state.tr, s.from, s.to, "selecting")));
        await wait(step.ms);
        continue;
      }
      if (step.type !== "type") continue;
      if (signal?.aborted) throw new Error("Typing was cancelled; the document is unchanged.");
      if (editor.isDestroyed) throw new Error("The editor was closed while the agent was typing.");
      const s = span();
      const tr = replaceWithTextTransaction(editor.state, s.from, s.to, step.text);
      tr.steps.forEach((step, k) => inverses.push(step.invert(tr.docs[k])));
      const end = tr.mapping.map(s.to, 1);
      tr.setMeta(agentCaretPluginKey, { span: { id: caret.id, from: Math.min(tr.mapping.map(s.from, -1), end), to: end } } satisfies AgentCaretMeta);
      editor.view.dispatch(NO_HISTORY(tr));
      editor.view.dispatch(NO_HISTORY(show(editor.state.tr, end, end, "typing")));
      if (step.ms > 0) await wait(step.ms);
    }
  } catch (error) {
    if (!editor.isDestroyed) rollback();
    throw error;
  }
  // Roll the frames back and apply the whole edit once, in the same tick: one undo step.
  const restored = rollback();
  return commit(restored.from, restored.to);
}
