import { Node } from "@tiptap/core";
import { safeMergeAttributes } from "../safe-merge-attributes";
import type { Node as ProsemirrorNode } from "@tiptap/pm/model";
import { layoutSparkline, type ChartSparklineKind } from "../../chart/sparkline";
import { chartSceneToDomSpec } from "../../chart/svg";
import type { ChartValue } from "../../chart/types";

export const SPARKLINE_KINDS: readonly ChartSparklineKind[] = ["line", "column", "win-loss"];
/** Most values a sparkline node keeps. */
export const MAX_SPARKLINE_VALUES = 1000;

export interface SparklineNodeOptions {
  HTMLAttributes: Record<string, any>;
  /** Line, positive column and win colour (default the first palette colour). */
  color: string;
  /** Negative column and loss colour. */
  negativeColor: string;
}

export interface InsertSparklineOptions {
  values: readonly (number | null)[];
  kind?: ChartSparklineKind;
  /** Width in pixels (default 80). */
  width?: number;
  /** Height in pixels (default 18). */
  height?: number;
  /** CSS colour (default: the extension's `color`). */
  color?: string | null;
  /** Accessible label (default: first and last value). */
  label?: string | null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    sparkline: {
      /** Inserts a word-sized chart at the selection. */
      insertSparkline: (options: InsertSparklineOptions) => ReturnType;
    };
  }
}

/** Cleans sparkline values: finite numbers or null, at most `MAX_SPARKLINE_VALUES`. */
export function normalizeSparklineValues(values: unknown): ChartValue[] {
  if (!Array.isArray(values)) return [];
  return values
    .slice(0, MAX_SPARKLINE_VALUES)
    .map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
}

function readValues(text: string | null): ChartValue[] {
  if (!text) return [];
  try {
    return normalizeSparklineValues(JSON.parse(text));
  } catch {
    return normalizeSparklineValues(text.split(/[\s,]+/).filter(Boolean).map(Number));
  }
}

const readNumber = (text: string | null, fallback: number, max: number) => {
  const n = text === null ? NaN : Number(text);
  return Number.isFinite(n) && n >= 4 && n <= max ? n : fallback;
};

/** The accessible label of a sparkline node. */
export function sparklineLabel(node: ProsemirrorNode): string {
  if (node.attrs.label) return node.attrs.label;
  const present = (node.attrs.values as ChartValue[]).filter((v): v is number => v !== null);
  return present.length ? `Trend from ${present[0]} to ${present[present.length - 1]}` : "No data";
}

/**
 * An inline, word-sized chart (`line`, `column` or `win-loss`) drawn as SVG in the text.
 * HTML: `<span data-type="sparkline" data-values="[…]" data-kind="line">`; markdown keeps the
 * same span (the markdown sanitizer allows `span` with `data-*` attributes).
 */
export const Sparkline = Node.create<SparklineNodeOptions>({
  name: "sparkline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { HTMLAttributes: {}, color: "#4269d0", negativeColor: "#e5484d" };
  },

  addAttributes() {
    return {
      values: {
        default: [],
        parseHTML: (element: HTMLElement) => readValues(element.getAttribute("data-values")),
        renderHTML: (attributes: Record<string, any>) => ({ "data-values": JSON.stringify(attributes.values ?? []) }),
      },
      kind: {
        default: "line",
        parseHTML: (element: HTMLElement) => {
          const kind = element.getAttribute("data-kind") as ChartSparklineKind;
          return SPARKLINE_KINDS.includes(kind) ? kind : "line";
        },
        renderHTML: (attributes: Record<string, any>) => ({ "data-kind": attributes.kind }),
      },
      width: {
        default: 80,
        parseHTML: (element: HTMLElement) => readNumber(element.getAttribute("data-width"), 80, 1000),
        renderHTML: (attributes: Record<string, any>) => ({ "data-width": String(attributes.width) }),
      },
      height: {
        default: 18,
        parseHTML: (element: HTMLElement) => readNumber(element.getAttribute("data-height"), 18, 200),
        renderHTML: (attributes: Record<string, any>) => ({ "data-height": String(attributes.height) }),
      },
      color: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-color") || null,
        renderHTML: (attributes: Record<string, any>) => (attributes.color ? { "data-color": attributes.color } : {}),
      },
      label: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-label") || null,
        renderHTML: (attributes: Record<string, any>) => (attributes.label ? { "data-label": attributes.label } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="sparkline"]', priority: 60 }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const scene = layoutSparkline(node.attrs.values, {
      kind: node.attrs.kind,
      width: node.attrs.width,
      height: node.attrs.height,
      color: node.attrs.color ?? this.options.color,
      negativeColor: this.options.negativeColor,
    });
    const svg = chartSceneToDomSpec(scene, {
      ariaLabel: sparklineLabel(node),
      attrs: { style: "display: inline-block; vertical-align: middle" },
    });
    return [
      "span",
      safeMergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        "data-type": "sparkline",
        class: "pixerate-sparkline",
      }),
      svg as any,
    ];
  },

  renderText({ node }) {
    return `[${sparklineLabel(node)}]`;
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: ProsemirrorNode) {
          const attr = (name: string, value: unknown) =>
            value === null || value === undefined
              ? ""
              : ` ${name}="${String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`;
          state.write(
            `<span data-type="sparkline"${attr("data-values", JSON.stringify(node.attrs.values))}${attr("data-kind", node.attrs.kind)}${attr("data-width", node.attrs.width)}${attr("data-height", node.attrs.height)}${attr("data-color", node.attrs.color)}${attr("data-label", node.attrs.label)}></span>`,
          );
        },
        parse: {},
      },
    };
  },

  addCommands() {
    return {
      insertSparkline:
        (options) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              values: normalizeSparklineValues(options.values),
              kind: options.kind && SPARKLINE_KINDS.includes(options.kind) ? options.kind : "line",
              width: options.width ?? 80,
              height: options.height ?? 18,
              color: options.color ?? null,
              label: options.label ?? null,
            },
          }),
    };
  },
});
