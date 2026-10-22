import React, { useEffect, useRef, useState } from "react";
import type { McpToolResult } from "@pixerate/editor/agent";
import { Bot, FastForward, Play, Square, User } from "lucide-react";
import { demoPlayback, demoToolRegistry } from "../agentTools";
import { demoAgentSpeed, resultValue, runAgentScript, type AgentRunControl, type AgentScript } from "../agentScript";

type Entry =
  | { kind: "user"; text: string }
  | { kind: "say"; text: string }
  | { kind: "call"; tool: string; args: Record<string, unknown> }
  | { kind: "result"; result: McpToolResult }
  | { kind: "error"; text: string }
  | { kind: "done"; text: string };

function summarize(value: unknown, max = 220): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "done";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface AgentScriptPanelProps {
  /** The requests the user can pick; each plays as a scripted agent turn. */
  scripts: AgentScript[];
  /** One line about what the agent does here. */
  hint?: React.ReactNode;
}

/**
 * Plays scripted agent turns in an editor: the user's request, the agent's notes, and each MCP
 * tool call with its result. Calls go through the demo's `ToolRegistry`, exactly as an agent
 * connected over MCP would make them, and the library's agent playback acts each one out with the
 * agent's cursor on the editor it targets (notes show in the cursor's bubble).
 */
export const AgentScriptPanel: React.FC<AgentScriptPanelProps> = ({ scripts, hint }) => {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const control = useRef<AgentRunControl | null>(null);
  const log = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  // Stop a run when the tab unmounts.
  useEffect(() => () => {
    if (control.current) control.current.stopped = true;
  }, []);

  const play = async (script: AgentScript) => {
    if (running) return;
    const run: AgentRunControl = { speed: demoAgentSpeed(), stopped: false };
    control.current = run;
    demoPlayback.speed = run.speed;
    setRunning(script.id);
    setEntries([{ kind: "user", text: script.prompt }]);
    const push = (entry: Entry) => setEntries((list) => [...list, entry]);
    const { ok } = await runAgentScript(demoToolRegistry, script, {
      control: run,
      playback: demoPlayback,
      onEvent: (event) => {
        switch (event.type) {
          case "say":
            push({ kind: "say", text: event.text });
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
    });
    if (ok) push({ kind: "done", text: "Done. Each tool call above is one undo step in the editor." });
    control.current = null;
    demoPlayback.speed = demoAgentSpeed();
    setRunning(null);
  };

  const button = "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border transition-colors disabled:opacity-40";
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
            <button type="button" className={`${button} border-slate-700 text-slate-300 hover:bg-slate-800`} onClick={() => {
                if (control.current) control.current.speed = Infinity;
                demoPlayback.speed = Infinity;
                demoPlayback.stop();
              }}>
              <FastForward className="w-3 h-3" /> Skip
            </button>
            <button type="button" className={`${button} border-slate-700 text-slate-300 hover:bg-slate-800`} onClick={() => {
                if (control.current) control.current.stopped = true;
                demoPlayback.stop();
              }}>
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
    </section>
  );
};
