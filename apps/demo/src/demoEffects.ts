import { useSyncExternalStore } from "react";
import { createFakeEffectProvider, type EffectProvider } from "@pixerate/editor/effects";

/**
 * The demo's effects provider, shared by every tab with effects wired (Video, Image, Vector,
 * Animation, Canvas and Paint). Switching it changes which library new effects come from; effects
 * saved from the other library are kept and say why they are not drawn. The library ships no effects of its own: the
 * built-in test effects are its deterministic fake provider, and Flair (`@pixerate/flair`'s
 * `flairEffects()`, a devDependency of the demo only) is loaded on demand when picked and plugs
 * in through the same `useEffects` hooks.
 */
export type DemoEffectsSource = "test" | "flair";

export interface DemoEffectsOption {
  id: DemoEffectsSource;
  label: string;
  /** Why the option cannot be picked yet, if it cannot. */
  unavailable?: string;
  /** A short note shown while it is selected. */
  note?: string;
}

export const DEMO_EFFECTS_OPTIONS: readonly DemoEffectsOption[] = [
  { id: "test", label: "Built-in test effects" },
  { id: "flair", label: "Flair", note: "Flair's catalog (@pixerate/flair), loaded on demand: shaders render on the GPU." },
];

const KEY = "pixerate-demo-effects";
let source: DemoEffectsSource = "test";
try {
  const saved = localStorage.getItem(KEY);
  if (saved && DEMO_EFFECTS_OPTIONS.some((o) => o.id === saved && !o.unavailable)) source = saved as DemoEffectsSource;
} catch {
  // Storage is optional (private windows, tests).
}
const test = createFakeEffectProvider();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Flair, once loaded; `null` while it loads; the error if it failed. */
let flair: EffectProvider | null = null;
let flairError: string | null = null;
let flairLoading: Promise<void> | null = null;

/** Loads `@pixerate/flair/integrations` on first use (its own chunk, kept out of the demo's main bundle). */
function loadFlair(): Promise<void> {
  flairLoading ??= import("@pixerate/flair/integrations").then(
    (m) => {
      flair = m.flairEffects();
      notify();
    },
    (e: unknown) => {
      flairError = `Flair failed to load: ${e instanceof Error ? e.message : String(e)}`;
      flairLoading = null;
      notify();
    },
  );
  return flairLoading;
}

function providerFor(s: DemoEffectsSource): EffectProvider | null {
  return s === "test" ? test : flair;
}

export function setDemoEffectsSource(next: DemoEffectsSource): void {
  if (DEMO_EFFECTS_OPTIONS.find((o) => o.id === next)?.unavailable || next === source) return;
  source = next;
  flairError = null;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // ignore
  }
  if (next === "flair") void loadFlair();
  notify();
}
if (source === "flair") void loadFlair();

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The selected source and its provider (`null` while Flair loads); re-renders when either changes. */
export function useDemoEffects(): { source: DemoEffectsSource; provider: EffectProvider | null; loading: boolean; error: string | null } {
  const snapshot = () => `${source}|${flair ? 1 : 0}|${flairError ?? ""}`;
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return { source, provider: providerFor(source), loading: source === "flair" && !flair && !flairError, error: flairError };
}

/** Waits for the selected provider (tests and scripts). */
export async function demoEffectsReady(): Promise<EffectProvider | null> {
  if (source === "flair") await loadFlair();
  return providerFor(source);
}
