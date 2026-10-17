import { useEffect, useState } from "react";
import { connectToolBridge, type ConnectToolBridgeOptions, type ToolBridgeConnection, type ToolBridgeStatus, type ToolRegistry } from "@pixerate/editor/tools";

export interface UseToolBridgeResult {
  status: ToolBridgeStatus | "off";
  /** Why the last connection ended (e.g. "Bad token"), when the bridge said. */
  detail?: string;
  /** The id the bridge gave this editor (`list_editors`). */
  editorId: string | null;
}

/**
 * Connects a `ToolRegistry` to a local MCP bridge (`pixerate-mcp-bridge`) while mounted, so an
 * MCP client can call the page's tools. Pass `null` options to stay disconnected. Memoize the
 * options: changing `url`, `token` or `name` reconnects.
 */
export function useToolBridge(registry: ToolRegistry | null | undefined, options: ConnectToolBridgeOptions | null): UseToolBridgeResult {
  const [state, setState] = useState<UseToolBridgeResult>({ status: "off", editorId: null });
  const key = options ? JSON.stringify([options.url, options.token, options.name, options.kind, options.reconnect]) : null;
  useEffect(() => {
    if (!registry || !options) {
      setState({ status: "off", editorId: null });
      return;
    }
    let connection: ToolBridgeConnection | undefined;
    connection = connectToolBridge(registry, {
      ...options,
      onStatus: (status, detail) => {
        setState({ status, detail, editorId: connection?.editorId ?? null });
        options.onStatus?.(status, detail);
      },
    });
    setState({ status: connection.status, editorId: null });
    return () => connection?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, key]);
  return state;
}
