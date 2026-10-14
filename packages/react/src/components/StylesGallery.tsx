import React, { useState } from "react";
import type { Editor } from "@tiptap/core";
import { useParagraphStyles } from "../hooks/useParagraphStyles";

export interface StylesGalleryProps {
  editor: Editor | null;
  /**
   * `dropdown` (default): a button showing the current style that opens the
   * list. `gallery`: the styles are always shown, in a row.
   */
  variant?: "dropdown" | "gallery";
  /** List every available paragraph style instead of the gallery (quick) styles. */
  showAllStyles?: boolean;
  /** Show the "Update to match selection" and "New style from selection" actions. Defaults to `true`. */
  showActions?: boolean;
  /** Preview each style's font, weight, style and color in its entry. Defaults to `true`. */
  preview?: boolean;
  className?: string;
  itemClassName?: string;
  activeItemClassName?: string;
  /** Called after a style is applied, updated or created. */
  onChange?: (event: { type: "apply" | "update" | "create"; id: string }) => void;
}

const camel = (property: string) => property.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

const keepSelection = (event: React.MouseEvent) => event.preventDefault();

/**
 * Paragraph styles picker (Word's Styles gallery): shows the style at the
 * selection, applies a style on click, updates the current style to match
 * the selection and creates a new style from the selection. Needs the
 * `ParagraphStyles` extension (`richTextOptions: { paragraphStyles: true }`).
 */
export const StylesGallery: React.FC<StylesGalleryProps> = ({
  editor,
  variant = "dropdown",
  showAllStyles = false,
  showActions = true,
  preview = true,
  className = "relative inline-flex flex-wrap items-center gap-1 text-sm",
  itemClassName = "rounded px-2 py-1 text-left text-xs text-foreground hover:bg-muted",
  activeItemClassName = "bg-primary/10 text-primary",
  onChange,
}) => {
  const styles = useParagraphStyles(editor);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const list = showAllStyles ? styles.styles : styles.gallery;
  const current = styles.currentStyle;
  const expanded = variant === "gallery" || open;
  const close = () => {
    if (variant === "dropdown") setOpen(false);
    setCreating(false);
    setName("");
  };

  const previewStyle = (id: string): React.CSSProperties | undefined => {
    if (!preview || !styles.registry) return undefined;
    return Object.fromEntries(
      Object.entries(styles.registry.previewDeclarations(id)).map(([k, v]) => [camel(k), v]),
    ) as React.CSSProperties;
  };

  const apply = (id: string) => {
    if (styles.apply(id)) onChange?.({ type: "apply", id });
    close();
  };

  const create = (event: React.FormEvent) => {
    event.preventDefault();
    const id = name.trim() ? styles.createFromSelection(name) : null;
    if (id) onChange?.({ type: "create", id });
    close();
  };

  return (
    <div className={className} role="group" aria-label="Paragraph styles" data-styles-gallery={variant}>
      {variant === "dropdown" && (
        <button
          type="button"
          className={itemClassName}
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={!editor || !styles.registry}
          onMouseDown={keepSelection}
          onClick={() => setOpen((value) => !value)}
        >
          {current?.name ?? "Styles"} ▾
        </button>
      )}
      {expanded && (
        <div
          className={
            variant === "dropdown"
              ? "absolute left-0 top-full z-20 mt-1 flex min-w-[12rem] flex-col gap-0.5 rounded-md border border-border bg-background p-1 shadow-md"
              : "flex flex-wrap items-center gap-1"
          }
        >
          <div role="listbox" aria-label="Styles" className={variant === "dropdown" ? "flex flex-col gap-0.5" : "flex flex-wrap gap-1"}>
            {list.map((style) => {
              const active = style.id === styles.currentStyleId;
              return (
                <button
                  key={style.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-style-id={style.id}
                  className={active ? `${itemClassName} ${activeItemClassName}` : itemClassName}
                  style={previewStyle(style.id)}
                  onMouseDown={keepSelection}
                  onClick={() => apply(style.id)}
                >
                  {style.name}
                </button>
              );
            })}
          </div>
          {showActions && (
            <div className={variant === "dropdown" ? "mt-1 flex flex-col gap-0.5 border-t border-border pt-1" : "flex items-center gap-1"}>
              <button
                type="button"
                className={itemClassName}
                disabled={!current}
                onMouseDown={keepSelection}
                onClick={() => {
                  if (current && styles.updateFromSelection(current.id)) {
                    onChange?.({ type: "update", id: current.id });
                  }
                  close();
                }}
              >
                {current ? `Update ${current.name} to match selection` : "Update to match selection"}
              </button>
              {creating ? (
                <form className="flex items-center gap-1" onSubmit={create}>
                  <input
                    aria-label="New style name"
                    className="w-32 rounded border border-border bg-background px-1 py-0.5 text-xs"
                    value={name}
                    autoFocus
                    onChange={(event) => setName(event.target.value)}
                  />
                  <button type="submit" className={itemClassName} disabled={!name.trim()}>
                    Create
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  className={itemClassName}
                  disabled={!editor || !styles.registry}
                  onMouseDown={keepSelection}
                  onClick={() => setCreating(true)}
                >
                  New style from selection
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
