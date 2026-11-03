import { expect } from "vitest";
import { ToolRegistry } from "@pixerate/editor/tools";
import { createFakeEffectProvider } from "@pixerate/editor/effects";
import { createPaintEditorToolProvider, createPaintEffectsToolProvider, PaintEditorController } from "@pixerate/editor/paint-editor";
import { combineStickerProviders, createFakeStickerProvider, editorStickers } from "@pixerate/editor/stickers";
import { runAgentScript } from "./agentScript";
import { PAINT_SCRIPTS } from "./agentScripts";

// The Paint tab's scripts, replayed against the tab's canvas through the real tools. The tests
// are split over several `paintScripts*.test.ts` files so CI's shards can run them in parallel:
// together they take about a minute.

/** Scripts with a test of their own that checks what they painted. `paintScripts.test.ts` runs the rest. */
export const CHECKED = [
  "paint-blend-glaze",
  "paint-watercolor",
  "paint-impasto",
  "paint-gradient",
  "paint-procedural",
  "paint-stroke-layer",
  "paint-live-effect",
  "paint-light",
  "paint-glow-wash",
  "paint-light-ribbons",
  "paint-neon-glow-style",
  "paint-library-stickers",
  "paint-stained-glass",
];

// Flair renders on a GPU canvas, which Node does not have: its script is left to the browser.
export const NODE_SCRIPTS = PAINT_SCRIPTS.filter((s) => !s.id.endsWith("-flair"));

function setup() {
  const controller = new PaintEditorController({ width: 1200, height: 800, paper: "cold-pressed", stickers: combineStickerProviders([editorStickers(), createFakeStickerProvider()]) });
  // The tab's effects provider: the built-in test effects (Flair needs a page to render; its script is checked in the browser).
  controller.setEffectsProvider(createFakeEffectProvider());
  const registry = new ToolRegistry();
  registry.register(createPaintEditorToolProvider(controller, { id: "paint", namespace: "paint" }));
  registry.register(createPaintEffectsToolProvider(controller, { id: "paint-effects", namespace: "paintfx" }));
  return { controller, registry };
}

/** Runs a script to the end, failing on any tool error, and returns the editor it painted in. */
export async function runPaintScript(id: string) {
  const script = PAINT_SCRIPTS.find((s) => s.id === id);
  if (!script) throw new Error(`No paint script "${id}"`);
  const { controller, registry } = setup();
  const errors: string[] = [];
  const { ok } = await runAgentScript(registry, script, { control: { speed: Infinity, stopped: false }, onEvent: (e) => e.type === "error" && errors.push(e.message) });
  expect(errors).toEqual([]);
  expect(ok).toBe(true);
  return controller;
}
