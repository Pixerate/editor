import type { McpToolResult, RichTextAgentPresence, ToolRegistry } from "@pixerate/editor/agent";

// Scripted agents for the demo, after Ursula's "▶ Demo agent" (dev/whiteboard.tsx): a list of
// steps, each a note to the user and / or one MCP tool call, played at reading speed with Skip and
// Stop. The calls go through the same `ToolRegistry` an MCP client uses, so a script shows exactly
// what a real agent would do, and later steps read ids and positions from earlier results.

/** The demo's agent speed (`?agentSpeed=2`, or `Infinity` for no animation). */
export const demoAgentSpeed = () => Number(new URLSearchParams(window.location.search).get("agentSpeed") ?? 1) || 1;

/**
 * The agent's caret in the text editors' tools: drawn inline where it reads and writes, typing
 * replacements out at the demo's agent speed (each edit is still one undo step).
 */
export function demoTextPresence(): RichTextAgentPresence {
  const speed = demoAgentSpeed();
  return {
    name: "Agent",
    color: "#8b5cf6",
    typing: Number.isFinite(speed) ? { charsPerSecond: 40 * speed, maxDurationMs: 1600 / speed, selectMs: 350 / speed } : false,
  };
}

/** What earlier steps returned, for the arguments of later ones. */
export interface AgentScriptContext {
  /** Results kept with `as`, by name (a tool's `structuredContent`, or its JSON text). */
  results: Record<string, any>;
  /** The result of the step before. */
  last: any;
}

export interface AgentScriptStep {
  /** What the agent tells the user before it acts (the transcript and the cursor's bubble). */
  say?: string;
  /** Tool to call (a namespaced registry name such as `sheet__set_range`). */
  tool?: string;
  /** The tool's arguments, or a function of earlier results that returns them. */
  args?: Record<string, unknown> | ((ctx: AgentScriptContext) => Record<string, unknown>);
  /** Keep the result under this name in `ctx.results`. */
  as?: string;
  /** A control the cursor clicks first, so the change shows (a tab or panel), as text on it. */
  open?: string;
  /** Where the agent's cursor goes before the call (see `AgentScriptPanel`). */
  target?: AgentTarget;
}

/**
 * A cursor target inside the editor: text to find on screen (the smallest element showing it), a
 * CSS selector, or a function that returns an element or a rectangle in viewport coordinates.
 */
export type AgentTarget =
  | { text: string }
  | { selector: string }
  | ((stage: HTMLElement, ctx: AgentScriptContext) => Element | DOMRect | null | undefined);

export interface AgentScript {
  id: string;
  /** The user's request, as they would type it. */
  prompt: string;
  steps: AgentScriptStep[];
}

export type AgentRunEvent =
  | { type: "say"; step: number; text: string }
  | { type: "call"; step: number; tool: string; args: Record<string, unknown> }
  | { type: "result"; step: number; tool: string; result: McpToolResult }
  | { type: "error"; step: number; message: string }
  | { type: "done"; ok: boolean; stopped: boolean };

/** Speed and stop for a run in progress (`speed: Infinity` finishes without pauses). */
export interface AgentRunControl {
  speed: number;
  stopped: boolean;
}

export interface RunAgentScriptOptions {
  onEvent?: (event: AgentRunEvent) => void;
  /** Called before each tool call, e.g. to glide a cursor to the step's target. */
  beforeCall?: (step: AgentScriptStep, ctx: AgentScriptContext, control: AgentRunControl) => void | Promise<void>;
  control?: AgentRunControl;
  /** Waits `ms` (already scaled by the speed); real timers by default. */
  wait?: (ms: number) => Promise<void>;
}

/** Time to read a note: about 15 characters a second, between 0.6 s and 2.2 s. */
export function readingTime(text: string): number {
  return Math.min(2200, Math.max(600, text.length * 65));
}

/** A tool result as a plain value: its `structuredContent`, else its first text block (parsed when JSON). */
export function resultValue(result: McpToolResult): any {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content.find((b) => b.type === "text") as { text?: string } | undefined;
  if (!text?.text) return undefined;
  try {
    return JSON.parse(text.text);
  } catch {
    return text.text;
  }
}

/** The error message of a failed tool result. */
export function resultError(result: McpToolResult): string {
  const text = result.content.find((b) => b.type === "text") as { text?: string } | undefined;
  return text?.text ?? "The tool failed.";
}

const realWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Plays `script` against `registry`: each step's note, then its tool call. Stops at the first
 * failure (a tool error or arguments that cannot be built), like an agent that has to rethink,
 * and resolves with the results kept so far.
 */
export async function runAgentScript(
  registry: ToolRegistry,
  script: AgentScript,
  options: RunAgentScriptOptions = {},
): Promise<{ ok: boolean; ctx: AgentScriptContext }> {
  const control = options.control ?? { speed: 1, stopped: false };
  const wait = options.wait ?? realWait;
  const pause = (ms: number) => (Number.isFinite(control.speed) ? wait(ms / Math.max(0.1, control.speed)) : Promise.resolve());
  const emit = options.onEvent ?? (() => {});
  const ctx: AgentScriptContext = { results: {}, last: undefined };
  const finish = (ok: boolean) => {
    emit({ type: "done", ok, stopped: control.stopped });
    return { ok, ctx };
  };

  for (let i = 0; i < script.steps.length; i++) {
    if (control.stopped) return finish(false);
    const step = script.steps[i];
    if (step.say) {
      emit({ type: "say", step: i, text: step.say });
      await pause(readingTime(step.say));
    }
    if (!step.tool) continue;
    if (control.stopped) return finish(false);
    let args: Record<string, unknown>;
    try {
      args = typeof step.args === "function" ? step.args(ctx) : (step.args ?? {});
    } catch (error) {
      emit({ type: "error", step: i, message: error instanceof Error ? error.message : String(error) });
      return finish(false);
    }
    await options.beforeCall?.(step, ctx, control);
    if (control.stopped) return finish(false);
    emit({ type: "call", step: i, tool: step.tool, args });
    const result = await registry.callTool(step.tool, args);
    emit({ type: "result", step: i, tool: step.tool, result });
    if (result.isError) {
      emit({ type: "error", step: i, message: resultError(result) });
      return finish(false);
    }
    ctx.last = resultValue(result);
    if (step.as) ctx.results[step.as] = ctx.last;
    await pause(350);
  }
  return finish(true);
}
