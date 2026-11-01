import { ToolRegistry, createAgentPlayback, createPlaybackToolProvider, type SkillFiles } from "@pixerate/editor/agent";
import { CommandRegistry, createCommandToolProvider } from "@pixerate/editor/commands";
import { createEditorDocumentStore, createIndexedDbAdapter, createMemoryStorage, isIndexedDbAvailable } from "@pixerate/editor/persistence";

/**
 * One MCP-style tool registry for the whole demo. Each mounted editor
 * (rich document, prompt studio, spreadsheet, canvas) registers a provider
 * with `useAgentToolProvider`, so the tool list changes as you switch tabs.
 */
export const demoToolRegistry = new ToolRegistry();

/**
 * Agent playback for the demo: every call through `demoToolRegistry` (the scripted agents, the
 * agent tools panel, or an MCP client on the bridge) is acted out by the agent's cursor on the
 * editor surface it targets, at `?agentSpeed=` (Infinity for none). Editors without a surface yet
 * run their calls instantly. The demo also glances at reads, so a script's reading steps show
 * (the library default shows only changes), and offers `playback__say` for agents' notes.
 */
export const demoPlayback = createAgentPlayback({
  speed: Number(new URLSearchParams(window.location.search).get("agentSpeed") ?? 1) || 1,
  reads: "glance",
  actor: { id: "agent", name: "Agent", color: "#7c3aed" },
});
demoPlayback.install(demoToolRegistry);
demoToolRegistry.register(createPlaybackToolProvider(demoPlayback));

/** Where the demo keeps autosave snapshots and saved documents (IndexedDB, or memory when it is missing). */
export const demoDocumentStorage = isIndexedDbAvailable() ? createIndexedDbAdapter("pixerate-demo") : createMemoryStorage();

/**
 * Saved documents for every editor tab: the `save_<kind>_document`, `list_saved_<kind>_documents`
 * and `open_saved_<kind>_document` agent tools read and write it.
 */
export const demoDocumentStore = createEditorDocumentStore({ storage: demoDocumentStorage, namespace: "pixerate-demo.documents" });

/**
 * One command registry for the whole demo: the command palette (Mod+K) and the
 * agent tools (`commands__list_commands`, `commands__run_command`, …) run the same
 * commands. Tabs register their commands while mounted.
 */
export const demoCommandRegistry = new CommandRegistry();

// The canvas's annotation gestures are also tools of their own (`commands__canvas_circle`, …), so
// an agent can mark up the canvas without listing commands first.
const DEMO_GESTURE_TOOLS = ["canvas.circle", "canvas.underline", "canvas.arrow", "canvas.bracket", "canvas.strike", "canvas.cross", "canvas.check"];

demoToolRegistry.register(createCommandToolProvider(demoCommandRegistry, { id: "commands", namespace: "commands", tools: DEMO_GESTURE_TOOLS }));

/**
 * The agent skills shipped in `@pixerate/editor/skills`, keyed `pixerate-chart/SKILL.md`, for
 * `get_skill` in the agent tools panel's discovery mode.
 */
export const demoSkillFiles: SkillFiles = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../../../packages/core/skills/*/**/*.md", { query: "?raw", import: "default", eager: true }),
  ).map(([path, text]) => [path.replace(/^.*\/skills\//, ""), text]),
);
