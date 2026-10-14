import React from 'react';
import {
  bindCanvasToken,
  getBindableTokenProperties,
  getEffectiveTokenModes,
  getNodeTokenBindings,
  getNodeTokenModes,
  setCanvasTokenMode,
  getTokensForProperty,
  type CanvasNode,
  type CanvasTokenOptions,
} from '@pixerate/editor/canvas';
import { getCurrentMode, resolveToken, type TokenState } from '@pixerate/editor/tokens';

export interface TokenBindingPickerProps<TNode extends CanvasNode = CanvasNode> {
  state: TokenState;
  nodes: TNode[];
  /** Nodes to bind (the first one decides which properties are listed). */
  selectedIds: readonly string[];
  /** Receives the nodes with the binding applied and resolved. */
  onChange: (nodes: TNode[]) => void;
  options?: CanvasTokenOptions;
  /** Limit to these property keys (in this order). */
  properties?: readonly string[];
  onError?: (error: Error) => void;
  className?: string;
}

/**
 * Inspector rows that bind node properties (fill, stroke, opacity, radius, gap, padding, text
 * colour / size, …) to variables of the right type and scope, showing each resolved value.
 */
export function TokenBindingPicker<TNode extends CanvasNode = CanvasNode>({
  state,
  nodes,
  selectedIds,
  onChange,
  options = {},
  properties,
  onError,
  className = '',
}: TokenBindingPickerProps<TNode>) {
  const selected = nodes.filter((n) => selectedIds.includes(n.id));
  const first = selected[0];
  if (!first) return null;
  let rows = getBindableTokenProperties(first, options);
  if (properties) rows = properties.map((key) => rows.find((p) => p.key === key)).filter((p): p is (typeof rows)[number] => !!p);
  const modes = getEffectiveTokenModes(first, nodes, state, options);

  return (
    <div data-token-binding-picker="" className={`flex flex-col gap-1 text-xs text-foreground ${className}`}>
      {rows.map((property) => {
        const ids = new Set(selected.map((n) => getNodeTokenBindings(n)[property.key] ?? ''));
        const value = ids.size === 1 ? [...ids][0] : '__mixed';
        const candidates = getTokensForProperty(state, property, first);
        const resolved = value && value !== '__mixed' ? resolveToken(state, value, modes) : null;
        return (
          <label key={property.key} className="flex items-center gap-2" data-token-property={property.key}>
            <span className="w-28 shrink-0 text-muted-foreground">{property.label}</span>
            <select
              aria-label={`${property.label} variable`}
              className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-xs"
              value={value}
              onChange={(e) => {
                const id = e.currentTarget.value || null;
                try {
                  onChange(bindCanvasToken(nodes, selectedIds, property.key, id, state, options));
                } catch (error) {
                  onError?.(error as Error);
                }
              }}
            >
              {value === '__mixed' ? <option value="__mixed">Mixed</option> : null}
              <option value="">None</option>
              {candidates.map((v) => {
                const collection = state.collections.find((c) => c.id === v.collectionId);
                return (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {collection && state.collections.length > 1 ? ` (${collection.name})` : ''}
                  </option>
                );
              })}
            </select>
            <span className="w-16 shrink-0 truncate text-right text-muted-foreground" data-token-resolved="">
              {resolved?.ok ? (
                property.type === 'color' ? (
                  <span
                    className="inline-block h-3 w-3 rounded border border-border align-middle"
                    style={{ background: String(resolved.value) }}
                    title={String(resolved.value)}
                  />
                ) : (
                  String(resolved.value)
                )
              ) : resolved ? (
                <span title={resolved.message}>⚠</span>
              ) : null}
            </span>
          </label>
        );
      })}
      {state.collections.length === 0 ? <p className="text-muted-foreground">No variables yet.</p> : null}
    </div>
  );
}

export interface TokenModeSwitcherProps<TNode extends CanvasNode = CanvasNode> {
  state: TokenState;
  nodes: TNode[];
  /** Frames / groups whose explicit mode is set (the first one's choice is shown). */
  nodeIds: readonly string[];
  onChange: (nodes: TNode[]) => void;
  options?: CanvasTokenOptions;
  /** Show collections with a single mode too (default `false`). */
  showSingleMode?: boolean;
  className?: string;
}

/**
 * Per-collection mode pickers for the selected frames: "Auto" (inherit from the parent, then
 * the root modes, then the default mode) or an explicit mode that descendants inherit.
 */
export function TokenModeSwitcher<TNode extends CanvasNode = CanvasNode>({
  state,
  nodes,
  nodeIds,
  onChange,
  options = {},
  showSingleMode = false,
  className = '',
}: TokenModeSwitcherProps<TNode>) {
  const first = nodes.find((n) => nodeIds.includes(n.id));
  if (!first) return null;
  const own = getNodeTokenModes(first);
  const parent = first.parentId ? nodes.find((n) => n.id === first.parentId) : undefined;
  const inherited = parent ? getEffectiveTokenModes(parent, nodes, state, options) : { ...options.modes };
  const collections = state.collections.filter((c) => showSingleMode || c.modes.length > 1);
  return (
    <div data-token-mode-switcher="" className={`flex flex-col gap-1 text-xs text-foreground ${className}`}>
      {collections.map((collection) => {
        const auto = getCurrentMode(collection, inherited);
        const explicit = collection.modes.some((m) => m.id === own[collection.id]) ? own[collection.id] : '';
        return (
          <label key={collection.id} className="flex items-center gap-2" data-token-collection={collection.id}>
            <span className="w-28 shrink-0 truncate text-muted-foreground">{collection.name}</span>
            <select
              aria-label={`${collection.name} mode`}
              className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-xs"
              value={explicit}
              onChange={(e) =>
                onChange(setCanvasTokenMode(nodes, nodeIds, collection.id, e.currentTarget.value || null, state, options))
              }
            >
              <option value="">Auto ({auto.name})</option>
              {collection.modes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </div>
  );
}
