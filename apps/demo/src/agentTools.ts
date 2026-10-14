import { ToolRegistry } from "@pixerate/editor/agent";

/**
 * One MCP-style tool registry for the whole demo. Each mounted editor
 * (rich document, prompt studio, spreadsheet, canvas) registers a provider
 * with `useAgentToolProvider`, so the tool list changes as you switch tabs.
 */
export const demoToolRegistry = new ToolRegistry();
