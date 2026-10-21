import { useEffect, useMemo } from "react";
import type { ToolRegistry, ToolRegistryView, ToolViewOptions } from "@pixerate/editor/tools";

/**
 * A `registry.view(options)` for the component's lifetime: serve it with `useToolBridge` or
 * `createMcpServer` instead of the registry to show an agent only some toolsets, only read
 * tools, or a discovery surface (`discovery`). Changing `toolsets` (e.g. to the focused
 * editor's) updates the same view and announces the new tool list; changing `readOnly` or
 * `discovery` makes a new view. Memoize `discovery` options (they hold skill files).
 */
export function useToolRegistryView(registry: ToolRegistry | null | undefined, options: ToolViewOptions = {}): ToolRegistryView | null {
  const { toolsets, readOnly, discovery } = options;
  const view = useMemo(
    () => (registry ? registry.view({ toolsets, readOnly, discovery }) : null),
    // toolsets is applied below without making a new view, so enabled tools survive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registry, readOnly, discovery],
  );
  const toolsetsKey = typeof toolsets === "function" ? toolsets : JSON.stringify(toolsets ?? null);
  useEffect(() => {
    view?.setToolsets(toolsets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, toolsetsKey]);
  useEffect(() => () => view?.dispose(), [view]);
  return view;
}
