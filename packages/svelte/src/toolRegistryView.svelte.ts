import type { ToolRegistry, ToolRegistryView, ToolViewOptions } from "@pixerate/editor/tools";

type MaybeGetter<T> = T | (() => T);
const read = <T>(value: MaybeGetter<T>): T => (typeof value === "function" ? (value as () => T)() : value);

export interface SvelteToolRegistryView {
  /** The view, or `null` while there is no registry (reactive). */
  readonly view: ToolRegistryView | null;
}

/**
 * A `registry.view(options)` for the lifetime of the calling component: serve it with
 * `useToolBridge` or `createMcpServer` instead of the registry to show an agent only some
 * toolsets, only read tools, or a discovery surface (`discovery`). Pass getters to react to
 * changes: a new `toolsets` value (e.g. the focused editor's) updates the same view and
 * announces the new tool list; a new registry, `readOnly` or `discovery` makes a new view.
 * Parity with React's `useToolRegistryView`.
 */
export function useToolRegistryView(
  registry: MaybeGetter<ToolRegistry | null | undefined>,
  options: MaybeGetter<ToolViewOptions> = {},
): SvelteToolRegistryView {
  let view = $state.raw<ToolRegistryView | null>(null);
  // Plain (untracked) copies, so the effect never reads the state it writes.
  let current: ToolRegistryView | null = null;
  let made: { registry: ToolRegistry; readOnly?: boolean; discovery?: ToolViewOptions["discovery"] } | null = null;
  $effect(() => {
    const currentRegistry = read(registry);
    const { readOnly, discovery, toolsets } = read(options);
    if (current && made && made.registry === currentRegistry && made.readOnly === readOnly && made.discovery === discovery) {
      current.setToolsets(toolsets);
      return;
    }
    current?.dispose();
    made = currentRegistry ? { registry: currentRegistry, readOnly, discovery } : null;
    current = currentRegistry ? currentRegistry.view({ readOnly, discovery, toolsets }) : null;
    view = current;
  });
  $effect(() => () => {
    current?.dispose();
    current = null;
    made = null;
  });
  return {
    get view() {
      return view;
    },
  };
}
