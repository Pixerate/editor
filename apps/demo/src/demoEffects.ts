import { useSyncExternalStore } from "react";
import { createFakeEffectProvider, type EffectProvider } from "@pixerate/editor/effects";

/**
 * The demo's effects provider, shared by every tab with effects wired (Video, Image, Vector and
 * Animation; Canvas and Paint as they gain effects). The library ships no effects of its own: the
 * built-in test effects are its deterministic fake provider, and Flair (`@pixerate/flair`'s
 * `flairEffects()`) plugs in through the same `useEffects` hooks once it is published.
 */
export type DemoEffectsSource = "test" | "flair";

export interface DemoEffectsOption {
  id: DemoEffectsSource;
  label: string;
  /** Why the option cannot be picked yet, if it cannot. */
  unavailable?: string;
}

export const DEMO_EFFECTS_OPTIONS: readonly DemoEffectsOption[] = [
  { id: "test", label: "Built-in test effects" },
  { id: "flair", label: "Flair", unavailable: "Coming once @pixerate/flair publishes flairEffects()." },
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

/** The provider for a source (only the built-in test effects for now). */
function providerFor(s: DemoEffectsSource): EffectProvider | null {
  return s === "test" ? test : null;
}

export function setDemoEffectsSource(next: DemoEffectsSource): void {
  if (DEMO_EFFECTS_OPTIONS.find((o) => o.id === next)?.unavailable || next === source) return;
  source = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // ignore
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The selected source and its provider (re-renders when the switch changes). */
export function useDemoEffects(): { source: DemoEffectsSource; provider: EffectProvider | null } {
  const s = useSyncExternalStore(subscribe, () => source, () => source);
  return { source: s, provider: providerFor(s) };
}
