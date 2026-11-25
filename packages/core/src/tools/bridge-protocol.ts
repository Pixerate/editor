// The tool bridge protocol: messages between an editor (`connectToolBridge`, `serveToolSource`)
// and a bridge (`createToolBridge`, `createRemoteToolProvider`), whatever carries them.
import type { McpToolDefinition, McpToolResult } from './registry.js';

/** Protocol version spoken between `connectToolBridge` and `createToolBridge`. */
export const TOOL_BRIDGE_PROTOCOL = 1;

/** Default port the bridge listens on (127.0.0.1 only). */
export const TOOL_BRIDGE_DEFAULT_PORT = 4477;

/** Editor → bridge messages. */
export type ToolBridgeEditorMessage =
	| { t: 'hello'; v: number; name: string; kind?: string; tools: McpToolDefinition[] }
	| { t: 'tools'; tools: McpToolDefinition[] }
	| { t: 'result'; id: string; result: McpToolResult };

/** Bridge → editor messages. */
export type ToolBridgeServerMessage =
	| { t: 'welcome'; v: number; id: string }
	| { t: 'call'; id: string; name: string; arguments: Record<string, unknown> }
	| { t: 'cancel'; id: string; reason?: string };
