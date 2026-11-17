import { BRUSH_HOST_PROFILES, BRUSH_PRESETS, brushPreviewsOnDark, createBrushLibrary, createBrushLibraryToolProvider, type Brush, type BrushLibrary } from "@pixerate/editor/brushes";
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

/** The size strokes are drawn at for grading, the judge and references. */
export const SHEET = { width: 512, height: 160 } as const;

/**
 * The colour a brush's sample stroke is drawn in: its own default, with a light / dark pair
 * resolved for what the preview is drawn on (the dark side for light brushes, which preview on dark
 * paper), as the brush UI does; else the tool's default. `preview_brush` itself only takes a plain
 * hex default and draws a pair in its fallback colour, which would grade a rust-red pair as slate.
 */
export function strokeColour(brush: Brush): string | undefined {
  const own = brush.kind === "mark" ? brush.colour?.default : undefined;
  const hex = (v: unknown) => (typeof v === "string" && /^#[0-9a-f]{6}/i.test(v) ? v.slice(0, 7) : undefined);
  if (typeof own === "string") return hex(own);
  if (own && typeof own === "object" && "light" in own && "dark" in own) return hex(brushPreviewsOnDark(brush) ? own.dark : own.light);
  return undefined;
}

/**
 * Draws `id`'s sample stroke in its own colour (see {@link strokeColour}) with the session's
 * renderer, as PNG bytes. Should the host's renderer refuse a brush, the paint engine draws it
 * instead and `fallback` says why: the grade should not punish the model for the renderer.
 */
export async function strokePng(session: BrushSession, id: string): Promise<{ png: Buffer; fallback?: string }> {
  const entry = await session.library.get(id);
  const colour = entry ? strokeColour(entry.brush) : undefined;
  const r = await session.call("preview_brush", { id, ...SHEET, ...(colour && { color: colour }) });
  if (!r.isError) {
    const image = r.content.find((c) => c.type === "image") as { data: string } | undefined;
    if (!image) throw new Error(`preview_brush ${id} returned no image.`);
    return { png: Buffer.from(image.data, "base64") };
  }
  const why = (r.content[0] as { text?: string })?.text ?? "failed";
  if (!entry) throw new Error(`preview_brush ${id}: ${why}`);
  const image = await paintBrushPreviewRenderer()(entry.brush, { ...SHEET, color: colour ?? "#1f2937" });
  return { png: Buffer.from(image.data, "base64"), fallback: why };
}
