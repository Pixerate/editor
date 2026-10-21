/**
 * `@pixerate/editor/tools`: the agent tool registry, JSON Schema validation,
 * the static MCP tool definitions and a transport-agnostic MCP server
 * (`createMcpServer`), with no TipTap, ProseMirror or dagre imports. Use it from non-text hosts (canvas-only, spreadsheet-only, effect
 * editors) that combine `AgentToolProvider`s and serve MCP `tools/list` /
 * `tools/call`. The editor-bound providers (`createRichTextToolProvider`,
 * `createEditorMcpToolProvider`, ...) live in `@pixerate/editor/agent`, which
 * re-exports everything here.
 */
export * from './schema.js';
export * from './registry.js';
export * from './definitions.js';
export * from './mcp-server.js';
export * from './bridge-client.js';
export * from './capture.js';
export * from './dom-capture.js';
export * from './view.js';
export * from './search.js';
export * from './skills.js';
