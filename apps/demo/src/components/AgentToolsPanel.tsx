import React, { useEffect, useMemo, useState } from "react";
import type { McpToolDefinition, McpToolResult } from "@pixerate/editor/agent";
import { Bot, Play, Plug } from "lucide-react";
import { useToolBridge } from "@pixerate/editor-react";
import { demoToolRegistry } from "../agentTools";

/** Example arguments for a tool, so "Call" works without typing JSON. */
const EXAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  get_text: { format: "text" },
  insert_text: { text: " (inserted by an agent tool)" },
  replace_selection: { text: "agent text" },
  edit_table: { operation: "insertTable", rows: 2, cols: 3, withHeaderRow: true },
  get_range: { range: "A1:F4" },
  set_cell: { cell: "D2", value: "200" },
};

function exampleArgsFor(tool: McpToolDefinition): string {
  // Namespaced tools look like `doc__get_text`.
  const baseName = tool.name.split("__").pop() ?? tool.name;
  const example = EXAMPLE_ARGS[baseName];
  if (example) return JSON.stringify(example, null, 2);
  const args: Record<string, unknown> = {};
  for (const key of tool.inputSchema.required ?? []) args[key] = "";
  return JSON.stringify(args, null, 2);
}

/**
 * Connects the demo's registry to a local MCP bridge (`npx pixerate-mcp-bridge`), so an MCP
 * client (Claude Desktop, Claude Code) can call the tools of the open tab.
 */
const BridgeConnect: React.FC = () => {
  const [on, setOn] = useState(false);
  const [token, setToken] = useState("");
  const options = useMemo(() => (on ? { name: "Pixerate demo", token: token || undefined } : null), [on, token]);
  const bridge = useToolBridge(demoToolRegistry, options);
  const label =
    bridge.status === "connected"
      ? `connected as ${bridge.editorId}`
      : bridge.status === "off"
        ? "off"
        : bridge.status === "disconnected"
          ? `not connected${bridge.detail ? ` (${bridge.detail})` : ""}, retrying…`
          : bridge.status;
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3 text-xs" data-testid="mcp-bridge">
      <Plug className="w-3.5 h-3.5 text-cyan-400" />
      <span className="text-slate-400">MCP bridge</span>
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="token (optional)"
        aria-label="MCP bridge token"
        className="w-36 bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200"
      />
      <button
        type="button"
        onClick={() => setOn((v) => !v)}
        className="px-2.5 py-1 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200"
      >
        {on ? "Disconnect" : "Connect"}
      </button>
      <span className={bridge.status === "connected" ? "text-emerald-400" : "text-slate-500"}>{label}</span>
      <span className="text-slate-600">
        Run <code className="text-slate-400">npx pixerate-mcp-bridge</code> and add it to your MCP client.
      </span>
    </div>
  );
};

/**
 * Live view of the demo's `ToolRegistry`: the MCP `tools/list` result,
 * refreshed through `onListChanged` as editors mount and unmount, plus a
 * `tools/call` runner.
 */
export const AgentToolsPanel: React.FC = () => {
  const [tools, setTools] = useState<McpToolDefinition[]>(
    () => demoToolRegistry.listTools().tools
  );
  const [changeCount, setChangeCount] = useState(0);
  const [selected, setSelected] = useState<string>("");
  const [argsText, setArgsText] = useState("{}");
  const [result, setResult] = useState<McpToolResult | null>(null);
  const [argsError, setArgsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Pick up registrations that happened before this effect subscribed.
    setTools(demoToolRegistry.listTools().tools);
    return demoToolRegistry.onListChanged((next) => {
      setTools(next);
      setChangeCount((n) => n + 1);
    });
  }, []);

  const selectedTool = tools.find((t) => t.name === selected);

  // Keep the selection valid as tools come and go.
  useEffect(() => {
    if (selectedTool || tools.length === 0) return;
    setSelected(tools[0].name);
    setArgsText(exampleArgsFor(tools[0]));
  }, [tools, selectedTool]);

  const selectTool = (tool: McpToolDefinition) => {
    setSelected(tool.name);
    setArgsText(exampleArgsFor(tool));
    setResult(null);
    setArgsError(null);
  };

  const callTool = async () => {
    if (!selectedTool) return;
    let args: Record<string, unknown>;
    try {
      args = argsText.trim() ? JSON.parse(argsText) : {};
    } catch (error) {
      setArgsError(error instanceof Error ? error.message : String(error));
      return;
    }
    setArgsError(null);
    setBusy(true);
    try {
      setResult(await demoToolRegistry.callTool(selectedTool.name, args));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="mt-8 bg-slate-900/50 border border-slate-800 rounded-xl p-5"
      data-testid="agent-tools-panel"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-cyan-400" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            Agent Tools (ToolRegistry · MCP tools/list)
          </h3>
        </div>
        <span className="text-[10px] font-mono text-slate-500">
          {tools.length} tools · {changeCount} listChanged
        </span>
      </div>
      <BridgeConnect />
      <p className="text-xs text-slate-400 mb-3">
        Each mounted editor registers a tool provider with{" "}
        <code className="text-slate-300">useAgentToolProvider</code>. Switch tabs
        and the list updates through <code className="text-slate-300">onListChanged</code>.
      </p>

      {tools.length === 0 ? (
        <div className="text-xs text-slate-500 italic">
          No tools registered. Open the Spreadsheet, Document, Prompt or Canvas tab.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <ul className="space-y-1 text-xs font-mono max-h-64 overflow-y-auto" aria-label="Registered tools">
            {tools.map((tool) => (
              <li key={tool.name}>
                <button
                  type="button"
                  onClick={() => selectTool(tool)}
                  className={`w-full text-left px-2 py-1.5 rounded border transition-colors ${
                    tool.name === selected
                      ? "border-cyan-500/50 bg-cyan-500/10 text-cyan-200"
                      : "border-slate-800 bg-slate-950 text-slate-300 hover:border-slate-700"
                  }`}
                  data-tool-name={tool.name}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{tool.name}</span>
                    {tool.annotations?.readOnlyHint && (
                      <span className="text-[10px] text-emerald-400 shrink-0">read-only</span>
                    )}
                  </div>
                  {tool.description && (
                    <div className="text-[10px] text-slate-500 font-sans truncate">
                      {tool.description}
                    </div>
                  )}
                </button>
              </li>
            ))}
          </ul>

          <div className="space-y-2">
            <label className="block text-[10px] uppercase tracking-wider text-slate-400">
              Arguments for <span className="font-mono normal-case">{selected}</span>
              <textarea
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                rows={4}
                spellCheck={false}
                aria-label="Tool arguments (JSON)"
                className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-lg p-2 font-mono text-xs text-slate-200 normal-case tracking-normal focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
              />
            </label>
            {argsError && <div className="text-xs text-red-400">Invalid JSON: {argsError}</div>}
            <button
              type="button"
              onClick={callTool}
              disabled={!selectedTool || busy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white transition-colors"
            >
              <Play className="w-3.5 h-3.5" /> Call tool
            </button>
            {result && (
              <pre
                data-testid="agent-tool-result"
                className={`p-2 rounded-lg border text-[11px] font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto ${
                  result.isError
                    ? "border-red-500/40 bg-red-950/30 text-red-300"
                    : "border-slate-800 bg-slate-950 text-slate-300"
                }`}
              >
                {result.content
                  .map((block) => (block.type === "text" ? String(block.text) : `[${block.type}]`))
                  .join("\n")}
              </pre>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
