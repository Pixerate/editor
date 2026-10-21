import type { AgentPlayback, AgentToolProvider, ToolRegistry } from "@pixerate/editor/tools";

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
  options: { playback?: MaybeGetter<AgentPlayback | null | undefined> } = {},
): void {
  $effect(() => {
    const currentRegistry = read(registry);
    const playback = options.playback === undefined ? undefined : read(options.playback);
    // Plays the registry's calls with this playback (installed once per registry).
    if (currentRegistry && playback) playback.install(currentRegistry);
  });
  $effect(() => {
    const currentRegistry = read(registry);
    const currentProvider = read(provider);
    if (!currentRegistry || !currentProvider) return;
    return currentRegistry.register(currentProvider);
  });
}
