import React from 'react';

/** An input that commits on blur or Enter, and resets when its value changes from outside. */
export function CommitInput({ value, onCommit, ...rest }: { value: string; onCommit: (raw: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue'>) {
  return (
    <input
      key={value}
      {...rest}
      defaultValue={value}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      onBlur={(e) => {
        if (e.currentTarget.value !== value) onCommit(e.currentTarget.value);
      }}
    />
  );
}
