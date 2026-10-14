<script lang="ts">
  import {
    TOKEN_TYPES,
    TokenError,
    getCollectionVariables,
    getTokenVariable,
    isTokenAlias,
    resolveTokenInMode,
    type TokenMode,
    type TokenState,
    type TokenStore,
    type TokenType,
    type TokenVariable
  } from '@pixerate/editor/tokens';
  import { untrack } from 'svelte';
  import TokenSwatch from './TokenSwatch.svelte';

  interface Props {
    store: TokenStore;
    /** Selected collection (controlled); defaults to the first. */
    collectionId?: string;
    oncollectionchange?: (collectionId: string) => void;
    /** Called with refused edits (also shown in the panel). */
    onerror?: (error: Error) => void;
    class?: string;
  }

  let { store, collectionId, oncollectionchange, onerror, class: className = '' }: Props = $props();

  // Re-read the store on every change; follows a replaced `store` prop too.
  let version = $state(0);
  const tokenState: TokenState = $derived((void version, store.getState()));
  $effect(() => {
    const current = store;
    return untrack(() =>
      current.subscribe(() => {
        version += 1;
      })
    );
  });

  let ownSelection = $state<string | undefined>(undefined);
  let error = $state<string | null>(null);
  let newCollection = $state('');
  let newMode = $state('');
  let newName = $state('');
  let newType = $state<TokenType>('color');

  const collection = $derived(
    tokenState.collections.find((c) => c.id === (collectionId ?? ownSelection)) ?? tokenState.collections[0]
  );
  const variables = $derived(collection ? getCollectionVariables(tokenState, collection.id) : []);
  const canUndo = $derived((void version, store.canUndo()));
  const canRedo = $derived((void version, store.canRedo()));

  const input =
    'w-full min-w-0 rounded border border-border bg-background px-1.5 py-0.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary';
  const button = 'rounded border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-40';

  function select(id: string) {
    ownSelection = id;
    oncollectionchange?.(id);
  }

  function run(fn: () => void): boolean {
    try {
      fn();
      error = null;
      return true;
    } catch (e) {
      const err = e as Error;
      error = err instanceof TokenError ? err.message : String(err);
      onerror?.(err);
      return false;
    }
  }

  /** Commit-on-blur handlers for an input showing `value`; refused edits reset the input. */
  function committer(value: string, apply: (next: string) => void) {
    return {
      onblur: (e: FocusEvent) => {
        const el = e.currentTarget as HTMLInputElement;
        if (el.value === value) return;
        if (!run(() => apply(el.value))) el.value = value;
      },
      onkeydown: (e: KeyboardEvent) => {
        const el = e.currentTarget as HTMLInputElement;
        if (e.key === 'Enter') el.blur();
        if (e.key === 'Escape') {
          el.value = value;
          el.blur();
        }
      }
    };
  }

  function aliasCandidates(variable: TokenVariable) {
    return tokenState.variables.filter((v) => v.type === variable.type && v.id !== variable.id);
  }

  function setAlias(variable: TokenVariable, mode: TokenMode, target: string) {
    const resolved = resolveTokenInMode(tokenState, variable.id, mode.id);
    run(() => store.setValue(variable.id, target ? { alias: target } : resolved, mode.id));
  }

  function typeIcon(type: TokenType) {
    return type === 'color' ? '◐' : type === 'number' ? '#' : type === 'string' ? 'T' : '⊘';
  }
</script>

<div data-tokens-panel="" class="flex flex-col gap-2 text-xs text-foreground {className}">
  <div class="flex flex-wrap items-center gap-2">
    {#if tokenState.collections.length > 0}
      <select
        aria-label="Collection"
        class="rounded border border-border bg-background px-1.5 py-0.5 text-xs"
        value={collection?.id ?? ''}
        onchange={(e) => select(e.currentTarget.value)}
      >
        {#each tokenState.collections as c (c.id)}
          <option value={c.id}>{c.name}</option>
        {/each}
      </select>
    {/if}
    <form
      class="flex items-center gap-1"
      onsubmit={(e) => {
        e.preventDefault();
        run(() => {
          const created = store.createCollection(newCollection, ['Light', 'Dark']);
          newCollection = '';
          select(created.id);
        });
      }}
    >
      <input class={input} placeholder="New collection" aria-label="New collection name" bind:value={newCollection} />
      <button type="submit" class={button} disabled={!newCollection.trim()}>Add</button>
    </form>
    <span class="ml-auto flex gap-1">
      <button type="button" class={button} disabled={!canUndo} onclick={() => store.undo()} aria-label="Undo token edit">Undo</button>
      <button type="button" class={button} disabled={!canRedo} onclick={() => store.redo()} aria-label="Redo token edit">Redo</button>
    </span>
  </div>

  {#if error}
    <div role="alert" class="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-red-500">{error}</div>
  {/if}

  {#if collection}
    {@const c = collection}
    <div class="flex items-center gap-1">
      <input class={input} value={c.name} aria-label="Collection name" {...committer(c.name, (name) => store.renameCollection(c.id, name))} />
      <button type="button" class={button} onclick={() => run(() => store.deleteCollection(c.id))} aria-label="Delete collection {c.name}">
        Delete
      </button>
    </div>
    <div class="overflow-x-auto">
      <table class="w-full border-collapse">
        <thead>
          <tr class="border-b border-border text-left text-muted-foreground">
            <th class="px-1 py-1 font-medium">Name</th>
            {#each c.modes as mode, index (mode.id)}
              <th class="px-1 py-1 font-medium" data-mode-id={mode.id}>
                <div class="flex items-center gap-1">
                  <input
                    class={input}
                    value={mode.name}
                    aria-label="Mode {mode.name} name"
                    {...committer(mode.name, (name) => store.renameMode(c.id, mode.id, name))}
                  />
                  {#if index === 0}
                    <span title="Default mode" class="text-[10px] uppercase">default</span>
                  {:else}
                    <button
                      type="button"
                      class="px-1 hover:text-foreground"
                      title="Make default"
                      aria-label="Make {mode.name} the default mode"
                      onclick={() => run(() => store.setDefaultMode(c.id, mode.id))}>★</button
                    >
                  {/if}
                  {#if c.modes.length > 1}
                    <button
                      type="button"
                      class="px-1 hover:text-foreground"
                      aria-label="Remove mode {mode.name}"
                      onclick={() => run(() => store.removeMode(c.id, mode.id))}>×</button
                    >
                  {/if}
                </div>
              </th>
            {/each}
            <th class="px-1 py-1">
              <form
                class="flex items-center gap-1"
                onsubmit={(e) => {
                  e.preventDefault();
                  run(() => {
                    store.addMode(c.id, newMode);
                    newMode = '';
                  });
                }}
              >
                <input class={input} placeholder="Mode" aria-label="New mode name" bind:value={newMode} />
                <button type="submit" class={button} disabled={!newMode.trim()} aria-label="Add mode">+</button>
              </form>
            </th>
          </tr>
        </thead>
        <tbody>
          {#each variables as variable (variable.id)}
            <tr class="border-b border-border/50" data-token-row={variable.id}>
              <td class="px-1 py-1">
                <div class="flex items-center gap-1">
                  <span class="w-4 text-center text-muted-foreground" title={variable.type}>{typeIcon(variable.type)}</span>
                  <input
                    class={input}
                    value={variable.name}
                    aria-label="Variable {variable.name} name"
                    {...committer(variable.name, (name) => store.renameVariable(variable.id, name))}
                  />
                </div>
              </td>
              {#each c.modes as mode (mode.id)}
                {@const value = variable.valuesByMode[mode.id]}
                {@const alias = isTokenAlias(value) ? value.alias : ''}
                {@const resolved = resolveTokenInMode(tokenState, variable.id, mode.id)}
                <td class="px-1 py-1 align-middle" data-variable-id={variable.id} data-mode-id={mode.id}>
                  <div class="flex items-center gap-1">
                    {#if alias}
                      <span class="flex min-w-0 flex-1 items-center gap-1 text-xs" data-token-alias={alias}>
                        {#if variable.type === 'color' && resolved !== undefined}<TokenSwatch color={String(resolved)} />{/if}
                        <span class="truncate">→ {getTokenVariable(tokenState, alias)?.name ?? alias}</span>
                      </span>
                    {:else}
                      <span class="min-w-0 flex-1">
                        {#if variable.type === 'color'}
                          <span class="flex items-center gap-1">
                            <label class="relative">
                              <TokenSwatch color={String(value)} />
                              <input
                                type="color"
                                aria-label="{variable.name} colour"
                                class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                                value={String(value).slice(0, 7)}
                                onchange={(e) => run(() => store.setValue(variable.id, e.currentTarget.value + String(value).slice(7), mode.id))}
                              />
                            </label>
                            <input
                              class={input}
                              value={String(value)}
                              aria-label="{variable.name} value"
                              {...committer(String(value), (next) => store.setValue(variable.id, next, mode.id))}
                            />
                          </span>
                        {:else if variable.type === 'boolean'}
                          <input
                            type="checkbox"
                            aria-label="{variable.name} value"
                            checked={value === true}
                            onchange={(e) => run(() => store.setValue(variable.id, e.currentTarget.checked, mode.id))}
                          />
                        {:else}
                          <input
                            class={input}
                            value={String(value)}
                            inputmode={variable.type === 'number' ? 'decimal' : undefined}
                            aria-label="{variable.name} value"
                            {...committer(String(value), (next) => store.setValue(variable.id, next, mode.id))}
                          />
                        {/if}
                      </span>
                    {/if}
                    <select
                      aria-label="{variable.name} alias in {mode.name}"
                      class="w-5 shrink-0 rounded border border-border bg-background text-xs"
                      title="Alias"
                      value={alias}
                      onchange={(e) => setAlias(variable, mode, e.currentTarget.value)}
                    >
                      <option value="">Value</option>
                      {#each aliasCandidates(variable) as candidate (candidate.id)}
                        <option value={candidate.id}>→ {candidate.name}</option>
                      {/each}
                    </select>
                  </div>
                </td>
              {/each}
              <td class="px-1 py-1 text-right">
                <button
                  type="button"
                  class="px-1 text-muted-foreground hover:text-foreground"
                  aria-label="Delete variable {variable.name}"
                  onclick={() => run(() => store.deleteVariables(variable.id))}>×</button
                >
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <form
      class="flex items-center gap-1"
      onsubmit={(e) => {
        e.preventDefault();
        run(() => {
          store.createVariable({ collectionId: c.id, name: newName, type: newType });
          newName = '';
        });
      }}
    >
      <input class={input} placeholder="color/bg" aria-label="New variable name" bind:value={newName} />
      <select aria-label="New variable type" class="rounded border border-border bg-background px-1 py-0.5 text-xs" bind:value={newType}>
        {#each TOKEN_TYPES as t (t)}
          <option value={t}>{t}</option>
        {/each}
      </select>
      <button type="submit" class={button} disabled={!newName.trim()}>Add variable</button>
    </form>
  {:else}
    <p class="text-muted-foreground">No collections yet.</p>
  {/if}
</div>
