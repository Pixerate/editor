import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Slice } from "@tiptap/pm/model";
import type { Step } from "@tiptap/pm/transform";
import { plainTextToSlice } from "../serializers/plain-text";
import { TRACK_CHANGES_SKIP_META } from "./track-changes";

/**
 * Inline agent carets: a coloured caret with a name tag at a document position, the agent's
 * selection highlighted, and the text it just changed tinted for a moment — as collaborators'
 * cursors look in Google Docs. Decorations, so they follow the text as anyone edits it.
 *
 * `typeAgentText` plays an edit out a few characters at a time and still lands it as one undo step.
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
}

export interface AgentCaret {
  id: string;
  name: string;
  color: string;
  anchor: number;
  head: number;
  /** Ranges the agent just changed, tinted until `clearAgentChanges`. */
  changed: Array<{ from: number; to: number }>;
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
}

type AgentCaretMeta =
  | { set: AgentCaretInput }
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

function buildDecorations(state: EditorState, carets: AgentCaret[]): DecorationSet {
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
      init: (_, state) => ({ carets: [], spans: {}, decorations: DecorationSet.create(state.doc, []) }),
      apply(tr, value, _old, state) {
        const meta = tr.getMeta(agentCaretPluginKey) as AgentCaretMeta | undefined;
        if (!tr.docChanged && !meta) return value;
        const size = state.doc.content.size;
        let carets = value.carets;
        let spans = value.spans;
        if (tr.docChanged) {
          const anchorBias = (c: AgentCaret) => (c.anchor <= c.head ? 1 : -1);
          carets = carets.map((c) => ({
            ...c,
            anchor: tr.mapping.map(c.anchor, anchorBias(c)),
            head: tr.mapping.map(c.head, -anchorBias(c)),
            changed: c.changed
              .map((r) => ({ from: tr.mapping.map(r.from, 1), to: tr.mapping.map(r.to, -1) }))
              .filter((r) => r.from < r.to),
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
          const caret: AgentCaret = {
            id: input.id,
            name: input.name ?? prev?.name ?? DEFAULT_AGENT_CARET_NAME,
            color: input.color ?? prev?.color ?? DEFAULT_AGENT_CARET_COLOR,
            anchor,
            head: input.to === undefined ? anchor : clamp(input.to, size),
            changed: prev?.changed ?? [],
          };
          carets = prev ? carets.map((c) => (c.id === input.id ? caret : c)) : [...carets, caret];
        } else if (meta && "clear" in meta) {
          carets = meta.clear === null ? [] : carets.filter((c) => c.id !== meta.clear);
        } else if (meta && "changed" in meta) {
          const { id, ranges } = meta.changed;
          carets = carets.map((c) =>
            c.id === id
              ? { ...c, changed: ranges.map((r) => ({ from: clamp(r.from, size), to: clamp(r.to, size) })).filter((r) => r.from < r.to) }
              : c
          );
        } else if (meta && "span" in meta) {
          const span = meta.span;
          spans = { ...spans };
          if ("end" in span) delete spans[span.id];
          else spans[span.id] = { from: span.from, to: span.to, foreign: spans[span.id]?.foreign ?? false };
        }
        return { carets, spans, decorations: buildDecorations(state, carets) };
      },
    },
    props: {
      decorations: (state) => agentCaretPluginKey.getState(state)?.decorations,
    },
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

export interface AgentTypingOptions {
  /** Typing speed in characters per second (default 60). */
  charsPerSecond?: number;
  /** Longest a single edit takes to type, in ms; longer text types faster (default 1500). */
  maxDurationMs?: number;
  /** How long a replaced range stays highlighted before typing starts, in ms (default 250). */
  selectMs?: number;
}

export interface TypeAgentTextOptions extends AgentTypingOptions {
  from: number;
  to: number;
  text: string;
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
  const cps = options.charsPerSecond ?? 60;
  const chars = Array.from(text);
  ensureAgentCaret(editor);
  const show = (tr: Transaction, anchor: number, head = anchor) =>
    tr.setMeta(agentCaretPluginKey, { set: { ...caret, from: anchor, to: head } } satisfies AgentCaretMeta);

  const commit = (start: number, end: number) => {
    const tr = replaceWithTextTransaction(editor.state, start, end, text);
    const insertedTo = tr.mapping.map(end, 1);
    const insertedFrom = Math.min(tr.mapping.map(start, -1), insertedTo);
    editor.view.dispatch(show(tr, insertedTo).scrollIntoView());
    if (insertedFrom < insertedTo) markAgentChanges(editor, caret.id, [{ from: insertedFrom, to: insertedTo }]);
    return { from: insertedFrom, to: insertedTo };
  };

  const animate = Number.isFinite(cps) && cps > 0 && chars.length > 0 && (options.wait || !cannotAnimate());
  if (!animate) return commit(from, to);

  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const duration = Math.min(options.maxDurationMs ?? 1500, (chars.length / cps) * 1000);
  const frameMs = 1000 / 30;
  const frames = Math.max(1, Math.min(chars.length, Math.round(duration / frameMs)));
  const original: Slice = editor.state.doc.slice(from, to);
  // Inverses of the frames' steps, newest last, to roll them back exactly.
  const inverses: Step[] = [];
  const span = (): TypingSpan => agentCaretPluginKey.getState(editor.state)!.spans[caret.id];

  // The span and the caret share a meta key, so each frame sets them in two transactions.
  editor.view.dispatch(NO_HISTORY(editor.state.tr.setMeta(agentCaretPluginKey, { span: { id: caret.id, from, to } } satisfies AgentCaretMeta)));
  editor.view.dispatch(NO_HISTORY(show(editor.state.tr, from, to)));

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
    if (from < to) await wait(options.selectMs ?? 250);
    for (let i = 1; i <= frames; i++) {
      if (signal?.aborted) throw new Error("Typing was cancelled; the document is unchanged.");
      if (editor.isDestroyed) throw new Error("The editor was closed while the agent was typing.");
      const s = span();
      const prefix = chars.slice(0, Math.round((chars.length * i) / frames)).join("");
      const tr = replaceWithTextTransaction(editor.state, s.from, s.to, prefix);
      tr.steps.forEach((step, k) => inverses.push(step.invert(tr.docs[k])));
      const end = tr.mapping.map(s.to, 1);
      tr.setMeta(agentCaretPluginKey, { span: { id: caret.id, from: Math.min(tr.mapping.map(s.from, -1), end), to: end } } satisfies AgentCaretMeta);
      editor.view.dispatch(NO_HISTORY(tr));
      editor.view.dispatch(NO_HISTORY(show(editor.state.tr, end)));
      if (i < frames) await wait(duration / frames);
    }
  } catch (error) {
    if (!editor.isDestroyed) rollback();
    throw error;
  }
  // Roll the frames back and apply the whole edit once, in the same tick: one undo step.
  const restored = rollback();
  return commit(restored.from, restored.to);
}
