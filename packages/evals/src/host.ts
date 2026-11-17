import { BRUSH_HOST_PROFILES, BRUSH_PRESETS, brushPreviewColours, createBrushLibrary, createBrushLibraryToolProvider, type BrushLibrary } from "@pixerate/editor/brushes";
import { renderCanvasBrushPreview } from "@pixerate/editor/canvas";
import { paintBrushPreviewRenderer } from "@pixerate/editor/paint-editor";
import { ToolRegistry } from "@pixerate/editor/tools";
import { renderVectorBrushPreview } from "@pixerate/editor/vector";
import type { BrushHost, ModelTool } from "./types.ts";

/**
 * Tools the model is not offered: they bring in files (a library, a brush pack, a PNG) that no
 * task gives it.
 */
export const WITHHELD_TOOLS: readonly string[] = ["import_brushes", "import_brush_pack", "add_brush_source"];

/** What a sample works in: a fresh brush library for one host, its tools, and how to call them. */
export interface BrushSession {
  host: BrushHost;
  library: BrushLibrary;
  registry: ToolRegistry;
  /** The tools as the model sees them (bare names, without the provider's namespace). */
  tools: ModelTool[];
  call(name: string, args?: Record<string, unknown>): ReturnType<ToolRegistry["callTool"]>;
}

const bare = (name: string) => name.replace(/^[a-z]+__/, "");

/**
 * A brush library for `host` with every built-in preset except `holdOut` (a reference task's
 * preset, so the model can neither find it nor base on it), and the brush tools for that host's
 * profile, with `preview_brush` drawn by the host's renderer: the paint engine for the paint and
 * image editors, a canvas stroke for canvas strokes, a vector brushstroke for vector strokes.
 */
export function createBrushSession(host: BrushHost, holdOut?: string): BrushSession {
  const profile = BRUSH_HOST_PROFILES[host];
  if (!profile) throw new Error(`Unknown host "${host}"; use one of ${Object.keys(BRUSH_HOST_PROFILES).join(", ")}.`);
  if (holdOut && !BRUSH_PRESETS.some((b) => b.id === holdOut)) throw new Error(`There is no built-in brush "${holdOut}" to hold out.`);
  const library = createBrushLibrary({ presets: BRUSH_PRESETS.filter((b) => b.id !== holdOut) });
  const renderPreview = host === "canvas" ? renderCanvasBrushPreview : host === "vector" ? renderVectorBrushPreview : paintBrushPreviewRenderer();
  const registry = new ToolRegistry();
  registry.register(createBrushLibraryToolProvider(library, { profile, renderPreview }));
  const tools = registry
    .listTools()
    .tools.filter((t) => !WITHHELD_TOOLS.includes(bare(t.name)))
    .map((t) => ({ name: bare(t.name), description: t.description ?? t.title ?? bare(t.name), inputSchema: t.inputSchema as Record<string, unknown> }));
  return { host, library, registry, tools, call: (name, args = {}) => registry.callTool(name, args) };
}

/** Whether a brush has a default colour of its own (otherwise its preview is drawn in a fallback for its medium). */
export function hasOwnColour(brush: { kind?: string; colour?: { default?: unknown } }): boolean {
  return brush.kind === "mark" && brush.colour?.default !== undefined;
}

/** The size strokes are drawn at for grading, the judge and references. */
export const SHEET = { width: 512, height: 160 } as const;

/**
 * Draws `id`'s sample stroke with the session's `preview_brush`, in the colour it picks (the
 * brush's own, a light / dark pair resolved for the paper, as `brushPreviewColours` does), so the
 * graded stroke is the one the model saw. Should the host's renderer refuse a brush, the paint
 * engine draws it instead and `fallback` says why: the grade should not punish the model for the
 * renderer.
 */
export async function strokePng(session: BrushSession, id: string): Promise<{ png: Buffer; colour?: string; fallback?: string }> {
  const r = await session.call("preview_brush", { id, ...SHEET });
  if (!r.isError) {
    const image = r.content.find((c) => c.type === "image") as { data: string } | undefined;
    if (!image) throw new Error(`preview_brush ${id} returned no image.`);
    const colour = (r.structuredContent as { color?: unknown } | undefined)?.color;
    return { png: Buffer.from(image.data, "base64"), ...(typeof colour === "string" && { colour }) };
  }
  const why = (r.content[0] as { text?: string })?.text ?? "failed";
  const entry = await session.library.get(id);
  if (!entry) throw new Error(`preview_brush ${id}: ${why}`);
  const render = paintBrushPreviewRenderer();
  const colour = brushPreviewColours(entry.brush, { paper: render.paper }).color;
  const image = await render(entry.brush, { ...SHEET, color: colour });
  return { png: Buffer.from(image.data, "base64"), colour, fallback: why };
}
