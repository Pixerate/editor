import { Node } from "@tiptap/core";
import { DOMSerializer, type DOMOutputSpec, type Node as ProsemirrorNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import { safeMergeAttributes } from "./safe-merge-attributes";

/** What a framework loading indicator draws. A new object is passed on every change. */
export interface LoadingNodeViewState {
  /** The placeholder's `id` attribute (set by the host to find it again), or null. */
  id: string | null;
  /** The accessible label announced for the placeholder (the `label` option). */
  label: string;
}

/** A mounted framework component. */
export interface LoadingNodeViewRenderer {
  update(state: LoadingNodeViewState): void;
  destroy(): void;
}

/** Mounts a framework component into a loading placeholder's element. */
export type LoadingNodeViewMount = (dom: HTMLElement, state: LoadingNodeViewState) => LoadingNodeViewRenderer;

export interface LoadingNodeOptions {
  /** Accessible label of the placeholder, set as its `aria-label` (default `"Loading…"`). */
  label: string;
  /** Extra attributes for the placeholder's `<span>` (merged over the defaults). */
  HTMLAttributes: Record<string, unknown>;
  /**
   * The indicator inside the placeholder as a ProseMirror `DOMOutputSpec`, used in the editor
   * and in `getHTML()` (default: `loadingSpinnerSpec()`, an SVG spinner in `currentColor`).
   * Prefix SVG tags with the namespace: `["http://www.w3.org/2000/svg svg", …]`.
   */
  renderIndicator: (() => DOMOutputSpec) | null;
  /**
   * Draws a framework component inside the placeholder in the editor instead of
   * `renderIndicator` (React and Svelte export one). `getHTML()` still uses `renderIndicator`.
   */
  nodeView: LoadingNodeViewMount | null;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The default loading indicator: a 1em SVG spinner drawn in `currentColor`, so text colour
 * utilities tint it. It animates with SMIL, so it needs no stylesheet, and is hidden from
 * screen readers (the placeholder carries the label).
 */
export function loadingSpinnerSpec(): DOMOutputSpec {
  return [
    `${SVG_NS} svg`,
    {
      width: "1em",
      height: "1em",
      viewBox: "0 0 24 24",
      fill: "none",
      "aria-hidden": "true",
      focusable: "false",
      "data-loading-indicator": "",
    },
    ["circle", { cx: "12", cy: "12", r: "9", stroke: "currentColor", "stroke-width": "3", opacity: "0.25" }],
    [
      "path",
      { d: "M21 12a9 9 0 0 0-9-9", stroke: "currentColor", "stroke-width": "3", "stroke-linecap": "round" },
      [
        "animateTransform",
        {
          attributeName: "transform",
          type: "rotate",
          from: "0 12 12",
          to: "360 12 12",
          dur: "0.8s",
          repeatCount: "indefinite",
        },
      ],
    ],
  ];
}

const viewState = (node: ProsemirrorNode, options: LoadingNodeOptions): LoadingNodeViewState => ({
  id: (node.attrs.id as string | null) ?? null,
  label: options.label,
});

const placeholderAttributes = (options: LoadingNodeOptions, HTMLAttributes: Record<string, unknown>) =>
  safeMergeAttributes(
    {
      "data-type": "loading",
      role: "status",
      "aria-label": options.label,
      class: "inline-flex items-center px-1.5 py-0.5 text-xs text-muted-foreground",
    },
    options.HTMLAttributes,
    HTMLAttributes,
  );

/**
 * An inline placeholder for content that is still being generated. Insert it with
 * `insertContent({ type: "loadingNode", attrs: { id } })` and replace it by `id` when the
 * result arrives. It renders as `<span data-type="loading" role="status" aria-label="Loading…">`
 * around an SVG spinner; change the indicator with `renderIndicator` or `nodeView`.
 */
export const LoadingNode = Node.create<LoadingNodeOptions>({
  name: "loadingNode",
  group: "inline",
  inline: true,
  selectable: true,
  atom: true,

  addOptions() {
    return {
      label: "Loading…",
      HTMLAttributes: {},
      renderIndicator: null,
      nodeView: null,
    };
  },

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-id"),
        renderHTML: (attributes) => {
          if (!attributes.id) return {};
          return { "data-id": attributes.id };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="loading"]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      placeholderAttributes(this.options, HTMLAttributes),
      (this.options.renderIndicator ?? loadingSpinnerSpec)(),
    ];
  },

  addNodeView() {
    const options = this.options;
    return ({ node, HTMLAttributes }): NodeView => {
      const mount = options.nodeView;
      const { dom } = DOMSerializer.renderSpec(document, [
        "span",
        placeholderAttributes(options, HTMLAttributes),
        ...(mount ? [] : [(options.renderIndicator ?? loadingSpinnerSpec)()]),
      ]);
      const element = dom as HTMLElement;
      const renderer = mount?.(element, viewState(node, options)) ?? null;
      return {
        dom: element,
        update: (next) => {
          if (next.type !== node.type) return false;
          // Only `id` can change; it is not drawn, so the indicator stays as it is.
          if (next.attrs.id) element.setAttribute("data-id", String(next.attrs.id));
          else element.removeAttribute("data-id");
          renderer?.update(viewState(next, options));
          return true;
        },
        ignoreMutation: () => true,
        destroy: () => renderer?.destroy(),
      };
    };
  },
});
