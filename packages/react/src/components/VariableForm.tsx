import React, { useId, useMemo, useState } from "react";
import {
  compactVariableValues,
  getVariableFormFields,
  PromptValues,
  Template,
  VariableFormField,
} from "@pixerate/editor";

export interface VariableFormProps {
  /** Prompt whose variables become form fields */
  content: string;
  /** Templates searched recursively for further variables */
  templates?: Template[];
  /** Template version bindings */
  bindings?: Record<string, string>;
  /** Entered text per variable (controlled). Omit to let the form keep its own state. */
  values?: Record<string, string>;
  /** Initial entered text when uncontrolled */
  defaultValues?: Record<string, string>;
  /**
   * Called on every edit with the values to resolve with (blank fields
   * dropped so defaults apply) and the raw entered text.
   */
  onChange?: (values: PromptValues, entered: Record<string, string>) => void;
  /** Custom class name for the wrapper */
  className?: string;
}

/**
 * Renders one input per prompt variable: labelled with its description,
 * using its default as the placeholder. Variables only used by `{?name}`
 * conditions render as checkboxes.
 */
export const VariableForm: React.FC<VariableFormProps> = ({
  content,
  templates,
  bindings,
  values,
  defaultValues,
  onChange,
  className = "flex flex-col gap-3 text-sm",
}) => {
  const idPrefix = useId();
  const [internal, setInternal] = useState<Record<string, string>>(
    () => defaultValues ?? {},
  );
  const entered = values ?? internal;

  const fields = useMemo<VariableFormField[]>(
    () => getVariableFormFields(content, { templates, bindings }),
    [content, templates, bindings],
  );

  const update = (name: string, value: string) => {
    const next = { ...entered, [name]: value };
    if (values === undefined) setInternal(next);
    onChange?.(compactVariableValues(next), next);
  };

  if (fields.length === 0) return null;

  return (
    <form className={className} onSubmit={(event) => event.preventDefault()}>
      {fields.map((field) => {
        const id = `${idPrefix}-${field.name}`;
        if (field.conditionOnly) {
          return (
            <label
              key={field.name}
              htmlFor={id}
              className="flex items-center gap-2"
              data-variable-field={field.name}
            >
              <input
                id={id}
                name={field.name}
                type="checkbox"
                checked={(entered[field.name] ?? "") !== ""}
                onChange={(event) =>
                  update(field.name, event.target.checked ? "true" : "")
                }
              />
              <span>{field.label}</span>
            </label>
          );
        }
        return (
          <label
            key={field.name}
            htmlFor={id}
            className="flex flex-col gap-1"
            data-variable-field={field.name}
          >
            <span className="font-medium">
              {field.label}
              {field.required && (
                <span className="text-rose-500" aria-hidden="true">
                  {" *"}
                </span>
              )}
            </span>
            <input
              id={id}
              name={field.name}
              type="text"
              value={entered[field.name] ?? ""}
              placeholder={field.placeholder}
              aria-required={field.required || undefined}
              onChange={(event) => update(field.name, event.target.value)}
              className="px-2 py-1 rounded-md border border-violet-400/40 bg-transparent"
            />
          </label>
        );
      })}
    </form>
  );
};
