import type { Editor, NodeViewRendererProps } from "@tiptap/core";
import { DOMSerializer, type DOMOutputSpec, type Node as ProsemirrorNode } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import type { NodeView } from "@tiptap/pm/view";
import { ChartController } from "../../chart/controller";
import type { ChartSpec } from "../../chart/types";

/** What a framework chart node view draws. A new object is passed on every change. */
export interface ChartNodeViewState {
  /** The chart's id in the document. */
  id: string | null;
  /** Edits the chart: changes are written back to the document when no gesture is running. */
  controller: ChartController;
  /** Width in pixels, or null to fill the line. */
  width: number | null;
  /** Height in pixels. */
  height: number;
  /** The editor is editable (a read-only editor never opens the inspector). */
  editable: boolean;
  /** The node is selected. */
  selected: boolean;
  /** The inspector is open. */
  editing: boolean;
  /** Opens (selecting the node) or closes the inspector. Ignored while the editor is read-only. */
  setEditing: (editing: boolean) => void;
  /** Changes the chart's size (one undo step). */
  setSize: (size: { width?: number | null; height?: number }) => void;
}

/** A mounted framework component. */
export interface ChartNodeViewRenderer {
  update(state: ChartNodeViewState): void;
  destroy(): void;
}

/** Mounts a framework component into a chart node view's element. */
export type ChartNodeViewMount = (dom: HTMLElement, state: ChartNodeViewState) => ChartNodeViewRenderer;

const specKey = (spec: unknown) => JSON.stringify(spec);

/**
 * The ProseMirror side of a chart node view, shared by the React and Svelte packages: it
 * keeps a `ChartController` in step with the node (undo, collaboration and agent edits load
 * into it), writes the controller's edits back as document transactions once any gesture
 * has ended, and lets the inspector's inputs keep their events while it is open.
 */
export class ChartNodeView implements NodeView {
  readonly dom: HTMLElement;
  private node: ProsemirrorNode;
  private readonly editor: Editor;
  private readonly getPos: () => number | undefined;
  private readonly controller: ChartController;
  private readonly renderer: ChartNodeViewRenderer | null;
  private readonly unsubscribe: () => void;
  private editing = false;
  private selected = false;
  private editable: boolean;
  private key: string;

  constructor(
    props: Pick<NodeViewRendererProps, "editor" | "node" | "getPos">,
    mount: ChartNodeViewMount | null,
    private readonly renderStatic: (node: ProsemirrorNode) => DOMOutputSpec,
  ) {
    this.editor = props.editor;
    this.node = props.node;
    this.getPos = typeof props.getPos === "function" ? (props.getPos as () => number | undefined) : () => undefined;
    this.editable = this.editor.isEditable;
    this.dom = document.createElement("div");
    this.dom.className = "pixerate-chart-node";
    this.dom.setAttribute("data-type", "chart");
    this.dom.contentEditable = "false";
    this.syncAttributes();
    this.key = specKey(this.node.attrs.spec);
    this.controller = new ChartController({ spec: this.node.attrs.spec });
    this.unsubscribe = this.controller.subscribe((state) => {
      if (!state.gesture) this.writeBack();
    });
    this.editor.on("update", this.onEditorUpdate);
    this.renderer = mount ? mount(this.dom, this.viewState()) : null;
    if (!mount) this.drawStatic();
  }

  private viewState(): ChartNodeViewState {
    return {
      id: this.node.attrs.id ?? null,
      controller: this.controller,
      width: this.node.attrs.width ?? null,
      height: this.node.attrs.height,
      editable: this.editable,
      selected: this.selected,
      editing: this.editing,
      setEditing: this.setEditing,
      setSize: this.setSize,
    };
  }

  private render() {
    if (this.renderer) this.renderer.update(this.viewState());
    else this.drawStatic();
    this.dom.toggleAttribute("data-editing", this.editing);
  }

  private drawStatic() {
    const { dom } = DOMSerializer.renderSpec(document, this.renderStatic(this.node));
    this.dom.replaceChildren(dom);
  }

  private syncAttributes() {
    if (this.node.attrs.id) this.dom.setAttribute("data-chart-id", this.node.attrs.id);
    else this.dom.removeAttribute("data-chart-id");
  }

  private onEditorUpdate = () => {
    if (this.editor.isEditable === this.editable) return;
    this.editable = this.editor.isEditable;
    if (!this.editable) this.editing = false;
    this.render();
  };

  /** Writes the controller's spec into the node, if it changed. */
  private writeBack() {
    const spec = this.controller.toJSON();
    const key = specKey(spec);
    if (key === this.key) return;
    const pos = this.getPos();
    if (typeof pos !== "number" || this.editor.isDestroyed) return;
    this.key = key;
    this.editor.view.dispatch(this.editor.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, spec }));
  }

  setEditing = (editing: boolean) => {
    if (editing && !this.editor.isEditable) return;
    if (editing && !this.selected) {
      const pos = this.getPos();
      if (typeof pos === "number") {
        this.editor.view.dispatch(this.editor.state.tr.setSelection(NodeSelection.create(this.editor.state.doc, pos)));
      }
    }
    if (this.editing === editing) return;
    this.editing = editing;
    this.render();
  };

  setSize = (size: { width?: number | null; height?: number }) => {
    const pos = this.getPos();
    if (typeof pos !== "number" || !this.editor.isEditable) return;
    this.editor.view.dispatch(this.editor.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, ...size }));
  };

  update(node: ProsemirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.syncAttributes();
    const key = specKey(node.attrs.spec);
    if (key !== this.key) {
      this.key = key;
      // Undo, an agent tool or a collaborator changed the chart: show it as the new start.
      if (specKey(this.controller.toJSON()) !== key) this.controller.load(node.attrs.spec as ChartSpec, { clearHistory: true });
    }
    this.render();
    return true;
  }

  selectNode() {
    this.selected = true;
    this.dom.classList.add("ProseMirror-selectednode");
    this.render();
  }

  deselectNode() {
    this.selected = false;
    this.editing = false;
    this.dom.classList.remove("ProseMirror-selectednode");
    this.render();
  }

  /** The inspector's inputs, buttons and chart gestures keep their events while it is open. */
  stopEvent(event: Event): boolean {
    if (!this.editing) return false;
    return !(event.type === "dragstart" && event.target === this.dom);
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy() {
    this.editor.off("update", this.onEditorUpdate);
    this.unsubscribe();
    this.renderer?.destroy();
    this.controller.destroy();
  }
}

/**
 * A TipTap node view factory for the `chart` node. `mount` draws the framework component
 * (`null`: the static SVG, redrawn when the spec changes).
 */
export function createChartNodeView(
  mount: ChartNodeViewMount | null,
  renderStatic: (node: ProsemirrorNode) => DOMOutputSpec,
) {
  return (props: NodeViewRendererProps): NodeView => new ChartNodeView(props, mount, renderStatic);
}
