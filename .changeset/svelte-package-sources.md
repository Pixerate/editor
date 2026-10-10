---
"@pixerate/editor-svelte": minor
---

Ship Svelte components as sources built with `@sveltejs/package`, replacing the precompiled `tsup` + `esbuild-svelte` bundle.

- **SSR works**: components are compiled by your bundler for both client and server. Previously the package shipped client-only output, so SvelteKit SSR threw `document is not defined`.
- **Component styles are included**: scoped `<style>` blocks (editor placeholder, spreadsheet column-resize handle) were previously emitted to an unexported `dist/index.css` and silently lost.
- **Accurate generated types**: `.d.ts` files are generated from the source instead of hand-written. This fixes unresolved `ImageOptions` / `HistoryManager` / `ReactiveImageEditor` types and adds missing declarations, including `AgentPresenceLayer`, `createStreamingCanvas`, `ensureLayout`, `placeBeside`, `ManualClock`, `DockStrategy`, the `ImageEditor` AI hook props and the `BubbleMenu` `shouldShow` / `tippyOptions` / `updateDelay` / `pluginKey` props.
- **No longer coupled to Svelte internals**: the compiled output depended on private `svelte/internal/client` APIs from the exact Svelte version used to build it.
- **Breaking:** the `svelte` peer dependency is now `^5.0.0`. The previous `^4.0.0 || ^5.0.0` range was inaccurate, since every component uses runes.
