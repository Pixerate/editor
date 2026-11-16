/**
 * The shapes the eval passes around: tasks, the tool-using conversation with a model, and what
 * each grader found.
 */

/** Where a brush will paint: the brush library's host profiles. */
export type BrushHost = "paint" | "image" | "canvas" | "vector";

export const BRUSH_HOSTS: readonly BrushHost[] = ["paint", "image", "canvas", "vector"];

/**
 * What kind of brush a task asks for: a paint family (what the paint does, as `describe_brush`
 * reports it) or `tool` for brushes that work on paint already down (smudge, blender, eraser…).
 */
export type BrushType =
  | "dry"
  | "ink"
  | "wet"
  | "thick"
  | "metallic"
  | "spray"
  | "glow"
  | "iridescent"
  | "strands"
  | "stickers"
  | "living"
  | "ethereal"
  | "volatile"
  | "reactive"
  | "tool";

export const BRUSH_TYPES: readonly BrushType[] = ["dry", "ink", "wet", "thick", "metallic", "spray", "glow", "iridescent", "strands", "stickers", "living", "ethereal", "volatile", "reactive", "tool"];

/** `scratch`: drafted from words alone. `reference`: drafted to paint like reference strokes of a held-out preset. */
export type TaskMode = "scratch" | "reference";

/** One check on the saved brush: a partial match against `describe_brush`'s result (the skill evals' matcher: `$min`, `$max`, `$expr`…). */
export interface FacetCheck {
  /** What it checks, in words: shown in reports. */
  why: string;
  expect: Record<string, unknown>;
}

/** A tool call: in a known-good solution, or made by a model. */
export interface ToolCallSpec {
  tool: string;
  args?: Record<string, unknown>;
}

export interface EvalTask {
  /** Unique, kebab-case. */
  id: string;
  type: BrushType;
  mode: TaskMode;
  host: BrushHost;
  /** The id the model must save its brush under. */
  brushId: string;
  /** What to make, in a person's words. For reference tasks, extra words beside the strokes (may be empty). */
  brief: string;
  /** Reference tasks: the built-in preset held out of the library and shown only as strokes. */
  reference?: { preset: string };
  /** Checks on the saved brush, beyond the type and host (which every task checks). */
  checks?: readonly FacetCheck[];
  /** Scratch tasks: a known-good answer, which the oracle replays and the tests prove against `checks`. */
  solution?: readonly ToolCallSpec[];
}

/** One part of a message. */
export type Part =
  | { type: "text"; text: string }
  | { type: "image"; png: Buffer; label?: string }
  /** A tool call the model made. `meta` is opaque to the harness and given back to the adapter that made it (Gemini's thought signatures). */
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown>; meta?: unknown }
  /** What a tool returned: text and images, and whether it failed. */
  | { type: "tool_result"; id: string; name: string; content: readonly ({ type: "text"; text: string } | { type: "image"; png: Buffer })[]; isError?: boolean };

export interface ModelMessage {
  role: "user" | "assistant";
  content: readonly Part[];
}

/** A tool as offered to a model: MCP's shape. */
export interface ModelTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: readonly ModelMessage[];
  /** Tools the model may call; without them it answers in text. */
  tools?: readonly ModelTool[];
  /** A JSON Schema the text answer must follow (adapters that cannot enforce it ask for it in words). */
  schema?: Record<string, unknown>;
  /** Names the request for replay: `<task>/<sample>/<turn>` or `judge/<task>/<sample>`. */
  key: string;
}

export interface ModelResponse {
  /** Text the model wrote (may be empty when it only called tools). */
  text: string;
  toolCalls?: { id: string; name: string; input: Record<string, unknown>; meta?: unknown }[];
  usage?: { input: number; output: number };
  /** Why it stopped, when the provider says (`end_turn`, `tool_use`, `max_tokens`, `refusal`…). */
  stop?: string;
}

export interface Model {
  /** The spec it was made from, for reports: `anthropic:claude-opus-5-5`. */
  name: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
}

/** One graded check. */
export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface JudgeScores {
  /** 1–5 each. */
  fidelity: number;
  medium: number;
  craft: number;
  settings: number;
  notes: string;
}

/** Everything about one sample of one task. */
export interface SampleResult {
  task: string;
  type: BrushType;
  host: BrushHost;
  mode: TaskMode;
  sample: number;
  model: string;
  /** Model turns taken. */
  turns: number;
  /** Tool calls made, and how many failed. */
  toolCalls: number;
  toolErrors: number;
  /** Tools by how often the model called them. */
  tools: Record<string, number>;
  /** The brush was saved and no write was refused on the way. */
  firstTry: boolean;
  checks: Check[];
  /** 0–1 per area; absent when it could not be measured. */
  scores: { validity?: number; requirements?: number; render?: number; similarity?: number; judge?: number };
  /** 0–100. */
  overall: number;
  judge?: JudgeScores;
  /** Reference tasks: the stroke metrics behind `similarity`. */
  similarity?: { coverage: number; colour: number; structure: number };
  usage: { input: number; output: number };
  ms: { generate: number; tools: number };
  error?: string;
  /** Folder holding the brush, its strokes and the transcript. */
  dir: string;
}

/** A model failure no other sample would get past (missing credentials, a model that does not exist): the run stops. */
export class FatalModelError extends Error {
  override name = "FatalModelError";
}

/**
 * A `command:` model prints this line, then a JSON object `{ text, toolCalls?, usage?, stop? }`.
 * Without it, everything it prints is the answer's text (and it called no tools). Exiting with
 * code 3 means no other request would succeed either (a bad key, an unknown model): the run stops.
 */
export const RESPONSE_MARKER = "#pixerate-eval-response";
export const FATAL_EXIT_CODE = 3;
