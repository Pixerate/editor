// The part of Vite's `import.meta.glob` the demo uses (the demo doesn't load `vite/client` types).
interface ImportMeta {
  glob<T = unknown>(pattern: string | string[], options?: { query?: string; import?: string; eager?: boolean }): Record<string, T>;
}
