import type { RichTextAgentPresence } from "@pixerate/editor/agent";
import type { ToolScript, ToolScriptContext, ToolScriptStep } from "@pixerate/editor/tools";

// Scripted agents for the demo: each step is a note to the user and / or one MCP tool call,
// played by the library's `runToolScript` at reading speed with Skip and Stop. The calls go
// through the same `ToolRegistry` an MCP client uses, and agent playback acts each one out on the
// editor it targets, so the scripts carry no cursor targets at all.

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

export type AgentScript = ToolScript;
export type AgentScriptStep = ToolScriptStep;
export type AgentScriptContext = ToolScriptContext;

export {
  runToolScript as runAgentScript,
  toolResultValue as resultValue,
  toolResultError as resultError,
  type ToolScriptEvent as AgentRunEvent,
  type ToolScriptControl as AgentRunControl,
} from "@pixerate/editor/tools";
export { readingTime } from "@pixerate/editor/tools";
