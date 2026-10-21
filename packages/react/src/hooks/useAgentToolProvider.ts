import { useEffect } from "react";
import type { AgentPlayback, AgentToolProvider, ToolRegistry } from "@pixerate/editor/tools";

export interface UseAgentToolProviderOptions {
  /** Plays the registry's calls with this playback (installed once per registry). */
  playback?: AgentPlayback | null;
}

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
  options: UseAgentToolProviderOptions = {},
): void {
  const { playback } = options;
  useEffect(() => {
    if (registry && playback) playback.install(registry);
  }, [registry, playback]);
  useEffect(() => {
    if (!registry || !provider) return;
    return registry.register(provider);
  }, [registry, provider]);
}
