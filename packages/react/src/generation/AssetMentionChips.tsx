import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  defaultAssetRoleOptions,
  describeAssetMentions,
  findTextMentions,
  getAssetRoleOptions,
  setMentionRoleInText,
  type AssetInfo,
  type AssetMentionChip,
  type AssetRoleOption,
  type ModelCapabilities,
} from '@pixerate/editor/generation';

export interface AssetMentionChipsProps {
  /** Prompt text containing `@asset` / `@asset:role` mentions. */
  content: string;
  /** Called with the text after a role is picked (`@fox` → `@fox:style_ref`). */
  onChange: (next: string) => void;
  /** Mentionable assets; mentions that match none (by id or label) are not shown. */
  assets: readonly AssetInfo[];
  /** The selected model: its roles are offered and mentions are checked against it. */
  capabilities?: ModelCapabilities;
  /** Role options (default: the model's roles, else the built-in roles). */
  roles?: readonly AssetRoleOption[];
  /** Custom chip content (default: the asset label). */
  renderAsset?: (chip: AssetMentionChip) => React.ReactNode;
  className?: string;
}

/**
 * The asset mentions of a prompt as chips with role badges. Clicking a chip
 * opens a role picker popover; picking a role rewrites the mention's `:role`
 * suffix in the text. Chips with problems for the model (unsupported role,
 * wrong media type, too many for the role) are flagged.
 */
export const AssetMentionChips: React.FC<AssetMentionChipsProps> = ({
  content,
  onChange,
  assets,
  capabilities,
  roles,
  renderAsset,
  className = '',
}) => {
  const [open, setOpen] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const chips = useMemo(
    () => describeAssetMentions(findTextMentions(content), assets, capabilities),
    [content, assets, capabilities],
  );
  const options = roles ?? (capabilities ? getAssetRoleOptions(capabilities) : defaultAssetRoleOptions());

  useEffect(() => {
    if (open === null) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(null);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  const pick = (chip: AssetMentionChip, role: string | null) => {
    setOpen(null);
    if (chip.start === undefined) return;
    onChange(setMentionRoleInText(content, chip.start, role));
  };

  if (chips.length === 0) return null;
  return (
    <div ref={rootRef} className={`flex flex-wrap gap-1.5 ${className}`} data-asset-mention-chips="">
      {chips.map((chip) => {
        const error = chip.issues.find((issue) => issue.severity === 'error');
        const warning = chip.issues.find((issue) => issue.severity === 'warning');
        const problem = error ?? warning;
        const isOpen = open === chip.index;
        return (
          <span key={`${chip.start}-${chip.index}`} className="relative inline-flex" data-asset-chip={chip.asset.id}>
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={isOpen}
              title={problem?.message}
              data-issue={problem?.code}
              onClick={() => setOpen(isOpen ? null : chip.index)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setOpen(null);
              }}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
                error ? 'border-red-500/60' : warning ? 'border-amber-500/60' : 'border-border'
              } bg-muted/40 hover:bg-muted`}
            >
              <span>{renderAsset ? renderAsset(chip) : `@${chip.asset.label ?? chip.handle}`}</span>
              <span
                className={`rounded px-1 text-[10px] uppercase tracking-wide ${chip.role ? 'bg-primary/15' : 'opacity-60'}`}
                data-role-badge={chip.role ?? ''}
              >
                {chip.roleLabel ?? 'No role'}
              </span>
            </button>
            {isOpen && (
              <div
                role="listbox"
                aria-label={`Role for ${chip.asset.label ?? chip.handle}`}
                className="absolute left-0 top-full z-50 mt-1 flex min-w-[12rem] flex-col rounded-md border border-border bg-background p-1 text-xs shadow-lg"
                data-role-picker=""
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setOpen(null);
                }}
              >
                {options.map((option) => (
                  <button
                    key={option.role}
                    type="button"
                    role="option"
                    aria-selected={chip.role === option.role}
                    data-role-option={option.role}
                    title={option.description}
                    onClick={() => pick(chip, option.role)}
                    className="flex items-center justify-between gap-2 rounded px-2 py-1 text-left hover:bg-muted"
                  >
                    <span>{option.label}</span>
                    {option.accepts?.length ? (
                      <span className="text-[10px] opacity-60">{option.accepts.join(', ')}</span>
                    ) : null}
                  </button>
                ))}
                <button
                  type="button"
                  role="option"
                  aria-selected={!chip.role}
                  data-role-option=""
                  onClick={() => pick(chip, null)}
                  className="rounded px-2 py-1 text-left opacity-70 hover:bg-muted"
                >
                  No role
                </button>
                {chip.issues.length > 0 && (
                  <ul className="mt-1 border-t border-border px-2 pt-1 text-[10px]" data-chip-issues="">
                    {chip.issues.map((issue, i) => (
                      <li key={i} className={issue.severity === 'error' ? 'text-red-500' : 'text-amber-500'}>
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </span>
        );
      })}
    </div>
  );
};
