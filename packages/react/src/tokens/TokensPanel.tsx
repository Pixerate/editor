import React, { useState } from 'react';
import {
  TOKEN_TYPES,
  TokenError,
  getCollectionVariables,
  getTokenVariable,
  isTokenAlias,
  resolveTokenInMode,
  type TokenCollection,
  type TokenLiteral,
  type TokenMode,
  type TokenState,
  type TokenStore,
  type TokenType,
  type TokenVariable,
} from '@pixerate/editor/tokens';
import { useTokenState } from './useTokens';

export interface TokensPanelProps {
  store: TokenStore;
  /** Selected collection (controlled); defaults to the first. */
  collectionId?: string;
  onCollectionChange?: (collectionId: string) => void;
  /** Called with refused edits (also shown in the panel). */
  onError?: (error: Error) => void;
  className?: string;
}

const input =
  'w-full min-w-0 rounded border border-border bg-background px-1.5 py-0.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary';
const button = 'rounded border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-40';

/** Commits on blur or Enter; resets when `value` changes from outside. */
function CommitInput({
  value,
  onCommit,
  ...rest
}: { value: string; onCommit: (value: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <input
      key={value}
      defaultValue={value}
      className={input}
      onBlur={(e) => {
        if (e.currentTarget.value !== value) onCommit(e.currentTarget.value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.currentTarget.value = value;
          e.currentTarget.blur();
        }
      }}
      {...rest}
    />
  );
}

/** A colour swatch (checkered under translucent colours). */
export function TokenSwatch({ color, className = '' }: { color: string; className?: string }) {
  return (
    <span
      data-token-swatch={color}
      className={`inline-block h-4 w-4 shrink-0 rounded border border-border ${className}`}
      style={{ background: `linear-gradient(${color}, ${color}), repeating-conic-gradient(#ccc 0 25%, #fff 0 50%) 0 0 / 8px 8px` }}
      aria-hidden="true"
    />
  );
}

function LiteralEditor({
  variable,
  value,
  onSet,
}: {
  variable: TokenVariable;
  value: TokenLiteral;
  onSet: (value: unknown) => void;
}) {
  switch (variable.type) {
    case 'color':
      return (
        <span className="flex items-center gap-1">
          <label className="relative">
            <TokenSwatch color={String(value)} />
            <input
              type="color"
              aria-label={`${variable.name} colour`}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              value={String(value).slice(0, 7)}
              onChange={(e) => onSet(e.currentTarget.value + String(value).slice(7))}
            />
          </label>
          <CommitInput value={String(value)} aria-label={`${variable.name} value`} onCommit={onSet} />
        </span>
      );
    case 'number':
      return <CommitInput value={String(value)} inputMode="decimal" aria-label={`${variable.name} value`} onCommit={onSet} />;
    case 'string':
      return <CommitInput value={String(value)} aria-label={`${variable.name} value`} onCommit={onSet} />;
    case 'boolean':
      return (
        <input
          type="checkbox"
          aria-label={`${variable.name} value`}
          checked={value === true}
          onChange={(e) => onSet(e.currentTarget.checked)}
        />
      );
  }
}

function ValueCell({
  state,
  variable,
  mode,
  onSet,
}: {
  state: TokenState;
  variable: TokenVariable;
  mode: TokenMode;
  onSet: (value: unknown) => void;
}) {
  const value = variable.valuesByMode[mode.id];
  const alias = isTokenAlias(value) ? value.alias : '';
  const resolved = resolveTokenInMode(state, variable.id, mode.id);
  const candidates = state.variables.filter((v) => v.type === variable.type && v.id !== variable.id);
  return (
    <td className="px-1 py-1 align-middle" data-variable-id={variable.id} data-mode-id={mode.id}>
      <div className="flex items-center gap-1">
        {alias ? (
          <span className="flex min-w-0 flex-1 items-center gap-1 text-xs" data-token-alias={alias}>
            {variable.type === 'color' && resolved !== undefined ? <TokenSwatch color={String(resolved)} /> : null}
            <span className="truncate">→ {getTokenVariable(state, alias)?.name ?? alias}</span>
          </span>
        ) : (
          <span className="min-w-0 flex-1">
            <LiteralEditor variable={variable} value={value as TokenLiteral} onSet={onSet} />
          </span>
        )}
        <select
          aria-label={`${variable.name} alias in ${mode.name}`}
          className="w-5 shrink-0 rounded border border-border bg-background text-xs"
          title="Alias"
          value={alias}
          onChange={(e) => {
            const target = e.currentTarget.value;
            // "Value" detaches the alias to what it resolves to.
            onSet(target ? { alias: target } : resolved ?? undefined);
          }}
        >
          <option value="">Value</option>
          {candidates.map((v) => (
            <option key={v.id} value={v.id}>
              → {v.name}
            </option>
          ))}
        </select>
      </div>
    </td>
  );
}

/**
 * Figma-style variables panel: collections, modes as columns, typed values with colour
 * swatches, aliases (→), add / rename / delete, undo / redo. Edits go through the store, so
 * each is one undo step; refused edits (cycles, duplicate names) show as an alert.
 */
export function TokensPanel({ store, collectionId, onCollectionChange, onError, className = '' }: TokensPanelProps) {
  const state = useTokenState(store);
  const [ownSelection, setOwnSelection] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [newCollection, setNewCollection] = useState('');
  const [newMode, setNewMode] = useState('');
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<TokenType>('color');

  const selectedId = collectionId ?? ownSelection;
  const collection: TokenCollection | undefined = state.collections.find((c) => c.id === selectedId) ?? state.collections[0];
  const select = (id: string) => {
    setOwnSelection(id);
    onCollectionChange?.(id);
  };
  const run = (fn: () => void) => {
    try {
      fn();
      setError(null);
    } catch (e) {
      const err = e as Error;
      setError(err instanceof TokenError ? err.message : String(err));
      onError?.(err);
    }
  };
  const variables = collection ? getCollectionVariables(state, collection.id) : [];

  return (
    <div data-tokens-panel="" className={`flex flex-col gap-2 text-xs text-foreground ${className}`}>
      <div className="flex flex-wrap items-center gap-2">
        {state.collections.length > 0 ? (
          <select
            aria-label="Collection"
            className="rounded border border-border bg-background px-1.5 py-0.5 text-xs"
            value={collection?.id ?? ''}
            onChange={(e) => select(e.currentTarget.value)}
          >
            {state.collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        ) : null}
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => {
              const created = store.createCollection(newCollection, ['Light', 'Dark']);
              setNewCollection('');
              select(created.id);
            });
          }}
        >
          <input
            className={input}
            placeholder="New collection"
            aria-label="New collection name"
            value={newCollection}
            onChange={(e) => setNewCollection(e.currentTarget.value)}
          />
          <button type="submit" className={button} disabled={!newCollection.trim()}>
            Add
          </button>
        </form>
        <span className="ml-auto flex gap-1">
          <button type="button" className={button} disabled={!store.canUndo()} onClick={() => store.undo()} aria-label="Undo token edit">
            Undo
          </button>
          <button type="button" className={button} disabled={!store.canRedo()} onClick={() => store.redo()} aria-label="Redo token edit">
            Redo
          </button>
        </span>
      </div>

      {error ? (
        <div role="alert" className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-red-500">
          {error}
        </div>
      ) : null}

      {collection ? (
        <>
          <div className="flex items-center gap-1">
            <CommitInput value={collection.name} aria-label="Collection name" onCommit={(name) => run(() => store.renameCollection(collection.id, name))} />
            <button type="button" className={button} onClick={() => run(() => store.deleteCollection(collection.id))} aria-label={`Delete collection ${collection.name}`}>
              Delete
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-1 py-1 font-medium">Name</th>
                  {collection.modes.map((mode, index) => (
                    <th key={mode.id} className="px-1 py-1 font-medium" data-mode-id={mode.id}>
                      <div className="flex items-center gap-1">
                        <CommitInput
                          value={mode.name}
                          aria-label={`Mode ${mode.name} name`}
                          onCommit={(name) => run(() => store.renameMode(collection.id, mode.id, name))}
                        />
                        {index === 0 ? (
                          <span title="Default mode" className="text-[10px] uppercase">
                            default
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="px-1 hover:text-foreground"
                            title="Make default"
                            aria-label={`Make ${mode.name} the default mode`}
                            onClick={() => run(() => store.setDefaultMode(collection.id, mode.id))}
                          >
                            ★
                          </button>
                        )}
                        {collection.modes.length > 1 ? (
                          <button
                            type="button"
                            className="px-1 hover:text-foreground"
                            aria-label={`Remove mode ${mode.name}`}
                            onClick={() => run(() => store.removeMode(collection.id, mode.id))}
                          >
                            ×
                          </button>
                        ) : null}
                      </div>
                    </th>
                  ))}
                  <th className="px-1 py-1">
                    <form
                      className="flex items-center gap-1"
                      onSubmit={(e) => {
                        e.preventDefault();
                        run(() => {
                          store.addMode(collection.id, newMode);
                          setNewMode('');
                        });
                      }}
                    >
                      <input
                        className={input}
                        placeholder="Mode"
                        aria-label="New mode name"
                        value={newMode}
                        onChange={(e) => setNewMode(e.currentTarget.value)}
                      />
                      <button type="submit" className={button} disabled={!newMode.trim()} aria-label="Add mode">
                        +
                      </button>
                    </form>
                  </th>
                </tr>
              </thead>
              <tbody>
                {variables.map((variable) => (
                  <tr key={variable.id} className="border-b border-border/50" data-token-row={variable.id}>
                    <td className="px-1 py-1">
                      <div className="flex items-center gap-1">
                        <span className="w-4 text-center text-muted-foreground" title={variable.type}>
                          {variable.type === 'color' ? '◐' : variable.type === 'number' ? '#' : variable.type === 'string' ? 'T' : '⊘'}
                        </span>
                        <CommitInput
                          value={variable.name}
                          aria-label={`Variable ${variable.name} name`}
                          onCommit={(name) => run(() => store.renameVariable(variable.id, name))}
                        />
                      </div>
                    </td>
                    {collection.modes.map((mode) => (
                      <ValueCell
                        key={mode.id}
                        state={state}
                        variable={variable}
                        mode={mode}
                        onSet={(value) => run(() => store.setValue(variable.id, value, mode.id))}
                      />
                    ))}
                    <td className="px-1 py-1 text-right">
                      <button
                        type="button"
                        className="px-1 text-muted-foreground hover:text-foreground"
                        aria-label={`Delete variable ${variable.name}`}
                        onClick={() => run(() => store.deleteVariables(variable.id))}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => {
                store.createVariable({ collectionId: collection.id, name: newName, type: newType });
                setNewName('');
              });
            }}
          >
            <input
              className={input}
              placeholder="color/bg"
              aria-label="New variable name"
              value={newName}
              onChange={(e) => setNewName(e.currentTarget.value)}
            />
            <select
              aria-label="New variable type"
              className="rounded border border-border bg-background px-1 py-0.5 text-xs"
              value={newType}
              onChange={(e) => setNewType(e.currentTarget.value as TokenType)}
            >
              {TOKEN_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button type="submit" className={button} disabled={!newName.trim()}>
              Add variable
            </button>
          </form>
        </>
      ) : (
        <p className="text-muted-foreground">No collections yet.</p>
      )}
    </div>
  );
}
