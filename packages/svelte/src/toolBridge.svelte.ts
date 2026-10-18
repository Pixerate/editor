import { connectToolBridge, type ConnectToolBridgeOptions, type ToolBridgeConnection, type ToolBridgeStatus, type ToolRegistry } from "@pixerate/editor/tools";

type MaybeGetter<T> = T | (() => T);
const read = <T>(value: MaybeGetter<T>): T => (typeof value === "function" ? (value as () => T)() : value);

export interface SvelteToolBridge {
  /** "off" while no options are given (reactive). */
  readonly status: ToolBridgeStatus | "off";
  /** Why the last connection ended (e.g. "Bad token"), when the bridge said. */
  readonly detail: string | undefined;
  /** The id the bridge gave this editor (`list_editors`). */
  readonly editorId: string | null;
}

/**
 * Connects a `ToolRegistry` to a local MCP bridge (`pixerate-mcp-bridge`) for the lifetime of
 * the calling component, so an MCP client can call the page's tools. Pass getters to react to
 * changes; `null` options stay disconnected. Parity with React's `useToolBridge`.
 */
export function useToolBridge(
  registry: MaybeGetter<ToolRegistry | null | undefined>,
  options: MaybeGetter<ConnectToolBridgeOptions | null>,
): SvelteToolBridge {
  let status = $state<ToolBridgeStatus | "off">("off");
  let detail = $state<string | undefined>(undefined);
  let editorId = $state<string | null>(null);
  $effect(() => {
    const currentRegistry = read(registry);
    const currentOptions = read(options);
    if (!currentRegistry || !currentOptions) {
      status = "off";
      editorId = null;
      return;
    }
    let connection: ToolBridgeConnection | undefined;
    connection = connectToolBridge(currentRegistry, {
      ...currentOptions,
      onStatus: (next, why) => {
        status = next;
        detail = why;
        editorId = connection?.editorId ?? null;
        currentOptions.onStatus?.(next, why);
      },
    });
    status = connection.status;
    return () => connection?.close();
  });
  return {
    get status() {
      return status;
    },
    get detail() {
      return detail;
    },
    get editorId() {
      return editorId;
    },
  };
}
