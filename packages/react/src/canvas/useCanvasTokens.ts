import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  bindCanvasToken,
  detachTokenBindings,
  getEffectiveTokenModes,
  resolveCanvasTokens,
  setCanvasTokenMode,
  type CanvasNode,
  type CanvasTokenOptions,
} from '@pixerate/editor/canvas';
import type { TokenModeContext, TokenState, TokenStore } from '@pixerate/editor/tokens';

export interface UseCanvasTokensOptions<TNode extends CanvasNode> extends Omit<CanvasTokenOptions, 'modes'> {
  store: TokenStore;
  nodes: TNode[];
  setNodes: (update: TNode[] | ((nodes: TNode[]) => TNode[])) => void;
  /** Modes for nodes without an explicit mode up their tree (e.g. the page's). */
  modes?: TokenModeContext;
}

export interface CanvasTokens {
  state: TokenState;
  /** Binds (or with `null` unbinds) a property of the nodes; throws `TokenError` when refused. */
  bind: (ids: Iterable<string>, propertyKey: string, variableId: string | null) => void;
  /** Sets (or with `null` clears) an explicit mode on frames / groups; descendants follow. */
  setMode: (ids: Iterable<string>, collectionId: string, modeId: string | null) => void;
  /** The modes a node is in (its own, inherited, then the root `modes`). */
  modesOf: (nodeId: string) => Record<string, string>;
}

/**
 * Keeps token-bound node properties resolved: whenever the token store, the nodes or the root
 * modes change, bound values are written into the nodes (only when something changed, so it
 * does not loop). Deleting a variable detaches the nodes bound to it, keeping their values.
 */
export function useCanvasTokens<TNode extends CanvasNode>(options: UseCanvasTokensOptions<TNode>): CanvasTokens {
  const { store, nodes, setNodes, modes, properties } = options;
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const latest = useRef({ nodes, setNodes, modes, properties });
  latest.current = { nodes, setNodes, modes, properties };
  const opts = (): CanvasTokenOptions => ({ modes: latest.current.modes, properties: latest.current.properties });

  useEffect(
    () =>
      store.subscribe((event) => {
        if (event.deletedVariableIds.length === 0) return;
        latest.current.setNodes((prev) => detachTokenBindings(prev, event.previous, event.deletedVariableIds, opts()));
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store],
  );

  const modesKey = JSON.stringify(modes ?? {});
  useEffect(() => {
    const next = resolveCanvasTokens(nodes, state, opts());
    if (next !== nodes) setNodes(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, state, modesKey, properties]);

  const bind = useCallback(
    (ids: Iterable<string>, propertyKey: string, variableId: string | null) => {
      const next = bindCanvasToken(latest.current.nodes, ids, propertyKey, variableId, store.getState(), opts());
      if (next !== latest.current.nodes) latest.current.setNodes(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store],
  );
  const setMode = useCallback(
    (ids: Iterable<string>, collectionId: string, modeId: string | null) => {
      const next = setCanvasTokenMode(latest.current.nodes, ids, collectionId, modeId, store.getState(), opts());
      if (next !== latest.current.nodes) latest.current.setNodes(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store],
  );
  const modesOf = useCallback(
    (nodeId: string) => {
      const node = latest.current.nodes.find((n) => n.id === nodeId);
      return node ? getEffectiveTokenModes(node, latest.current.nodes, store.getState(), opts()) : {};
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store],
  );
  return { state, bind, setMode, modesOf };
}
