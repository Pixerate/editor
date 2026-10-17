import { mount, unmount, type Component } from "svelte";
import type { ChartNodeViewMount, ChartNodeViewState } from "@pixerate/editor";
import type { ChartTheme } from "@pixerate/editor/chart";
import ChartNodeView from "./ChartNodeView.svelte";

export interface SvelteChartNodeViewOptions {
  /** Chart colours (default: the CSS-variable theme). */
  theme?: Partial<ChartTheme>;
  /** Show the data grid under the chart while editing (default `true`). */
  showDataGrid?: boolean;
  /** Draw something else for each chart (default `ChartNodeView`; it receives `view`). */
  component?: Component<{ view: ChartNodeViewState; theme?: Partial<ChartTheme>; showDataGrid?: boolean }>;
}

/**
 * The `nodeView` for the core `chart` node, mounting `ChartNodeView` into each chart:
 * `createRichTextPreset({ chart: { nodeView: createSvelteChartNodeView() } })`.
 */
export function createSvelteChartNodeView(options: SvelteChartNodeViewOptions = {}): ChartNodeViewMount {
  const { component = ChartNodeView, theme, showDataGrid } = options;
  return (dom, state) => {
    let current = $state.raw(state);
    const instance = mount(component, {
      target: dom,
      props: {
        get view() {
          return current;
        },
        theme,
        showDataGrid,
      },
    });
    return {
      update: (next) => {
        current = next;
      },
      destroy: () => void unmount(instance),
    };
  };
}
