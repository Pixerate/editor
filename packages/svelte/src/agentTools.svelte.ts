import type { AgentToolProvider, ToolRegistry } from "@pixerate/editor/agent";

type MaybeGetter<T> = T | (() => T);

const read = <T>(value: MaybeGetter<T>): T =>
  typeof value === "function" ? (value as () => T)() : value;

/**
 * Registers a tool provider with a `ToolRegistry` for the lifetime of the
 * calling component (call it during component initialisation) and
 * unregisters it on destroy. Pass getters to react to changes, e.g.
 * `useAgentToolProvider(registry, () => editor && createRichTextToolProvider(editor, { id }))`:
 * when the getter returns a different provider, the old one is unregistered.
 */
export function useAgentToolProvider(
  registry: MaybeGetter<ToolRegistry | null | undefined>,
  provider: MaybeGetter<AgentToolProvider | null | undefined>,
): void {
  $effect(() => {
    const currentRegistry = read(registry);
    const currentProvider = read(provider);
    if (!currentRegistry || !currentProvider) return;
    return currentRegistry.register(currentProvider);
  });
}
