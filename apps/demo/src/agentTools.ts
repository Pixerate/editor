import { ToolRegistry } from "@pixerate/editor/agent";
import { CommandRegistry, createCommandToolProvider } from "@pixerate/editor/commands";

/**
 * One MCP-style tool registry for the whole demo. Each mounted editor
 * (rich document, prompt studio, spreadsheet, canvas) registers a provider
 * with `useAgentToolProvider`, so the tool list changes as you switch tabs.
 */
export const demoToolRegistry = new ToolRegistry();

/**
 * One command registry for the whole demo: the command palette (Mod+K) and the
 * agent tools (`commands__list_commands`, `commands__run_command`, …) run the same
 * commands. Tabs register their commands while mounted.
 */
export const demoCommandRegistry = new CommandRegistry();

demoToolRegistry.register(createCommandToolProvider(demoCommandRegistry, { id: "commands", namespace: "commands" }));
