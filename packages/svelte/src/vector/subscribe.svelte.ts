import { untrack } from "svelte";
import type { VectorEditorController, VectorEditorState } from "@pixerate/editor/vector";

/** Reactive state of a (possibly replaced) controller prop, for use inside components. */
export function vectorStateOf(getController: () => VectorEditorController): { readonly current: VectorEditorState } {
  let view: VectorEditorState = $state.raw(untrack(() => getController().getState()));
  $effect(() => {
    const controller = getController();
    view = controller.getState();
    return untrack(() =>
      controller.subscribe((next) => {
        view = next;
      }),
    );
  });
  return {
    get current() {
      return view;
    },
  };
}
