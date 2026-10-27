import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FontPickerModel, type FontPickerOptions, type FontPickerState, type FontSpec } from "@pixerate/editor/typography";

export interface UseFontPickerOptions extends FontPickerOptions {
  /** Use an existing model (e.g. one an agent tool provider also drives) instead of creating one. */
  model?: FontPickerModel;
}

export interface UseFontPickerResult {
  model: FontPickerModel;
  state: FontPickerState;
}

/**
 * Creates (or adopts) a {@link FontPickerModel} and re-renders on its changes. `value` is kept in
 * sync when it changes; `onChange` always calls the latest callback, for changes made in the
 * picker or by its agent tools. With a `provider`, fonts are
 * fetched on mount. The model is not destroyed on unmount (StrictMode re-runs effects), so a model
 * passed in can outlive the component.
 */
export function useFontPicker(options: UseFontPickerOptions = {}): UseFontPickerResult {
  const onChangeRef = useRef(options.onChange);
  onChangeRef.current = options.onChange;
  const [model] = useState(() => options.model ?? new FontPickerModel({ ...options, onChange: undefined }));
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);

  useEffect(() => model.onValueChange((value: FontSpec) => onChangeRef.current?.(value)), [model]);

  const valueKey = options.value ? JSON.stringify(options.value) : "";
  useEffect(() => {
    if (options.value) model.setValue(options.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, valueKey]);

  useEffect(() => {
    if (!options.model && options.provider) void model.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  return { model, state };
}
