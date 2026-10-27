import React, { useEffect, useId, useRef } from "react";
import {
  FONT_CATEGORIES,
  FONT_CATEGORY_LABELS,
  type FontCategory,
  type FontPickerModel,
  type FontProvider,
  type FontSpec,
  type FontStyle,
  type FontSummary,
} from "@pixerate/editor/typography";
import { useFontPicker } from "./useFontPicker";

export interface FontPickerProps {
  /** The selected font (controlled). */
  value?: Partial<FontSpec>;
  /** Called when the user (or an agent through the model's tools) picks a different font, weight or style. */
  onChange?: (value: FontSpec) => void;
  /** An existing model; when given, `provider`, `fonts` and `previewText` are ignored. */
  model?: FontPickerModel;
  /** Where fonts come from (fetched on mount). */
  provider?: FontProvider;
  /** A fixed list of fonts. */
  fonts?: readonly FontSummary[];
  /** Text for the live preview. */
  previewText?: string;
  /** Show the live preview (default true). */
  showPreview?: boolean;
  /** Show the category filter (default true). */
  showCategories?: boolean;
  /** Show the weight and style selects (default true). */
  showWeight?: boolean;
  /** Most options rendered at once (default 200); search to reach the rest. */
  maxResults?: number;
  disabled?: boolean;
  className?: string;
  id?: string;
  /** Accessible label for the group (default "Font picker"). */
  "aria-label"?: string;
}


const FIELD: React.CSSProperties = {
  boxSizing: "border-box",
  width: "100%",
  padding: "5px 8px",
  borderRadius: "6px",
  border: "1px solid var(--pixerate-font-picker-border, #3a4152)",
  background: "var(--pixerate-font-picker-field-bg, #151922)",
  color: "inherit",
  font: "inherit",
};

/** Body of the picker, driven by a model (shared with {@link TypographyControl}). */
export function FontPickerView({
  model,
  showPreview = true,
  showCategories = true,
  showWeight = true,
  maxResults = 200,
  disabled = false,
  className,
  id,
  "aria-label": ariaLabel = "Font picker",
  children,
}: {
  model: FontPickerModel;
  showPreview?: boolean;
  showCategories?: boolean;
  showWeight?: boolean;
  maxResults?: number;
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
  children?: React.ReactNode;
}) {
  const { state } = useFontPicker({ model });
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;
  const listRef = useRef<HTMLUListElement>(null);
  const shown = state.results.slice(0, maxResults);
  const css = model.css;

  // Keep the highlighted option visible while navigating with the keyboard.
  useEffect(() => {
    if (state.highlighted < 0) return;
    const el = listRef.current?.ownerDocument.getElementById(optionId(state.highlighted));
    el?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.highlighted]);

  const status = state.loading
    ? "Loading fonts…"
    : state.error
      ? `Could not load fonts: ${state.error}`
      : state.loadStatus[state.value.family.toLowerCase()] === "failed"
        ? `${state.value.family} could not be loaded; a fallback is shown.`
        : "";

  return (
    <div
      id={id}
      role="group"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={className}
      style={{
        boxSizing: "border-box",
        width: "var(--pixerate-font-picker-width, 280px)",
        borderRadius: "var(--pixerate-font-picker-radius, 8px)",
        background: "var(--pixerate-font-picker-bg, #1f2430)",
        color: "var(--pixerate-font-picker-fg, #f0f2f5)",
        padding: "12px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        fontSize: "12px",
        opacity: disabled ? 0.6 : 1,
        pointerEvents: disabled ? "none" : "auto",
      }}
    >
      <div style={{ display: "flex", gap: "6px" }}>
        <input
          type="text"
          role="combobox"
          aria-label="Search fonts"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={state.highlighted >= 0 && state.highlighted < shown.length ? optionId(state.highlighted) : undefined}
          placeholder="Search fonts"
          value={state.query}
          disabled={disabled}
          onChange={(e) => model.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (model.handleKey(e.key)) e.preventDefault();
          }}
          style={FIELD}
        />
        {showCategories && (
          <select
            aria-label="Font category"
            value={state.category}
            disabled={disabled}
            onChange={(e) => model.setCategory(e.target.value as FontCategory | "all")}
            style={{ ...FIELD, width: "auto" }}
          >
            {(["all", ...FONT_CATEGORIES] as const).map((c) => (
              <option key={c} value={c}>
                {FONT_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        )}
      </div>

      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Fonts"
        style={{
          listStyle: "none",
          margin: 0,
          padding: "2px",
          maxHeight: "var(--pixerate-font-picker-list-height, 180px)",
          overflowY: "auto",
          borderRadius: "6px",
          border: "1px solid var(--pixerate-font-picker-border, #3a4152)",
        }}
      >
        {shown.length === 0 && (
          <li role="presentation" style={{ padding: "6px 8px", opacity: 0.7 }}>
            {state.loading ? "Loading…" : "No fonts match"}
          </li>
        )}
        {shown.map((font, i) => {
          const selected = font.family.toLowerCase() === state.value.family.toLowerCase();
          const highlighted = i === state.highlighted;
          return (
            <li
              key={font.family}
              id={optionId(i)}
              role="option"
              aria-selected={selected}
              data-highlighted={highlighted || undefined}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => model.setHighlight(i)}
              onClick={() => model.selectFamily(font.family)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                gap: "8px",
                padding: "5px 8px",
                borderRadius: "4px",
                cursor: "pointer",
                background: selected
                  ? "var(--pixerate-font-picker-selected, #2f3b57)"
                  : highlighted
                    ? "var(--pixerate-font-picker-hover, #2a3040)"
                    : "transparent",
              }}
            >
              <span style={{ fontFamily: model.familyCss(font), fontSize: "14px" }}>{font.family}</span>
              <span style={{ opacity: 0.6, fontSize: "10px" }}>{FONT_CATEGORY_LABELS[font.category]}</span>
            </li>
          );
        })}
      </ul>

      {showWeight && (
        <div style={{ display: "flex", gap: "6px" }}>
          <select
            aria-label="Font weight"
            value={state.value.weight}
            disabled={disabled}
            onChange={(e) => model.setWeight(Number(e.target.value))}
            style={FIELD}
          >
            {model.availableWeights.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
          <select
            aria-label="Font style"
            value={state.value.style}
            disabled={disabled}
            onChange={(e) => model.setStyle(e.target.value as FontStyle)}
            style={FIELD}
          >
            {model.availableStyles.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      )}

      {children}

      {showPreview && (
        <div
          aria-label="Font preview"
          style={{
            fontFamily: css.fontFamily,
            fontWeight: css.fontWeight as React.CSSProperties["fontWeight"],
            fontStyle: css.fontStyle,
            fontSize: `${Math.min(state.value.size, 48)}px`,
            lineHeight: css.lineHeight,
            letterSpacing: css.letterSpacing,
            padding: "6px 4px",
            overflowWrap: "anywhere",
          }}
        >
          {state.previewText}
        </div>
      )}

      <div role="status" aria-live="polite" style={{ minHeight: status ? undefined : 0, opacity: 0.75 }}>
        {status}
      </div>
    </div>
  );
}

/**
 * Searchable font picker: a combobox over a listbox of families rendered in their own face, a
 * category filter, weight and style selects, and a live preview. Arrow keys, Home, End, Enter and
 * Escape work in the search field.
 */
export function FontPicker({ value, onChange, model, provider, fonts, previewText, ...view }: FontPickerProps) {
  const picker = useFontPicker({ model, provider, fonts, previewText, value, onChange });
  return <FontPickerView model={picker.model} {...view} />;
}
