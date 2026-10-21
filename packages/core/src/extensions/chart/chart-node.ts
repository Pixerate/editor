import { Node, type Editor } from "@tiptap/core";
import { safeMergeAttributes } from "../safe-merge-attributes";
import type { Node as ProsemirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { chartFromMermaid, chartToMermaid } from "../../chart/mermaid";
import { DEFAULT_CHART_THEME, normalizeChartSpec } from "../../chart/spec";
import { chartSceneToDomSpec, type ChartDomSpec } from "../../chart/svg";
import { layoutChart } from "../../chart/layout";
import { describeChart } from "../../chart/summary";
import type { ChartSpec, ChartTheme } from "../../chart/types";
import {
  generateStructureId,
  STRUCTURE_PRIORITY,
  syncInitialContent,
  transactionsInsert,
} from "../document-structure/utils";
import { createChartNodeView, type ChartNodeViewMount } from "./node-view";

export interface ChartNodeOptions {
  HTMLAttributes: Record<string, any>;
  /**
   * Draws the chart inside the editor with a framework component (the React and Svelte
   * packages export one). Without it the editor shows the static SVG from `renderHTML`.
   */
  nodeView: ChartNodeViewMount | null;
  /** Colours of the static SVG in exported HTML (default `DEFAULT_CHART_THEME`). */
  theme: Partial<ChartTheme>;
  /** Width of the static SVG when the node has no `width` (default 640). */
  defaultWidth: number;
  /** Height of new charts in pixels (default 320). */
  defaultHeight: number;
  /** Generates ids for charts that have none (default `chart-xxxxxxxx`). */
  generateId: () => string;
}

export interface InsertChartOptions {
  /** Any partial or saved chart spec; it is normalized (see `normalizeChartSpec`). */
  spec: Partial<ChartSpec> | unknown;
  /** Width in pixels, or null to fill the line (default null). */
  width?: number | null;
  /** Height in pixels (default `defaultHeight`). */
  height?: number;
  /** Id to use (default: generated). */
  id?: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    chart: {
      /** Inserts a chart block at the selection. */
      insertChart: (options: InsertChartOptions) => ReturnType;
      /** Replaces the spec (and optionally the size) of the chart with this id. */
      updateChart: (
        id: string,
        changes: { spec?: Partial<ChartSpec> | unknown; width?: number | null; height?: number },
      ) => ReturnType;
    };
  }
}

export const chartPluginKey = new PluginKey("chartNode");

/** A chart in a document: its node, id and position. */
export interface DocumentChart {
  id: string | null;
  pos: number;
  node: ProsemirrorNode;
  spec: ChartSpec;
}

/** Every chart node in a document, in order. */
export function getDocumentCharts(doc: ProsemirrorNode, typeName = "chart"): DocumentChart[] {
  const charts: DocumentChart[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === typeName) {
      charts.push({ id: node.attrs.id ?? null, pos, node, spec: node.attrs.spec });
      return false;
    }
    return !node.isTextblock;
  });
  return charts;
}

/** Whether the editor's schema has the chart node (`createRichTextPreset({ chart: true })`). */
export function isChartEnabled(editor: Pick<Editor, "schema"> | null | undefined): boolean {
  return !!editor?.schema?.nodes?.chart;
}

/** Reads a chart spec from JSON text (or an object), or `null` when it is not a chart. */
function readSpec(value: unknown): ChartSpec | null {
  let input = value;
  if (typeof value === "string") {
    try {
      input = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return normalizeChartSpec(input).spec;
}

const readSize = (value: string | null): number | null => {
  const n = value === null ? NaN : Number(value);
  return Number.isFinite(n) && n >= 50 && n <= 4096 ? n : null;
};

/** Gives charts without an id, or with a duplicate one (after a copy), a fresh id. */
function syncChartIds(state: EditorState, typeName: string, generateId: () => string): Transaction | null {
  const seen = new Set<string>();
  let tr: Transaction | null = null;
  for (const chart of getDocumentCharts(state.doc, typeName)) {
    if (chart.id && !seen.has(chart.id)) {
      seen.add(chart.id);
      continue;
    }
    let id = generateId();
    while (seen.has(id)) id = generateId();
    seen.add(id);
    tr = tr ?? state.tr;
    tr.setNodeMarkup(chart.pos, undefined, { ...chart.node.attrs, id });
  }
  return tr?.setMeta("addToHistory", false) ?? null;
}

/** The static SVG of a chart node, as a `DOMOutputSpec`. */
export function staticChartSvg(
  node: ProsemirrorNode,
  options: Pick<ChartNodeOptions, "theme" | "defaultWidth" | "defaultHeight">,
): ChartDomSpec {
  const spec: ChartSpec = node.attrs.spec;
  const width = node.attrs.width ?? options.defaultWidth;
  const height = node.attrs.height ?? options.defaultHeight;
  const scene = layoutChart(spec, { width, height, theme: options.theme, selection: null });
  return chartSceneToDomSpec(scene, {
    ariaLabel: spec.title || "Chart",
    description: describeChart(spec),
    attrs: { style: "max-width: 100%; height: auto; display: block" },
  });
}

/** The longest run of backticks in `text`, so a fence can be one longer. */
const longestBacktickRun = (text: string) =>
  Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));

/**
 * A chart block. Stores a `ChartSpec` as its `spec` attribute (JSON in `data-chart`) with
 * an id, an optional width and a height.
 *
 * - **HTML**: `<div data-type="chart" data-chart="{…}">` holding a static SVG drawn with
 *   `chartSceneToDomSpec`, so exported HTML shows the chart without script.
 * - **Markdown**: a ` ```mermaid ` block written with `chartToMermaid` (its `%% @pixerate`
 *   line keeps everything Mermaid cannot hold); `xychart-beta`, `pie` and `radar-beta`
 *   blocks parse back into charts. Other Mermaid diagrams stay code blocks.
 * - **In the editor**: pass a `nodeView` (React and Svelte export one) for a live chart that
 *   opens the chart inspector on click; without one the static SVG is shown.
 */
export const Chart = Node.create<ChartNodeOptions>({
  name: "chart",
  priority: STRUCTURE_PRIORITY,
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return {
      HTMLAttributes: {},
      nodeView: null,
      theme: DEFAULT_CHART_THEME,
      defaultWidth: 640,
      defaultHeight: 320,
      generateId: () => generateStructureId("chart"),
    };
  },

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-chart-id") || null,
        renderHTML: (attributes: Record<string, any>) =>
          attributes.id ? { "data-chart-id": attributes.id } : {},
      },
      spec: {
        default: normalizeChartSpec({}).spec,
        // null (no `data-chart`) keeps what the parse rule found, e.g. a mermaid block's spec.
        parseHTML: (element: HTMLElement) => readSpec(element.getAttribute("data-chart")),
        renderHTML: (attributes: Record<string, any>) => ({
          "data-chart": JSON.stringify(attributes.spec),
        }),
      },
      width: {
        default: null,
        parseHTML: (element: HTMLElement) => readSize(element.getAttribute("data-width")),
        renderHTML: (attributes: Record<string, any>) =>
          attributes.width ? { "data-width": String(attributes.width) } : {},
      },
      height: {
        default: this.options.defaultHeight,
        parseHTML: (element: HTMLElement) => readSize(element.getAttribute("data-height")),
        renderHTML: (attributes: Record<string, any>) => ({
          "data-height": String(attributes.height),
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="chart"]',
        priority: 60,
        // A missing or broken spec falls through, so the fallback content inside (e.g. a
        // DOCX import's caption and data table) is kept instead.
        getAttrs: (element) => (readSpec((element as HTMLElement).getAttribute("data-chart")) ? null : false),
      },
      {
        // ```mermaid blocks (from markdown) that hold a chart; other diagrams stay code.
        tag: "pre",
        priority: 60,
        getAttrs: (element) => {
          const code = (element as HTMLElement).querySelector("code");
          const language = code?.getAttribute("class") ?? (element as HTMLElement).getAttribute("data-language") ?? "";
          if (!/(?:^|\s)language-mermaid(?:\s|$)/.test(language) && language !== "mermaid") return false;
          const result = chartFromMermaid((code ?? element).textContent ?? "");
          return result.family ? { spec: result.spec } : false;
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const svg = staticChartSvg(node, this.options);
    return [
      "div",
      safeMergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        "data-type": "chart",
        class: "pixerate-chart",
      }),
      svg as any,
    ];
  },

  renderText({ node }) {
    return `[Chart: ${node.attrs.spec?.title || "untitled"}]`;
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: ProsemirrorNode) {
          const text = chartToMermaid(node.attrs.spec);
          const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
          state.write(`${fence}mermaid\n`);
          state.text(text, false);
          state.ensureNewLine();
          state.write(fence);
          state.closeBlock(node);
        },
        parse: {
          // markdown-it renders ```mermaid as <pre><code class="language-mermaid">, which
          // `parseHTML` reads.
        },
      },
    };
  },

  addCommands() {
    return {
      insertChart:
        (options) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              id: options.id ?? this.options.generateId(),
              spec: normalizeChartSpec(options.spec ?? {}).spec,
              width: options.width ?? null,
              height: options.height ?? this.options.defaultHeight,
            },
          }),
      updateChart:
        (id, changes) =>
        ({ state, tr, dispatch }) => {
          const chart = getDocumentCharts(state.doc, this.name).find((c) => c.id === id);
          if (!chart) return false;
          if (dispatch) {
            tr.setNodeMarkup(chart.pos, undefined, {
              ...chart.node.attrs,
              ...(changes.spec !== undefined ? { spec: normalizeChartSpec(changes.spec).spec } : {}),
              ...(changes.width !== undefined ? { width: changes.width } : {}),
              ...(changes.height !== undefined ? { height: changes.height } : {}),
            });
          }
          return true;
        },
    };
  },

  addNodeView() {
    return createChartNodeView(this.options.nodeView, (node) => staticChartSvg(node, this.options));
  },

  addProseMirrorPlugins() {
    const { name } = this;
    const { generateId } = this.options;
    return [
      new Plugin({
        key: chartPluginKey,
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          if (!transactionsInsert(transactions, [name])) return null;
          return syncChartIds(newState, name, generateId);
        },
      }),
    ];
  },

  onBeforeCreate() {
    const { generateId } = this.options;
    syncInitialContent(this.editor, (state) => syncChartIds(state, this.name, generateId));
  },
});
