import { useEffect } from "react";
import type { AgentToolProvider, ToolRegistry } from "@pixerate/editor/tools";

/**
 * Registers a tool provider with a `ToolRegistry` while the component is
 * mounted and unregisters it on unmount (the registry then announces the
 * change through `onListChanged`).
 *
 * Memoize the provider (e.g. `useMemo(() => createRichTextToolProvider(editor,
 * { id }), [editor])`): a new provider object re-registers it. Pass `null`
 * while it isn't ready.
 */
export function useAgentToolProvider(
  registry: ToolRegistry | null | undefined,
  provider: AgentToolProvider | null | undefined,
): void {
  useEffect(() => {
    if (!registry || !provider) return;
    return registry.register(provider);
  }, [registry, provider]);
}
