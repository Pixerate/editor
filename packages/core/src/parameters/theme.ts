/**
 * Theme tokens for the parameter controls in `@pixerate/editor-react` and `@pixerate/editor-svelte`.
 * Each `--pixerate-parameter-*` property falls back to the common host tokens (`--background`,
 * `--foreground`, `--input`, `--border`, `--primary`) and then to the browser default. The values
 * are CSS declarations keyed by camelCase property, applied as inline styles by both bindings.
 *
 * Buttons set no background so their `hover:` classes keep working.
 */
export const parameterThemeStyles = {
  input: {
    backgroundColor: 'var(--pixerate-parameter-input-bg, var(--background, transparent))',
    color: 'var(--pixerate-parameter-input-fg, var(--foreground, currentColor))',
    borderColor: 'var(--pixerate-parameter-border, var(--input, var(--border, currentColor)))',
  },
  select: {
    backgroundColor: 'var(--pixerate-parameter-select-bg, var(--pixerate-parameter-input-bg, var(--background, transparent)))',
    color: 'var(--pixerate-parameter-select-fg, var(--pixerate-parameter-input-fg, var(--foreground, currentColor)))',
    borderColor: 'var(--pixerate-parameter-border, var(--input, var(--border, currentColor)))',
  },
  button: {
    color: 'var(--pixerate-parameter-button-fg, var(--foreground, currentColor))',
    borderColor: 'var(--pixerate-parameter-border, var(--input, var(--border, currentColor)))',
  },
  range: {
    accentColor: 'var(--pixerate-parameter-accent, var(--primary, currentColor))',
  },
} as const satisfies Record<string, Record<string, string>>;

export type ParameterThemePart = keyof typeof parameterThemeStyles;

/** One part's declarations as an inline `style` string (`background-color: …; color: …`). */
export function parameterThemeStyleText(part: ParameterThemePart): string {
  return Object.entries(parameterThemeStyles[part])
    .map(([key, value]) => `${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${value};`)
    .join(' ');
}
