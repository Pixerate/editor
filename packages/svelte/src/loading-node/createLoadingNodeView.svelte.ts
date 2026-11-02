import { mount, unmount, type Component } from "svelte";
import type { LoadingNodeViewMount, LoadingNodeViewState } from "@pixerate/editor";

/**
 * The `nodeView` for the core `loadingNode`, mounting `component` inside each placeholder:
 * `LoadingNode.configure({ nodeView: createSvelteLoadingNodeView(MyLoader) })`. The component
 * receives `view` (`LoadingNodeViewState`). The placeholder keeps `role="status"` and its
 * `aria-label`, so the component can be decorative.
 */
export function createSvelteLoadingNodeView(component: Component<{ view: LoadingNodeViewState }>): LoadingNodeViewMount {
  return (dom, state) => {
    let current = $state.raw(state);
    const instance = mount(component, {
      target: dom,
      props: {
        get view() {
          return current;
        },
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
