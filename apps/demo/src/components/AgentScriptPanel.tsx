import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { McpToolResult } from "@pixerate/editor/agent";
import { Bot, FastForward, Play, Square, User } from "lucide-react";
import { demoToolRegistry } from "../agentTools";
import {
  resultValue,
  runAgentScript,
  type AgentRunControl,
  type AgentScript,
  type AgentScriptContext,
  type AgentTarget,
} from "../agentScript";

type Entry =
  | { kind: "user"; text: string }
  | { kind: "say"; text: string }
  | { kind: "call"; tool: string; args: Record<string, unknown> }
  | { kind: "result"; result: McpToolResult }
  | { kind: "error"; text: string }
  | { kind: "done"; text: string };

interface CursorState {
  x: number;
  y: number;
  visible: boolean;
  pressed: boolean;
  bubble?: string;
  /** The target being worked on, relative to the stage. */
  focus?: { x: number; y: number; width: number; height: number };
}

/** The visible element or text range showing `text` inside `stage` (the first match). */
function findTextRect(stage: HTMLElement, text: string): DOMRect | null {
  const walker = document.createTreeWalker(stage, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.textContent?.indexOf(text) ?? -1;
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + text.length);
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return rect;
  }
  // Form fields keep their text in `value`.
  for (const input of stage.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")) {
    if (input.value.includes(text)) return input.getBoundingClientRect();
  }
  return null;
}

/** The clickable element (button, tab, link or label) showing `text` inside `stage`. */
function findControl(stage: HTMLElement, text: string): HTMLElement | null {
  for (const el of stage.querySelectorAll<HTMLElement>("button, [role=tab], a, label")) {
    if (el.textContent?.trim() === text && el.getClientRects().length) return el;
  }
  return null;
}

function resolveTarget(target: AgentTarget, stage: HTMLElement, ctx: AgentScriptContext): DOMRect | null {
  if (typeof target === "function") {
    const found = target(stage, ctx);
    if (!found) return null;
    return found instanceof DOMRect ? found : found.getBoundingClientRect();
  }
  if ("text" in target) return findTextRect(stage, target.text);
  return stage.querySelector(target.selector)?.getBoundingClientRect() ?? null;
}

function summarize(value: unknown, max = 220): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "done";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const realWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** An agent's cursor with a name tag and speech bubble, drawn over the stage (after Ursula's PresenceLayer). */
const AgentCursor: React.FC<{ cursor: CursorState; name: string }> = ({ cursor, name }) => (
  <div className="pointer-events-none absolute inset-0 z-30 overflow-visible" aria-hidden="true" data-testid="agent-cursor">
    {cursor.focus && (
      <div
        className="absolute rounded-md ring-2 ring-violet-400/80 bg-violet-400/10 transition-all duration-200"
        style={{ left: cursor.focus.x - 3, top: cursor.focus.y - 3, width: cursor.focus.width + 6, height: cursor.focus.height + 6 }}
      />
    )}
    <div
      className="absolute transition-opacity duration-500"
      style={{ left: cursor.x, top: cursor.y, opacity: cursor.visible ? 1 : 0 }}
    >
      <svg
        width="18"
        height="20"
        viewBox="0 0 18 20"
        className="drop-shadow-md transition-transform duration-75"
        style={{ transform: cursor.pressed ? "scale(0.85)" : undefined, transformOrigin: "2px 2px" }}
      >
        <path d="M2 2 L2 17 L6.5 12.8 L9.6 19 L12.2 17.8 L9.2 11.7 L15.5 11.4 Z" fill="#7c3aed" stroke="white" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
      <div className="absolute left-4 top-4 flex flex-col items-start gap-1">
        <span className="rounded-full bg-violet-600 px-2 py-0.5 text-[10px] font-semibold text-white shadow whitespace-nowrap">{name}</span>
        {cursor.bubble && (
          <span className="w-max max-w-[240px] rounded-lg rounded-tl-none bg-white px-2.5 py-1.5 text-xs text-slate-800 shadow-lg ring-1 ring-slate-900/15">{cursor.bubble}</span>
        )}
      </div>
    </div>
  </div>
);

export interface AgentScriptPanelProps {
  /** The requests the user can pick; each plays as a scripted agent turn. */
  scripts: AgentScript[];
  /**
   * The editor the agent works in. Its element should be `position: relative`; the cursor is drawn
   * inside it. Leave it out for editors that draw their own agent cursor (charts, diagrams).
   */
  stage?: React.RefObject<HTMLElement | null>;
  /** The agent's name on its cursor. */
  actor?: string;
  /** One line about what the agent does here. */
  hint?: React.ReactNode;
}

/**
 * Plays scripted agent turns in an editor: the user's request, the agent's notes, and each MCP
 * tool call with its result, while a cursor glides to what the agent works on. Calls go through the
 * demo's `ToolRegistry`, exactly as an agent connected over MCP would make them.
 */
export const AgentScriptPanel: React.FC<AgentScriptPanelProps> = ({ scripts, stage, actor = "Agent", hint }) => {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [cursor, setCursor] = useState<CursorState>({ x: 0, y: 0, visible: false, pressed: false });
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const control = useRef<AgentRunControl | null>(null);
  const log = useRef<HTMLOListElement>(null);
  const placed = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const patchCursor = (patch: Partial<CursorState>) => setCursor((c) => ({ ...c, ...patch }));

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  // Stop a run when the tab unmounts.
  useEffect(() => () => {
    if (control.current) control.current.stopped = true;
    clearTimeout(idleTimer.current);
  }, []);

  /** Glides the cursor to `rect` (viewport coordinates) along a slight arc, then clicks. */
  const glideTo = async (rect: DOMRect, run: AgentRunControl) => {
    const host = stage?.current;
    if (!host) return;
    const box = host.getBoundingClientRect();
    const focus = { x: rect.left - box.left, y: rect.top - box.top, width: rect.width, height: rect.height };
    const to = { x: focus.x + Math.min(rect.width / 2, 40), y: focus.y + rect.height / 2 };
    const from = placed.current ? { x: cursorRef.current.x, y: cursorRef.current.y } : { x: box.width - 60, y: 24 };
    placed.current = true;
    patchCursor({ x: from.x, y: from.y, visible: true, focus: undefined });
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const ms = Number.isFinite(run.speed) ? Math.min(900, 260 + dist * 0.5) / run.speed : 0;
    // A hidden tab gets no animation frames: jump instead of waiting for them.
    if (ms > 0 && dist > 1 && !document.hidden) {
      const bend = Math.min(60, dist * 0.12);
      const ctrl = { x: (from.x + to.x) / 2 - ((to.y - from.y) / dist) * bend, y: (from.y + to.y) / 2 + ((to.x - from.x) / dist) * bend };
      await new Promise<void>((resolve) => {
        const start = performance.now();
        const frame = (now: number) => {
          const t = Math.min(1, (now - start) / ms);
          const e = 1 - Math.pow(1 - t, 3);
          const u = 1 - e;
          patchCursor({ x: u * u * from.x + 2 * u * e * ctrl.x + e * e * to.x, y: u * u * from.y + 2 * u * e * ctrl.y + e * e * to.y });
          if (t < 1 && !run.stopped) requestAnimationFrame(frame);
          else resolve();
        };
        requestAnimationFrame(frame);
        setTimeout(resolve, ms + 200);
      });
    }
    patchCursor({ x: to.x, y: to.y, focus, pressed: true });
    if (Number.isFinite(run.speed)) await realWait(110 / run.speed);
    patchCursor({ pressed: false });
  };

  const play = async (script: AgentScript) => {
    if (running) return;
    clearTimeout(idleTimer.current);
    const run: AgentRunControl = { speed: Number(new URLSearchParams(window.location.search).get("agentSpeed") ?? 1) || 1, stopped: false };
    control.current = run;
    setRunning(script.id);
    setEntries([{ kind: "user", text: script.prompt }]);
    const push = (entry: Entry) => setEntries((list) => [...list, entry]);
    const { ok } = await runAgentScript(demoToolRegistry, script, {
      control: run,
      onEvent: (event) => {
        switch (event.type) {
          case "say":
            push({ kind: "say", text: event.text });
            if (stage?.current) patchCursor({ bubble: event.text, visible: placed.current });
            break;
          case "call":
            push({ kind: "call", tool: event.tool, args: event.args });
            break;
          case "result":
            if (!event.result.isError) push({ kind: "result", result: event.result });
            break;
          case "error":
            push({ kind: "error", text: event.message });
            break;
          case "done":
            if (event.stopped) push({ kind: "done", text: "Stopped. Everything applied so far stays, and undo takes it back one tool call at a time." });
            break;
        }
      },
      beforeCall: async (step, ctx, c) => {
        const host = stage?.current;
        if (!host) return;
        const opener = step.open ? findControl(host, step.open) : null;
        if (opener) {
          await glideTo(opener.getBoundingClientRect(), c);
          opener.click();
          // Let the opened panel render before looking for the target in it.
          await realWait(Number.isFinite(c.speed) ? 250 / c.speed : 50);
        }
        const rect = step.target ? resolveTarget(step.target, host, ctx) : null;
        if (rect) await glideTo(rect, c);
      },
    });
    if (ok) push({ kind: "done", text: "Done. Each tool call above is one undo step in the editor." });
    control.current = null;
    setRunning(null);
    patchCursor({ bubble: undefined, focus: undefined });
    idleTimer.current = setTimeout(() => {
      patchCursor({ visible: false });
      placed.current = false;
    }, 2500);
  };

  const button = "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border transition-colors disabled:opacity-40";
  const host = stage?.current;
  return (
    <section className="rounded-xl border border-violet-500/30 bg-violet-950/10 p-3 space-y-2" data-testid="agent-script-panel">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-violet-300">
          <Bot className="w-4 h-4" /> Ask the agent
        </span>
        {scripts.map((script) => (
          <button
            key={script.id}
            type="button"
            disabled={running !== null}
            onClick={() => void play(script)}
            className={`${button} ${running === script.id ? "border-violet-400 bg-violet-500/20 text-violet-100" : "border-slate-700 bg-slate-900/70 text-slate-200 hover:border-violet-500/60"}`}
            data-agent-script={script.id}
          >
            <Play className="w-3 h-3 text-violet-300" /> {script.prompt}
          </button>
        ))}
        {running && (
          <span className="flex items-center gap-1.5 ml-auto">
            <button type="button" className={`${button} border-slate-700 text-slate-300 hover:bg-slate-800`} onClick={() => control.current && (control.current.speed = Infinity)}>
              <FastForward className="w-3 h-3" /> Skip
            </button>
            <button type="button" className={`${button} border-slate-700 text-slate-300 hover:bg-slate-800`} onClick={() => control.current && (control.current.stopped = true)}>
              <Square className="w-3 h-3" /> Stop
            </button>
          </span>
        )}
      </div>
      {hint && entries.length === 0 && <p className="text-[11px] text-slate-500">{hint}</p>}
      {entries.length > 0 && (
        <ol ref={log} className="max-h-44 overflow-y-auto space-y-1.5 text-xs pr-1" aria-label="Agent transcript" aria-live="polite">
          {entries.map((entry, i) => (
            <li key={i}>
              {entry.kind === "user" && (
                <div className="flex items-start gap-1.5 text-slate-200">
                  <User className="w-3.5 h-3.5 mt-0.5 text-slate-400 shrink-0" />
                  <span className="rounded-lg bg-slate-800 px-2 py-1">{entry.text}</span>
                </div>
              )}
              {entry.kind === "say" && (
                <div className="flex items-start gap-1.5 text-violet-100">
                  <Bot className="w-3.5 h-3.5 mt-0.5 text-violet-300 shrink-0" />
                  <span>{entry.text}</span>
                </div>
              )}
              {entry.kind === "call" && (
                <details className="ml-5 font-mono text-[11px] text-cyan-300">
                  <summary className="cursor-pointer truncate">
                    → {entry.tool} <span className="text-slate-500">{summarize(entry.args, 120)}</span>
                  </summary>
                  <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-slate-950 p-2 text-slate-300">{JSON.stringify(entry.args, null, 2)}</pre>
                </details>
              )}
              {entry.kind === "result" && (
                <div className="ml-5 font-mono text-[11px] text-emerald-300/90 break-words">
                  {entry.result.content.some((b) => b.type === "image") ? (
                    entry.result.content.map((b, j) =>
                      b.type === "image" ? (
                        <img key={j} src={`data:${b.mimeType};base64,${b.data}`} alt="Tool result" className="mt-1 max-h-40 rounded border border-slate-800 bg-white" />
                      ) : null,
                    )
                  ) : (
                    <>✓ {summarize(resultValue(entry.result))}</>
                  )}
                </div>
              )}
              {entry.kind === "error" && <div className="ml-5 text-red-300">✗ {entry.text}</div>}
              {entry.kind === "done" && <div className="ml-5 text-slate-500 italic">{entry.text}</div>}
            </li>
          ))}
        </ol>
      )}
      {host && createPortal(<AgentCursor cursor={cursor} name={actor} />, host)}
    </section>
  );
};
