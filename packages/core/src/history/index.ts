export * from "./types";
export * from "./HistoryManager";
// Dirty tracking is re-exported here so `@pixerate/editor/history` consumers
// (e.g. the Svelte history runes) can bind it without importing the root entry.
export {
  DirtyTracker,
  createDirtyTracker,
  defaultIsEqual,
  withoutDirty,
  bindDirtyToHistory,
} from "../dirty";
export type {
  DirtyTrackerOptions,
  DirtyHistorySource,
  BindDirtyToHistoryOptions,
  HistoryDirtyBinding,
} from "../dirty";
